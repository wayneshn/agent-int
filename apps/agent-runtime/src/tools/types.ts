import { resolve, sep } from 'path';
import type { ProxyClient } from '../proxy-client.js';

/**
 * Shared dependency bag passed to every tool factory.
 *
 * Extend this interface when a new tool needs additional dependencies
 * (e.g. a memory client, an embeddings service, etc.).  All existing
 * factories receive the full context object, so extending it is a
 * non-breaking change.
 */
export interface ToolContext {
	/** Client for all sandbox → host HTTP calls (credential proxy + LLM proxy). */
	proxyClient: ProxyClient;
	/** Absolute path to this agent's persistent workspace directory. */
	workspaceRoot: string;
	/**
	 * Maximum allowed body size in bytes for the call_api tool.
	 * Defaults to 1 MB (1_048_576 bytes).
	 */
	callApiMaxBodyBytes?: number;
	/**
	 * The agent's UUID. Used by workflow tools to construct frontend URLs
	 * that point to the agent's workflow and run pages.
	 */
	agentId?: string;
	/**
	 * Names of skills materialized under <workspaceRoot>/skills/.
	 * Used by read_file to detect skill activation for trace recording.
	 */
	skillNames?: string[];
	/**
	 * Called when read_file reads any path inside skills/<name>/ — reading a
	 * skill's SKILL.md (or a bundled file) counts as activating the skill.
	 */
	onSkillActivated?: (skillName: string) => void;
	/**
	 * Whether the browser tools (browser_navigate, browser_click, …) should be
	 * registered for this turn. Set from AgentRuntimeConfig.browserAvailable — true
	 * only when the agent has internet access and the project-wide browser feature
	 * is enabled. The backend independently enforces the same gate on every browser
	 * action (live DB check), so this flag is only a UX/registration convenience.
	 */
	browserAvailable?: boolean;
	/**
	 * Whether the render_ui tool (OpenUI generative UI) should be registered for
	 * this turn. Set from AgentRuntimeConfig.uiRenderingAvailable — true only for
	 * chat turns originating from the web channel. External channels and
	 * cron/webhook/workflow runs stay text-only.
	 */
	uiRenderingAvailable?: boolean;
	/**
	 * Whether the agent-to-agent tools (list_agents, send_to_agent, ask_agent) should
	 * be registered for this turn. Set from AgentRuntimeConfig.agentMessagingAvailable —
	 * true only when the agent has at least one collaborator in its allow-list. The
	 * backend independently enforces the allow-list + depth/cycle checks on every call.
	 */
	agentMessagingAvailable?: boolean;
}

/**
 * Resolve a user-supplied relative path against the workspace root.
 * Throws if the resolved path escapes the workspace (path traversal guard).
 *
 * Uses a separator-aware prefix check to prevent the classic bypass where
 * a path like /workspace/abc-evil would pass a naive startsWith('/workspace/abc').
 */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
	const resolved = resolve(workspaceRoot, relativePath);
	// Ensure the resolved path is exactly workspaceRoot or a strict child of it.
	// Adding sep prevents prefix confusion: "/workspace/abc" must not match "/workspace/abc-evil".
	const rootWithSep = workspaceRoot.endsWith(sep) ? workspaceRoot : workspaceRoot + sep;
	if (resolved !== workspaceRoot && !resolved.startsWith(rootWithSep)) {
		throw new Error(`Path traversal not allowed: ${relativePath}`);
	}
	return resolved;
}

/**
 * Fires ctx.onSkillActivated when a resolved (workspace-contained) path lies
 * inside one of the materialized skill folders. Same separator-aware
 * containment check as resolveWorkspacePath.
 */
export function detectSkillRead(ctx: ToolContext, resolvedPath: string): void {
	if (!ctx.onSkillActivated || !ctx.skillNames || ctx.skillNames.length === 0) return;

	for (const skillName of ctx.skillNames) {
		const skillDir = resolve(ctx.workspaceRoot, 'skills', skillName);
		const dirWithSep = skillDir.endsWith(sep) ? skillDir : skillDir + sep;
		if (resolvedPath === skillDir || resolvedPath.startsWith(dirWithSep)) {
			ctx.onSkillActivated(skillName);
			return;
		}
	}
}
