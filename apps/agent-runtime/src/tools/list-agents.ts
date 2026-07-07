import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { logger } from '@repo/utils';
import type { AgentCollaboratorSummary } from '@repo/types';
import type { ToolContext } from './types.js';

/**
 * list_agents — List the other agents this agent is allowed to message.
 *
 * Flow:
 *   1. Agent calls this tool (no parameters needed).
 *   2. The ProxyClient GETs /v1/runtime/internal/agents.
 *   3. The host returns this agent's collaborator allow-list (id, name, description).
 *
 * Use the returned agentId with send_to_agent (async hand-off) or ask_agent (wait for
 * an answer). Always call this first to get the correct agentId — never guess an ID.
 *
 * Security: the caller's agentId is derived from the PROXY_TOKEN on the host — this
 * tool only ever returns agents the current agent is explicitly permitted to message.
 */
export function createListAgentsTool(ctx: ToolContext): AgentTool {
	const tool: AgentTool = {
		name: 'list_agents',
		label: 'List Agents',
		description:
			'List the other agents you are allowed to message and delegate work to. ' +
			"Returns each collaborator agent's ID, name, and description. " +
			'Use this to discover who you can hand tasks to, then use ask_agent to get an ' +
			'answer back synchronously, or send_to_agent to hand off a task without waiting. ' +
			'Always call this first to get the correct agentId before messaging another agent.',
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params) => {
			logger.info('[agent-runner] list_agents — fetching collaborator list');

			const agents: AgentCollaboratorSummary[] = await ctx.proxyClient.listAgents();

			logger.info({ count: agents.length }, '[agent-runner] list_agents — received');

			if (agents.length === 0) {
				const textContent: TextContent = {
					type: 'text',
					text: 'You are not permitted to message any other agents.',
				};
				return { content: [textContent], details: {} };
			}

			const formatted = agents
				.map(
					(a, idx) =>
						`${idx + 1}. **${a.name}** (id: \`${a.id}\`)` +
						(a.description ? `\n   ${a.description}` : ''),
				)
				.join('\n\n');

			const textContent: TextContent = {
				type: 'text',
				text: `You can message ${agents.length} agent${agents.length === 1 ? '' : 's'}:\n\n${formatted}`,
			};
			return { content: [textContent], details: {} };
		},
	};

	return tool;
}
