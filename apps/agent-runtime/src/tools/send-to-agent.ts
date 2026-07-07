import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { logger } from '@repo/utils';
import type { ToolContext } from './types.js';

/**
 * send_to_agent — Hand a task to another agent WITHOUT waiting for a result.
 *
 * Flow:
 *   1. Agent calls this tool with a target agentId and a message.
 *   2. The ProxyClient POSTs to /v1/runtime/internal/agent/:agentId/message.
 *   3. The host verifies the target is in this agent's allow-list, spawns the target
 *      agent in a new thread, and returns immediately with the new threadId.
 *   4. The target agent processes the message independently — nothing streams back here.
 *
 * Use this for fire-and-forget hand-offs, notifications, and parallel fan-out (dispatch
 * to several agents at once). If you need the target's answer in THIS turn, use ask_agent.
 *
 * Security: the caller is derived from the PROXY_TOKEN; the allow-list, delegation
 * depth, and cycle checks are enforced by the host. The target runs with its OWN
 * credentials — you never receive them.
 */
export function createSendToAgentTool(ctx: ToolContext): AgentTool {
	const tool: AgentTool = {
		name: 'send_to_agent',
		label: 'Send to Agent',
		description:
			'Hand a task or message to another agent without waiting for a reply. ' +
			'Use this for fire-and-forget hand-offs, notifications, or dispatching the same ' +
			'task to several agents in parallel. The target agent works independently and its ' +
			'output does NOT appear in this chat turn — use ask_agent instead when you need the ' +
			'answer back. Follow-up messages you send to the same agent during this conversation ' +
			'continue in the SAME conversation on its side — it remembers your earlier exchange. ' +
			'Always call list_agents first to get the correct agentId — never guess. ' +
			'IMPORTANT: After this tool completes, your reply MUST include any markdown link ' +
			'returned in the tool result exactly as it appears.',
		parameters: Type.Object({
			agentId: Type.String({
				description: 'The ID of the agent to message (from list_agents).',
			}),
			message: Type.String({
				description:
					'The task or message to deliver. The target does not see your conversation ' +
					'history (only your previous messages to it), so make the ask itself clear.',
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

			logger.info({ targetAgentId: agentId }, '[agent-runner] send_to_agent — dispatching');

			const result = await ctx.proxyClient.sendToAgent(agentId, message, context);

			logger.info(
				{ targetAgentId: agentId, threadId: result.threadId },
				'[agent-runner] send_to_agent — dispatched',
			);

			// Absolute URL built host-side from APP_URL — works on external channels
			// (telegram/discord) too, where a root-relative path would be a dead link.
			const link = result.threadUrl
				? `\n\n[View the conversation](${result.threadUrl})`
				: '';
			const textContent: TextContent = {
				type: 'text',
				text: `Message delivered. The agent is now working on it.${link}`,
			};
			return { content: [textContent], details: {} };
		},
	};

	return tool;
}
