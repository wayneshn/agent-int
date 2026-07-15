import { logger } from '@repo/utils';
import { ProxyClient } from './proxy-client.js';
import { runAgent } from './agent-runner.js';
import { runWorkflow } from './workflow-runner.js';

/**
 * Agent runtime entrypoint.
 *
 * This process runs as a Node.js child process spawned by AgentRuntimeService.
 * It receives its context from environment variables injected at spawn time:
 *
 *   AGENT_ID       — ID of the agent to run
 *   THREAD_ID      — ID of the conversation thread
 *   PROXY_TOKEN    — Short-lived JWT for authenticating with the host backend
 *   PROXY_HOST     — URL of the host backend (e.g. http://localhost:4000)
 *   RUNTIME_CONFIG — JSON-encoded AgentRuntimeConfig (avoids a round-trip on startup)
 *   WORKSPACE_ROOT — Absolute path to this agent's persistent workspace directory
 *
 * Routing:
 *   - If config.workflow is present → runWorkflow() (multi-step pipeline mode)
 *   - Otherwise → runAgent() (interactive chat mode)
 *
 * Security guarantees:
 *   - No LLM API keys in this process. LLM calls go through PROXY_HOST.
 *   - No credential values in this process. API calls go through PROXY_HOST.
 *   - PROXY_TOKEN is scoped to this agent/thread and expires in 15 minutes.
 *   - File access is restricted to WORKSPACE_ROOT by resolveWorkspacePath().
 *
 * The process exits with code 0 on success, 1 on error.
 * AgentRuntimeService updates the thread status based on the exit code.
 */
async function main(): Promise<void> {
	const agentId = process.env.AGENT_ID;
	const threadId = process.env.THREAD_ID;
	const proxyToken = process.env.PROXY_TOKEN;
	const proxyHost = process.env.PROXY_HOST;
	const workspaceRoot = process.env.WORKSPACE_ROOT;

	if (!agentId || !threadId || !proxyToken || !proxyHost) {
		logger.error(
			'[agent-runtime] Missing required env vars: AGENT_ID, THREAD_ID, PROXY_TOKEN, PROXY_HOST',
		);
		process.exit(1);
	}

	logger.info({ agentId, threadId, proxyHost, workspaceRoot }, '[agent-runtime] starting');

	// Optional — when present, ProxyClient exchanges it for a fresh access token and
	// retries on a 401, so long/workflow runs survive the 15-minute access-token TTL.
	const proxyRefreshToken = process.env.PROXY_REFRESH_TOKEN;

	const proxyClient = new ProxyClient(proxyHost, proxyToken, threadId, proxyRefreshToken);

	try {
		const config = await proxyClient.loadConfig();

		logger.debug(
			{
				agentId,
				threadId,
				provider: config.modelProvider,
				model: config.modelId,
				triggerType: config.triggerType,
				hasWorkflow: !!config.workflow,
			},
			'[agent-runtime] config loaded',
		);

		if (config.workflow) {
			// Workflow mode — executes the multi-step pipeline defined in config.workflow
			logger.info(
				{ agentId, threadId, runId: config.workflow.runId },
				'[agent-runtime] routing to workflow runner',
			);
			await runWorkflow(config, proxyClient);
		} else {
			// Chat mode — interactive conversation loop
			await runAgent(config, proxyClient);
		}

		logger.info({ agentId, threadId }, '[agent-runtime] completed');
		process.exit(0);
	} catch (err) {
		logger.error({ err, agentId, threadId }, '[agent-runtime] fatal error');
		process.exit(1);
	}
}

main();
