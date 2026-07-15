import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { spawnSync } from 'child_process';
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '@repo/utils';
import { resolveWorkspacePath } from './types.js';
import type { ToolContext } from './types.js';

/** Hard execution timeout in milliseconds (same as run_terminal). */
const TIMEOUT_MS = 30_000;

/** Maximum captured output in bytes. */
const MAX_OUTPUT_BYTES = 65_536; // 64 KB

/**
 * Minimal safe environment for the code subprocess.
 * No app secrets, no network-sensitive variables.
 */
const SAFE_ENV: Record<string, string> = {
	PATH: '/usr/local/bin:/usr/bin:/bin',
	HOME: '/tmp',
	TERM: 'dumb',
	LANG: 'en_US.UTF-8',
};

/** Maps supported language identifiers to their runtime commands. */
const RUNTIMES: Record<string, { cmd: string; ext: string }> = {
	javascript: { cmd: 'node', ext: 'js' },
	python: { cmd: 'python3', ext: 'py' },
};

/**
 * run_code — Execute code in a sandboxed subprocess and return stdout.
 *
 * Security model (same constraints as run_terminal):
 *   - `shell: false` — no shell expansion or injection.
 *   - CWD is the agent's workspace root.
 *   - Minimal environment — no app secrets.
 *   - 30-second hard timeout (SIGTERM on expiry).
 *   - 64 KB output cap.
 *   - Code is written to a temp file inside WORKSPACE_ROOT/.tmp/ to avoid
 *     command-line quoting issues with complex multi-line snippets.
 *   - Temp file is always deleted after execution (success or failure).
 *
 * Known limitation: No network isolation. The subprocess can make outbound
 * network connections. For stronger isolation, run the agent runtime itself
 * inside a container or VM.
 *
 * Supported languages: javascript (Node.js), python (python3).
 */
export function createRunCodeTool(ctx: ToolContext): AgentTool {
	const tool: AgentTool = {
		name: 'run_code',
		label: 'Run Code',
		description:
			'Execute a code snippet in a sandboxed subprocess and return stdout + stderr. ' +
			'Both `code` and `language` are REQUIRED — always put the full source in `code` and select `language` in the SAME tool call. ' +
			'Never call this tool with only `language`: a call missing `code` is invalid and will fail validation. ' +
			'Use ONLY when execution is genuinely needed to produce a result you cannot derive from your own knowledge — ' +
			'e.g. parsing data, computing a hash, running a calculation, file manipulation. ' +
			'NEVER use this tool to echo or print information you already know. ' +
			'If you could delete this tool call and still give the same answer in text, skip the tool call and write the answer directly. ' +
			`Supported languages: ${Object.keys(RUNTIMES).join(', ')}. ` +
			`Execution is killed after ${TIMEOUT_MS / 1000} seconds.`,
		parameters: Type.Object({
			code: Type.String({
				description:
					'REQUIRED. The actual source code to execute — the real, complete program text, ' +
					'not a description or placeholder. Multi-line strings are supported. ' +
					'Do not invoke run_code without this field.',
			}),
			language: Type.Union(
				Object.keys(RUNTIMES).map((lang) => Type.Literal(lang)),
				{
					description: `Programming language: ${Object.keys(RUNTIMES).join(' | ')}`,
				},
			),
		}),
		execute: async (_toolCallId, params) => {
			const { language, code } = params as { language: string; code: string };

			const runtime = RUNTIMES[language];
			if (!runtime) {
				const textContent: TextContent = {
					type: 'text',
					text: `Error: unsupported language "${language}". Supported: ${Object.keys(RUNTIMES).join(', ')}`,
				};
				return { content: [textContent], details: {} };
			}

			// Write code to a temp file inside WORKSPACE_ROOT/.tmp/
			// resolveWorkspacePath guards against path traversal
			const tmpDir = resolveWorkspacePath(ctx.workspaceRoot, '.tmp');
			mkdirSync(tmpDir, { recursive: true });

			// Use a timestamp-based filename to avoid collisions in concurrent turns
			const tmpFile = join(tmpDir, `run_code_${Date.now()}.${runtime.ext}`);
			let tempFileWritten = false;

			try {
				writeFileSync(tmpFile, code, 'utf-8');
				tempFileWritten = true;

				logger.info(
					{ language, runtime: runtime.cmd, tmpFile, codeLength: code.length },
					'[agent-runner] run_code executing',
				);

				const result = spawnSync(runtime.cmd, [tmpFile], {
					cwd: ctx.workspaceRoot,
					env: SAFE_ENV,
					timeout: TIMEOUT_MS,
					maxBuffer: MAX_OUTPUT_BYTES,
					encoding: 'utf-8',
					shell: false,
					stdio: ['ignore', 'pipe', 'pipe'],
				});

				const timedOut = result.signal === 'SIGTERM' && result.status === null;
				const exitCode = result.status ?? (timedOut ? 124 : -1);

				logger.debug({ exitCode, timedOut, signal: result.signal }, '[agent-runner] run_code done');

				// Build structured response for the LLM to parse
				const parts: string[] = [];

				if (timedOut) {
					parts.push(`[TIMEOUT after ${TIMEOUT_MS / 1000}s — process was killed]`);
				}

				if (result.stdout) {
					const out = result.stdout.toString();
					if (out.length >= MAX_OUTPUT_BYTES) {
						parts.push(`[stdout truncated to ${MAX_OUTPUT_BYTES} bytes]`);
					}
					parts.push(`--- stdout ---\n${out}`);
				}

				if (result.stderr) {
					const err = result.stderr.toString();
					if (err) parts.push(`--- stderr ---\n${err}`);
				}

				parts.push(`--- exit code: ${exitCode} ---`);

				const textContent: TextContent = { type: 'text', text: parts.join('\n') };
				return { content: [textContent], details: { exitCode, timedOut } };
			} finally {
				// Always clean up the temp file
				if (tempFileWritten) {
					try {
						unlinkSync(tmpFile);
					} catch {
						// Non-fatal — temp dir will be cleaned with the workspace eventually
					}
				}
			}
		},
	};

	return tool;
}
