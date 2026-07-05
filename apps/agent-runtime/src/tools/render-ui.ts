import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { createParser } from '@openuidev/lang-core';
import { buildChatUiJsonSchema, buildRenderUiGuide } from '@repo/openui';
import { logger } from '@repo/utils';
import type { ToolContext } from './types.js';

/**
 * render_ui — Render an interactive UI (cards, tables, forms, buttons) in the
 * web chat.
 *
 * The tool itself only VALIDATES the OpenUI Lang code against the shared
 * component library (`@repo/openui`) so the agent can fix mistakes and retry.
 * Delivery needs no extra plumbing: the persisted toolCall content block
 * carries `code` to the web UI, which renders it with the svelte-lang
 * Renderer. Registered only when AgentRuntimeConfig.uiRenderingAvailable is
 * true (chat turns from the web channel) — external channels and workflow
 * runs never see this tool.
 */
export function createRenderUiTool(_ctx: ToolContext): AgentTool {
	const parser = createParser(buildChatUiJsonSchema());

	const tool: AgentTool = {
		name: 'render_ui',
		label: 'Render UI',
		description:
			'Render an interactive UI (cards, tables, charts, stat tiles, forms, buttons, ' +
			'follow-up chips) directly in the chat. Prefer this over plain text for structured ' +
			'data, numeric comparisons/trends, dashboards, option pickers, and input forms.\n\n' +
			buildRenderUiGuide(),
		parameters: Type.Object({
			code: Type.String({
				description:
					'OpenUI Lang source. One statement per line; the first statement must be ' +
					'`root = Stack([...])`.',
			}),
		}),
		execute: async (_toolCallId, params) => {
			const { code } = params as { code: string };
			const result = parser.parse(code);

			const problems: string[] = result.meta.errors.map(
				(e) => `- [${e.code}] ${e.component}${e.path ? ` ${e.path}` : ''}: ${e.message}`,
			);
			// After a complete (non-streaming) parse, unresolved references are
			// genuine mistakes — the identifier is used but never defined.
			for (const name of result.meta.unresolved) {
				problems.push(`- [unresolved-reference] "${name}" is referenced but never defined`);
			}
			if (!result.root) {
				problems.push('- [no-root] the first statement must be `root = Stack([...])`');
			}

			if (problems.length > 0) {
				logger.debug({ problems }, '[agent-runner] render_ui validation failed');
				const text: TextContent = {
					type: 'text',
					text:
						`The UI was NOT rendered — the code has ${problems.length} problem(s):\n` +
						`${problems.join('\n')}\n` +
						`Fix the code and call render_ui again.`,
				};
				return { content: [text], details: {}, isError: true };
			}

			const text: TextContent = {
				type: 'text',
				text:
					'The UI is now rendered in the chat. Do not repeat its content as text — ' +
					'add at most one short follow-up sentence if needed.',
			};
			return { content: [text], details: {} };
		},
	};

	return tool;
}
