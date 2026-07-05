import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createCallApiTool } from './call-api.js';
import { createReadFileTool } from './read-file.js';
import { createWriteFileTool } from './write-file.js';
import { createShareFileTool } from './share-file.js';
import { createListFilesTool } from './list-files.js';
import { createRunTerminalTool } from './run-terminal.js';
import { createAskHumanTool } from './ask-human.js';
import { createRunCodeTool } from './run-code.js';
import { createMemoryWriteTool } from './memory-write.js';
import { createMemorySearchTool } from './memory-search.js';
import { createMemoryDeleteTool } from './memory-delete.js';
import { createListWorkflowsTool } from './list-workflows.js';
import { createReadWorkflowTool } from './read-workflow.js';
import { createTriggerWorkflowTool } from './trigger-workflow.js';
import { createCreateWorkflowTool } from './create-workflow.js';
import { createChessEngineTool } from './chess-engine.js';
import { createBrowserTools } from './browser.js';
import { createRenderUiTool } from './render-ui.js';

export type { ToolContext } from './types.js';
export { resolveWorkspacePath } from './types.js';

/**
 * Build the full set of AgentTool instances for a single agent turn.
 *
 * To add a new tool:
 *   1. Create `src/tools/<your-tool>.ts` exporting `createYourTool(ctx)`
 *   2. Import and call it here
 *
 * All tools receive the same ToolContext — if a new tool needs extra
 * dependencies, add them to the ToolContext interface in `types.ts`.
 *
 * Memory tools (memory_write, memory_search) are always included.
 * They silently fail if the agent has no embedding model configured —
 * the host returns a 400 with a descriptive error that becomes a tool result.
 *
 * Workflow tools (list_workflows, read_workflow, trigger_workflow) are always
 * included. They return an appropriate message when no workflows are configured.
 *
 * Browser tools (browser_navigate, browser_click, …) are included ONLY when
 * ctx.browserAvailable is true — i.e. the agent has internet access and the
 * project-wide browser feature is enabled. This is the registration layer of the
 * gate; the backend independently re-checks on every browser action.
 *
 * The render_ui tool (OpenUI generative UI) is included ONLY when
 * ctx.uiRenderingAvailable is true — chat turns from the web channel. External
 * channels (telegram/discord) and workflow runs stay text-only by omission.
 */
export function createAgentTools(ctx: Parameters<typeof createCallApiTool>[0]): AgentTool[] {
	const tools = [
		createCallApiTool(ctx),
		createReadFileTool(ctx),
		createWriteFileTool(ctx),
		createShareFileTool(ctx),
		createListFilesTool(ctx),
		createRunTerminalTool(ctx),
		createAskHumanTool(ctx),
		createRunCodeTool(ctx),
		createMemoryWriteTool(ctx),
		createMemorySearchTool(ctx),
		createMemoryDeleteTool(ctx),
		createListWorkflowsTool(ctx),
		createReadWorkflowTool(ctx),
		createTriggerWorkflowTool(ctx),
		createCreateWorkflowTool(ctx),
		createChessEngineTool(ctx),
	];
	if (ctx.browserAvailable) {
		tools.push(...createBrowserTools(ctx));
	}
	if (ctx.uiRenderingAvailable) {
		tools.push(createRenderUiTool(ctx));
	}
	return tools;
}
