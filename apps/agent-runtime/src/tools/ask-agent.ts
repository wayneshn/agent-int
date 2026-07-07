import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { logger } from '@repo/utils';
import type { ToolContext } from './types.js';

/**
 * ask_agent — Delegate to another agent and WAIT for its answer.
 *
 * Flow:
 *   1. Agent calls this tool with a target agentId and a message.
 *   2. The ProxyClient POSTs to /v1/runtime/internal/agent/:agentId/ask (the host
 *      verifies the allow-list and spawns the target), then POLLS the ask-result
 *      endpoint until the target's run finishes.
 *   3. The poll resolves with the target's final text, returned as the tool result.
 *
 * This BLOCKS the current turn and costs a full agent run on the target — use it when
 * you genuinely need the answer to continue. For fire-and-forget hand-offs or parallel
 * fan-out, use send_to_agent instead.
 *
 * Security: the caller is derived from the PROXY_TOKEN; the allow-list, delegation
 * depth, and cycle checks are enforced by the host. The target runs with its OWN
 * credentials — you receive only its text answer, never its secrets.
 */
export function createAskAgentTool(ctx: ToolContext): AgentTool {
	const tool: AgentTool = {
		name: 'ask_agent',
		label: 'Ask Agent',
		description:
			'Delegate a task to another agent and wait for its answer, which is returned to ' +
			'you as the tool result. Use this when you need a specialist agent (with its own ' +
			'tools, credentials, or knowledge) to do part of the work and report back — for ' +
			'example asking a "Finance" agent to look something up. This BLOCKS until the other ' +
			'agent finishes and costs a full agent run, so prefer send_to_agent when you do not ' +
			'need the reply. Follow-up messages you send to the same agent during this ' +
			'conversation continue in the SAME conversation on its side — it remembers your ' +
			'earlier exchange, so do not repeat what it already knows. ' +
			'Always call list_agents first to get the correct agentId — never guess.',
		parameters: Type.Object({
			agentId: Type.String({
				description: 'The ID of the agent to ask (from list_agents).',
			}),
			message: Type.String({
				description:
					'The question or task for the target agent. The target does not see your ' +
					'conversation history (only your previous messages to it), so make the ask itself clear.',
			}),
			context: Type.Optional(
				Type.String({
					description:
						'Brief relevant background from your current task that the target needs to do ' +
						'its job well (1-3 sentences — only what is relevant, never your full history). ' +
						'Omit on follow-ups when the target already has the context.',
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const { agentId, message, context } = params as {
				agentId: string;
				message: string;
				context?: string;
			};

			logger.info({ targetAgentId: agentId }, '[agent-runner] ask_agent — delegating (blocking)');

			const result = await ctx.proxyClient.askAgent(agentId, message, context);

			logger.info(
				{ targetAgentId: agentId, threadId: result.threadId },
				'[agent-runner] ask_agent — received response',
			);

			const textContent: TextContent = {
				type: 'text',
				text: result.response,
			};
			return { content: [textContent], details: {} };
		},
	};

	return tool;
}
