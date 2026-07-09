import { rmSync } from 'fs';
import { resolve, join } from 'path';
import type {
	AgentTriggerType,
	AgentThreadStatus,
	AgentRuntimeConfig,
	Agent,
	ChannelType,
	CredentialMeta,
	LlmProviderConfig,
	MissionRuntimeInfo,
	SkillRuntimeEntry,
	Workflow,
	WorkflowTriggerContext,
} from '@repo/types';
import { getCredentialDefinition } from '@repo/utils';
import { AgentSessionService } from './AgentSessionService.js';
import { AgentProxyService } from './AgentProxyService.js';
import { AgentService } from './AgentService.js';
import { LlmProviderService } from './LlmProviderService.js';
import { CredentialService } from './CredentialService.js';
import { SkillMaterializerService } from './SkillMaterializerService.js';
import { KnowledgeBaseService } from './KnowledgeBaseService.js';
import { ChatFileService } from './ChatFileService.js';
import { WorkflowRunService } from './WorkflowRunService.js';
import { MissionService } from './MissionService.js';
import { BrowserService } from './BrowserService.js';
import { McpService } from './McpService.js';
import { agentStreamBus } from './AgentStreamBus.js';
import { logger } from '../config/logger.js';
import type { ExecutionDriver, RuntimeHandle } from './runtime/ExecutionDriver.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a clean, user-facing error message from child process output.
 *
 * The child uses pino logger which emits newline-delimited JSON to stdout.
 * Each line is a JSON object like:
 *   {"level":50,"msg":"[agent-runtime] fatal error","err":{"message":"..."}}
 *
 * Strategy (in order):
 *   1. Walk lines in reverse; parse as JSON and look for err.message in level≥40 entries.
 *   2. Fall back to regex matching "Error: <message>" on plain-text lines (stderr).
 *   3. Return the last non-empty line trimmed to 300 chars.
 *   4. Generic fallback if output is empty.
 */
function extractUserErrorMessage(output: string): string {
	if (!output.trim()) {
		return 'Agent process exited with an error. Please try again.';
	}

	const lines = output.split('\n').filter((l) => l.trim().length > 0);

	// Walk backwards so we get the most recent error first
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();

		// Try pino structured JSON first
		if (line.startsWith('{')) {
			try {
				const entry = JSON.parse(line) as {
					level?: number;
					msg?: string;
					err?: { message?: string };
				};
				// pino level 40=warn, 50=error — only surface errors/warns
				if (entry.level !== undefined && entry.level >= 40) {
					if (entry.err?.message) {
						return entry.err.message.slice(0, 300);
					}
					if (entry.msg && !entry.msg.startsWith('[')) {
						// Only use msg if it looks like a real error message, not a log prefix
						return entry.msg.slice(0, 300);
					}
				}
			} catch {
				// not valid JSON — fall through to regex
			}
		}

		// Plain-text "Error: <message>" lines (from stderr / uncaught exceptions)
		const match = line.match(/(?:^|:\s*)Error:\s*(.+)/i);
		if (match) {
			return match[1].slice(0, 300);
		}
	}

	// Last resort: return the last non-empty line
	const lastLine = lines[lines.length - 1].trim();
	return lastLine.slice(0, 300) || 'Agent process exited with an error. Please try again.';
}

// ─── Optional workflow config passed to spawnForThread ───────────────────────

/** Workflow config injected into the sandbox for workflow runs */
export interface WorkflowSpawnConfig {
	runId: string;
	definition: Workflow;
	triggerContext: WorkflowTriggerContext;
}

/**
 * Mission config injected into the sandbox for mission wakes (triggerType
 * 'mission'). Built by MissionSchedulerService via MissionService.buildRuntimeInfo.
 * For owner steering chats on a mission thread the runtime service derives the
 * equivalent config itself from the thread's missionId (missionChatMode).
 */
export interface MissionSpawnConfig {
	missionId: string;
	mission: MissionRuntimeInfo;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Manages agent execution by spawning one isolated execution unit per turn
 * through a pluggable ExecutionDriver:
 *
 *   - ProcessDriver — plain Node.js child process (bare-metal dev default).
 *     Code-level isolation only: sanitized env, no OS boundary.
 *   - DockerDriver  — hardened sibling Docker container (production default
 *     in docker-compose). OS-level isolation: namespaces, read-only rootfs,
 *     non-root user, resource limits, per-agent network egress policy.
 *
 * Driver-independent security model:
 *   - The runtime receives only: AGENT_ID, THREAD_ID, PROXY_TOKEN, PROXY_HOST,
 *     RUNTIME_CONFIG, WORKSPACE_ROOT.
 *   - DATABASE_URL, CREDENTIAL_ENCRYPTION_KEY, JWT_SECRET, and all other backend
 *     secrets are never passed to the runtime.
 *   - Credentials and LLM keys are never passed to the runtime — all sensitive
 *     operations are proxied through the PROXY_TOKEN-authenticated
 *     /v1/runtime/internal/* endpoints.
 *   - The PROXY_TOKEN is a 15-min scoped JWT authorising only the agent's
 *     credential list.
 *
 * Workflow execution:
 *   When workflowConfig is provided, the RUNTIME_CONFIG includes a `workflow` field
 *   containing the full workflow definition and trigger context. The runtime
 *   routes to workflow-runner.ts instead of agent-runner.ts.
 *
 * Lifecycle:
 *   - spawnForThread() is non-blocking: it spawns the runtime and returns.
 *   - The runtime exits with code 0 on success, 1 on error.
 *   - Thread status is updated to 'running' before spawn and to 'completed'/'error' on exit.
 *   - A hard timeout (AGENT_RUNTIME_TIMEOUT_MS, default 40 min) kills runaway runs.
 *   - A global concurrency cap (AGENT_RUNTIME_MAX_CONCURRENT, default 20) bounds
 *     simultaneous runs.
 */
export class AgentRuntimeService {
	/**
	 * Base directory for per-agent persistent workspaces, as seen by the backend.
	 * Each agent gets its own subdirectory: <workspacesBasePath>/<agentId>/
	 * Override with AGENT_WORKSPACES_PATH env var.
	 */
	private readonly workspacesBasePath: string;

	/** Hard wall-clock limit per run. Default 40 min — must exceed the 35-min HITL long-poll. */
	private readonly runTimeoutMs: number;

	/** Maximum simultaneous runs across all agents/owners */
	private readonly maxConcurrent: number;

	/**
	 * Max serialized runtime-config size (bytes) still passed inline via the
	 * RUNTIME_CONFIG env var. Larger configs (e.g. workflows, which embed the full
	 * definition) are served over HTTP from `/internal/config` instead, because the
	 * docker-socket-proxy rejects oversized createContainer requests (HTTP 431).
	 */
	private readonly maxEnvConfigBytes: number;

	/**
	 * Configs awaiting an HTTP fetch by a just-spawned runtime, keyed by threadId.
	 * Populated before spawn when the config exceeds maxEnvConfigBytes; consumed
	 * once by the runtime's loadConfig() call. One-shot + TTL-bounded so a runtime
	 * that never starts cannot leak. Assumes a single backend instance (see plan).
	 */
	private readonly pendingConfigs = new Map<
		string,
		{ config: AgentRuntimeConfig; expiresAt: number }
	>();

	/** How long a pending config stays fetchable before it is swept. */
	private readonly pendingConfigTtlMs = 5 * 60 * 1000;

	/**
	 * Live runtime handles keyed by threadId, for the concurrency cap, shutdown(),
	 * and cancelTurn() lookup. Only one run per thread is ever live — the
	 * MessagePipeline concurrency guard rejects a second turn while one is running
	 * on the chat path, and spawnForThread's own per-thread guard (liveRuns +
	 * spawningThreads) rejects duplicates on every other path (A2A, triggers).
	 */
	private readonly liveRuns = new Map<string, RuntimeHandle>();

	/**
	 * Threads with a spawn currently in flight but not yet in liveRuns. spawnForThread
	 * does substantial async work (agent fetch, model resolution, skill
	 * materialization) before the handle lands in liveRuns and the thread status
	 * flips to 'running', so DB-status checks alone cannot prevent two concurrent
	 * spawns for one thread. This set closes that window.
	 */
	private readonly spawningThreads = new Set<string>();

	/**
	 * Threads whose live run was cancelled by the user. Read+cleared in the run's
	 * onClose so a user-initiated stop resolves the thread to 'idle' (not 'error')
	 * and suppresses the error SSE toast.
	 */
	private readonly cancelledThreads = new Set<string>();

	/**
	 * Resolvers waiting for a thread's run to reach a terminal state, keyed by
	 * threadId. Powers awaitThreadCompletion() — the synchronous ask_agent path
	 * registers a resolver before spawning, and every terminal path of spawnForThread
	 * (concurrency cap, missing model, spawn failure, onClose) settles them. An array
	 * so multiple waiters on the same thread are all notified.
	 */
	private readonly completionWaiters = new Map<
		string,
		Array<(status: AgentThreadStatus) => void>
	>();

	constructor(
		private readonly driver: ExecutionDriver,
		private readonly sessionService: AgentSessionService,
		private readonly proxyService: AgentProxyService,
		private readonly agentService: AgentService,
		private readonly llmProviderService: LlmProviderService,
		private readonly credentialService: CredentialService,
		private readonly skillMaterializer: SkillMaterializerService,
		private readonly knowledgeBaseService: KnowledgeBaseService,
		private readonly workflowRunService: WorkflowRunService,
		private readonly browserService: BrowserService,
		private readonly chatFileService: ChatFileService,
		private readonly missionService: MissionService,
		private readonly mcpService: McpService,
	) {
		// Workspaces base: repo root sibling directory by default.
		// process.cwd() is apps/backend/ so we go up two levels to reach the monorepo root.
		this.workspacesBasePath =
			process.env.AGENT_WORKSPACES_PATH ?? resolve(process.cwd(), '../../.agent-workspaces');
		this.runTimeoutMs = parseInt(process.env.AGENT_RUNTIME_TIMEOUT_MS ?? '2400000', 10);
		this.maxConcurrent = parseInt(process.env.AGENT_RUNTIME_MAX_CONCURRENT ?? '20', 10);
		this.maxEnvConfigBytes = parseInt(process.env.AGENT_RUNTIME_MAX_ENV_CONFIG_BYTES ?? '8192', 10);
	}

	/**
	 * Resolve the backend-side workspace path for an agent. Used by the share_file
	 * endpoint to read a file the agent produced. Guards against path escape via a
	 * malformed agentId.
	 */
	getWorkspacePath(agentId: string): string {
		const workspacePath = join(this.workspacesBasePath, agentId);
		if (!workspacePath.startsWith(this.workspacesBasePath)) {
			throw new Error(`Invalid agentId — workspace path escapes base: ${agentId}`);
		}
		return workspacePath;
	}

	/** Validate driver configuration and reap orphaned runs. Call once at backend startup. */
	async init(): Promise<void> {
		// Pass the backend-side workspaces base path so the docker driver can verify
		// at boot that it resolves to the same physical storage as its workspace volume.
		await this.driver.init(this.workspacesBasePath);
	}

	/** Kill all live runs. Call on backend shutdown (SIGTERM/SIGINT). */
	async shutdown(): Promise<void> {
		logger.info({ liveRuns: this.liveRuns.size }, '[runtime] shutting down live agent runs');
		await this.driver.shutdown();
		this.liveRuns.clear();
	}

	/**
	 * Stop an in-flight (or stuck) turn for a thread and return it to 'idle'.
	 *
	 * Two cases:
	 *   - A live runtime handle exists → mark the thread cancelled, reset its
	 *     status, then kill the process/container. The handle's onClose finalizes
	 *     the status (kept 'idle' because it was cancelled) and emits 'done'.
	 *   - No live handle (the run already exited, or it was orphaned by a backend
	 *     crash before onClose could run, leaving the row stuck at 'running') →
	 *     reconcile directly: reset the status, flush any browser session, emit
	 *     'done' so SSE subscribers clean up.
	 *
	 * The status is set to 'idle' synchronously so the cancel response is
	 * authoritative even though a killed process's onClose lands asynchronously.
	 * Idempotent and safe to call regardless of the thread's current state.
	 * Ownership is verified by the route before this is called.
	 */
	async cancelTurn(threadId: string): Promise<void> {
		const handle = this.liveRuns.get(threadId);
		if (handle) this.cancelledThreads.add(threadId);
		try {
			await this.sessionService.updateThreadStatus(threadId, 'idle');
		} catch (err) {
			logger.error({ err, threadId }, '[runtime] failed to reset thread status on cancel');
		}
		if (handle) {
			logger.info({ threadId, runtimeId: handle.id }, '[runtime] cancelling live turn');
			await handle.kill();
		} else {
			logger.info({ threadId }, '[runtime] cancelling turn with no live handle — cleaning up');
			await this.browserService.saveOnTurnEnd(threadId);
			agentStreamBus.emit(threadId, { type: 'done' });
		}
	}

	/**
	 * Notify and clear any awaitThreadCompletion() waiters for a thread. Called from
	 * every terminal path of spawnForThread (the early declines and the onClose
	 * handler) so a synchronous ask_agent caller is always released — including when
	 * the run never actually started (concurrency cap, missing model, spawn failure).
	 * Public so AgentMessagingService can also release waiters when spawnForThread
	 * THROWS (paths outside its internal decline handling never settle waiters).
	 */
	settleWaiters(threadId: string, status: AgentThreadStatus): void {
		const waiters = this.completionWaiters.get(threadId);
		if (!waiters) return;
		this.completionWaiters.delete(threadId);
		for (const resolve of waiters) {
			try {
				resolve(status);
			} catch (err) {
				logger.error({ err, threadId }, '[runtime] completion waiter threw');
			}
		}
	}

	/**
	 * Await the terminal status of a thread's run (for synchronous agent-to-agent
	 * delegation — ask_agent). Registers a resolver synchronously (so it is in place
	 * before spawnForThread's onClose can fire), then resolves when the run settles or
	 * the timeout elapses. A timeout resolves to 'error' — the target run keeps going
	 * in its own thread, but the caller stops waiting.
	 *
	 * MUST be called BEFORE spawnForThread for the same thread so no completion is
	 * missed. The two are separate calls (rather than a flag on spawnForThread)
	 * because spawnForThread is shared by all trigger paths, most of which never wait.
	 */
	awaitThreadCompletion(threadId: string, timeoutMs: number): Promise<AgentThreadStatus> {
		return new Promise<AgentThreadStatus>((resolve) => {
			const timer = setTimeout(() => {
				// Remove just this resolver, then fire it once with a timeout status.
				const waiters = this.completionWaiters.get(threadId);
				if (waiters) {
					const remaining = waiters.filter((w) => w !== wrapped);
					if (remaining.length > 0) this.completionWaiters.set(threadId, remaining);
					else this.completionWaiters.delete(threadId);
				}
				logger.warn({ threadId, timeoutMs }, '[runtime] awaitThreadCompletion timed out');
				resolve('error');
			}, timeoutMs);
			timer.unref();

			const wrapped = (status: AgentThreadStatus) => {
				clearTimeout(timer);
				resolve(status);
			};

			const existing = this.completionWaiters.get(threadId) ?? [];
			existing.push(wrapped);
			this.completionWaiters.set(threadId, existing);
		});
	}

	/**
	 * One-shot retrieval of a runtime config that was too large to pass inline via
	 * the RUNTIME_CONFIG env var. Called by the `/internal/config` endpoint when a
	 * freshly-spawned runtime fetches its config. Returns null (and the caller logs)
	 * when the entry is absent or expired — the runtime then fails fast and the run
	 * is reconciled to error. Sweeps expired entries on every call.
	 */
	takePendingConfig(threadId: string): AgentRuntimeConfig | null {
		const now = Date.now();
		// Lazy TTL sweep — bounds memory if a runtime never started to fetch its config.
		for (const [key, entry] of this.pendingConfigs) {
			if (entry.expiresAt <= now) this.pendingConfigs.delete(key);
		}
		const pending = this.pendingConfigs.get(threadId);
		if (!pending || pending.expiresAt <= now) return null;
		this.pendingConfigs.delete(threadId);
		return pending.config;
	}

	/**
	 * Spawn one isolated runtime to execute one agent turn.
	 *
	 * Called when:
	 *   1. A user sends a chat message (triggerType = 'chat')
	 *   2. A cron trigger fires (triggerType = 'cron')
	 *   3. A webhook trigger fires (triggerType = 'webhook')
	 *   4. A manual trigger fires (triggerType = 'manual')
	 *
	 * When workflowConfig is provided, the runtime config includes the full workflow
	 * definition and trigger context. The runtime routes to workflow-runner.ts.
	 *
	 * The method is non-blocking — it spawns the runtime and returns immediately.
	 *
	 * Returns true when the runtime was started. Returns false when the run was
	 * declined or failed to start (concurrency cap, missing/unresolvable chat model,
	 * driver spawn failure) — in those cases the thread is already marked 'error',
	 * the SSE stream has been notified, and the specific reason is already logged
	 * here, so chat callers need no extra handling. A false return is never an
	 * exception: callers that own a workflow run (TriggerService, the agent-triggered
	 * /internal/workflow/:id/trigger endpoint) MUST still inspect it and mark their
	 * run 'error', or the run would sit at 'running' forever.
	 */
	async spawnForThread(
		agentId: string,
		threadId: string,
		ownerId: string,
		triggerType: AgentTriggerType = 'chat',
		triggerPayload?: Record<string, unknown>,
		userDatetime?: string,
		workflowConfig?: WorkflowSpawnConfig,
		channel?: ChannelType,
		missionConfig?: MissionSpawnConfig,
	): Promise<boolean> {
		// Per-thread duplicate guard — a run is already live or mid-spawn for this
		// thread. Decline WITHOUT touching thread state, emitting events, or settling
		// waiters: the in-flight run owns those, and settling here would wrongly
		// release its ask_agent waiters or mark a healthy run 'error'.
		if (this.liveRuns.has(threadId) || this.spawningThreads.has(threadId)) {
			logger.warn(
				{ agentId, threadId },
				'[runtime] a run is already live or spawning for this thread — rejecting duplicate spawn',
			);
			return false;
		}
		this.spawningThreads.add(threadId);
		try {
			return await this.spawnForThreadInner(
				agentId,
				threadId,
				ownerId,
				triggerType,
				triggerPayload,
				userDatetime,
				workflowConfig,
				channel,
				missionConfig,
			);
		} finally {
			// By now the run is either in liveRuns (success) or declined/failed —
			// either way the pre-liveRuns window this set covers is over.
			this.spawningThreads.delete(threadId);
		}
	}

	private async spawnForThreadInner(
		agentId: string,
		threadId: string,
		ownerId: string,
		triggerType: AgentTriggerType = 'chat',
		triggerPayload?: Record<string, unknown>,
		userDatetime?: string,
		workflowConfig?: WorkflowSpawnConfig,
		channel?: ChannelType,
		missionConfig?: MissionSpawnConfig,
	): Promise<boolean> {
		// Concurrency cap — reject before touching thread state or spawning.
		if (this.liveRuns.size >= this.maxConcurrent) {
			logger.warn(
				{ agentId, threadId, liveRuns: this.liveRuns.size, max: this.maxConcurrent },
				'[runtime] concurrency cap reached — rejecting spawn',
			);
			await this.sessionService.updateThreadStatus(threadId, 'error');
			agentStreamBus.emit(threadId, {
				type: 'error',
				message: 'Too many agent runs are in progress. Please try again shortly.',
			});
			agentStreamBus.emit(threadId, { type: 'done' });
			this.settleWaiters(threadId, 'error');
			return false;
		}

		// Fetch the agent once — reuse for both the proxy token and runtime config build.
		const agent = await this.agentService.getById(agentId, ownerId);
		if (!agent) {
			throw new Error(`Agent not found: ${agentId}`);
		}

		// Fail fast when the agent's chat model is missing or unresolvable — spawning
		// anyway would only surface an opaque error from inside the sandbox later.
		const modelConfig = agent.modelConfigId
			? await this.llmProviderService.getById(agent.modelConfigId, ownerId)
			: null;
		if (!modelConfig) {
			logger.error(
				{ agentId, threadId, modelConfigId: agent.modelConfigId ?? null },
				'[runtime] agent has no resolvable chat model config — rejecting spawn',
			);
			await this.sessionService.updateThreadStatus(threadId, 'error');
			agentStreamBus.emit(threadId, {
				type: 'error',
				message: 'This agent has no chat model configured. Please assign a model and try again.',
			});
			agentStreamBus.emit(threadId, { type: 'done' });
			this.settleWaiters(threadId, 'error');
			return false;
		}

		// Ensure the per-agent workspace exists (driver also fixes ownership for
		// the runtime user where needed). Prepared before the config build so the
		// skill materializer can write into it.
		const workspacePath = join(this.workspacesBasePath, agentId);
		if (!workspacePath.startsWith(this.workspacesBasePath)) {
			throw new Error(`Invalid agentId — workspace path escapes base: ${agentId}`);
		}
		this.driver.prepareWorkspace(workspacePath);

		// Materialize assigned skills into <workspace>/skills/ (rewritten fresh
		// every spawn) and get the compact index for the system prompt.
		const skills = await this.skillMaterializer.materializeForAgent(agentId, workspacePath);

		// Copy this thread's uploaded files into <workspace>/uploads/ so the agent
		// can read/parse the raw bytes with its file tools. Best-effort — a copy
		// failure is logged inside and never fails the turn. Chat threads only.
		if (triggerType === 'chat') {
			await this.chatFileService.materializeThreadFiles(threadId, ownerId, workspacePath);
		}

		// Owner steering: a chat turn on a mission thread runs with the mission
		// context + tools attached (missionChatMode) so the owner can redirect the
		// mission live. Mission wakes pass missionConfig explicitly (scheduler);
		// this derives the same config for chat turns from the thread's missionId.
		let effectiveMissionConfig = missionConfig;
		let missionChatMode = false;
		if (!effectiveMissionConfig && triggerType === 'chat') {
			try {
				const thread = await this.sessionService.getThreadByIdInternal(threadId);
				if (thread?.missionId) {
					const mission = await this.missionService.getByIdInternal(thread.missionId);
					if (mission && mission.agentId === agentId) {
						effectiveMissionConfig = {
							missionId: mission.id,
							mission: await this.missionService.buildRuntimeInfo(mission),
						};
						missionChatMode = true;
					}
				}
			} catch (err) {
				// Non-fatal — the turn proceeds as a plain chat turn without mission context.
				logger.warn({ err, threadId }, '[runtime] failed to load mission context for chat turn');
			}
		}

		// Build the runtime config (no secrets) for the runtime.
		const runtimeConfig = await this.buildRuntimeConfig(
			agent,
			modelConfig,
			threadId,
			ownerId,
			triggerType,
			skills,
			triggerPayload,
			userDatetime,
			workflowConfig,
			channel,
			effectiveMissionConfig,
			missionChatMode,
		);

		// Resolve the effective credential allowlist. When the agent is flagged with
		// allCredentials it may use any credential the owner has (current and future),
		// so seed the snapshot with all of them and mark the token accordingly.
		const effectiveCredentialIds = agent.allCredentials
			? (await this.credentialService.listByOwner(ownerId)).map((c) => c.id)
			: agent.credentialIds;

		// Issue a scoped PROXY_TOKEN for this runtime session
		const proxyToken = await this.proxyService.issueProxyToken({
			agentId,
			ownerId,
			threadId,
			credentialIds: effectiveCredentialIds,
			allCredentials: agent.allCredentials,
			missionId: effectiveMissionConfig?.missionId,
		});

		// Mark thread as running before spawning
		await this.sessionService.updateThreadStatus(threadId, 'running');

		// Sanitized environment — no backend secrets. PROXY_HOST and
		// WORKSPACE_ROOT are injected by the driver.
		const env: Record<string, string> = {
			NODE_ENV: process.env.NODE_ENV ?? 'development',
			AGENT_ID: agentId,
			THREAD_ID: threadId,
			PROXY_TOKEN: proxyToken,
		};

		// Pass the config inline via env when it is small; otherwise stash it for the
		// runtime to fetch over HTTP from /internal/config. Large configs (workflows
		// embed the full definition) would otherwise blow past the docker-socket-proxy
		// request buffer and fail createContainer with HTTP 431. The runtime's
		// loadConfig() reads RUNTIME_CONFIG when present, else fetches — no runtime change.
		const serializedConfig = JSON.stringify(runtimeConfig);
		const configViaFetch = serializedConfig.length > this.maxEnvConfigBytes;
		if (configViaFetch) {
			this.pendingConfigs.set(threadId, {
				config: runtimeConfig,
				expiresAt: Date.now() + this.pendingConfigTtlMs,
			});
		} else {
			env.RUNTIME_CONFIG = serializedConfig;
		}

		logger.info(
			{
				agentId,
				threadId,
				triggerType,
				driver: this.driver.name,
				workspacePath,
				allowInternetAccess: agent.allowInternetAccess,
				hasWorkflow: !!workflowConfig,
				configBytes: serializedConfig.length,
				configViaFetch,
			},
			'[runtime] spawning agent runtime',
		);

		// Captured for onClose: a workflow run is normally marked terminal by the
		// runtime itself; if the runtime dies before that call lands we reconcile it.
		const workflowRunId = workflowConfig?.runId;

		let handle: RuntimeHandle;
		try {
			handle = await this.driver.spawn({
				agentId,
				threadId,
				allowInternetAccess: agent.allowInternetAccess,
				workspacePath,
				env,
			});
		} catch (spawnErr) {
			// The runtime never started, so no one will fetch the stashed config — drop it.
			this.pendingConfigs.delete(threadId);
			logger.error({ err: spawnErr, agentId, threadId }, '[runtime] failed to spawn runtime');
			await this.sessionService.updateThreadStatus(threadId, 'error');
			agentStreamBus.emit(threadId, {
				type: 'error',
				message: `Failed to start agent runtime: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
			});
			agentStreamBus.emit(threadId, { type: 'done' });
			this.settleWaiters(threadId, 'error');
			return false;
		}
		this.liveRuns.set(threadId, handle);

		logger.debug({ agentId, threadId, runtimeId: handle.id }, '[runtime] runtime started');

		// Accumulate the last N chars of both stdout and stderr.
		// The runtime uses pino logger which writes structured JSON to stdout, not stderr.
		// We capture both streams so extractUserErrorMessage can find the actual error
		// regardless of which stream it appears on.
		const OUTPUT_CAP = 4096;
		let stdoutTail = '';
		let stderrTail = '';

		handle.onStdout((text) => {
			logger.info({ agentId, threadId }, `[agent] ${text.trim()}`);
			stdoutTail = (stdoutTail + text).slice(-OUTPUT_CAP);
		});
		handle.onStderr((text) => {
			logger.warn({ agentId, threadId }, `[agent:stderr] ${text.trim()}`);
			stderrTail = (stderrTail + text).slice(-OUTPUT_CAP);
		});

		// Hard timeout — kills runs that hang past the HITL window or loop forever.
		// The PROXY_TOKEN expires after 15 min, but an idle/looping runtime would
		// otherwise keep its slot (and container) alive indefinitely.
		let timedOut = false;
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			logger.warn(
				{ agentId, threadId, runtimeId: handle.id, timeoutMs: this.runTimeoutMs },
				'[runtime] run timed out — killing runtime',
			);
			void handle.kill();
		}, this.runTimeoutMs);
		timeoutTimer.unref();

		handle.onClose(async (code) => {
			clearTimeout(timeoutTimer);
			this.liveRuns.delete(threadId);
			// A user-initiated stop resolves the thread to 'idle' (not 'error') and
			// suppresses the error toast below — the exit was intentional.
			const cancelled = this.cancelledThreads.delete(threadId);
			const status = cancelled ? 'idle' : code === 0 ? 'completed' : 'error';
			logger.info({ agentId, threadId, code, status, cancelled }, '[runtime] agent runtime exited');

			// Persist any browser session this turn opened (flush history + storageState),
			// but keep it OPEN across turns of this thread so a follow-up ("now take a
			// screenshot") stays on the same page. The session is reaped by the
			// idle/max-lifetime timers, on thread delete, or at shutdown. Awaited (it is
			// best-effort and never throws) so the flush completes before the handler
			// returns — otherwise a restart right after a turn could drop the visits.
			await this.browserService.saveOnTurnEnd(threadId);
			try {
				await this.sessionService.updateThreadStatus(threadId, status);
			} catch (err) {
				logger.error({ err, threadId }, '[runtime] failed to update thread status on exit');
			}

			if (!cancelled && code !== 0) {
				// Abnormal exit (not a user stop). Surface the error to the browser and
				// reconcile any orphaned workflow run.
				// Try stderr first (raw Node errors), then fall back to stdout (pino JSON logs).
				const errorMessage = timedOut
					? `Agent run timed out after ${Math.round(this.runTimeoutMs / 60000)} minutes.`
					: extractUserErrorMessage(stderrTail || stdoutTail);
				agentStreamBus.emit(threadId, { type: 'error', message: errorMessage });
				await this.reconcileOrphanedWorkflowRun(workflowRunId, threadId, code, errorMessage);
			} else if (cancelled) {
				// The user stopped the turn — no error toast, but a stopped workflow
				// run is not a success, so reconcile a still-running one to 'error'.
				await this.reconcileOrphanedWorkflowRun(
					workflowRunId,
					threadId,
					code,
					'Run stopped by user.',
				);
			}
			// Always emit 'done' so the SSE subscriber can clean up
			agentStreamBus.emit(threadId, { type: 'done' });
			// Release any synchronous ask_agent caller waiting on this thread's result.
			this.settleWaiters(threadId, status);
		});

		handle.onError((err) => {
			logger.error({ err, agentId, threadId, runtimeId: handle.id }, '[runtime] runtime error');
		});

		return true;
	}

	/**
	 * Reconcile a workflow run that is still 'running' down to 'error'. The runtime
	 * normally marks its own run terminal (POST /workflow/run-complete); this is the
	 * safety net for when it died, timed out, or was stopped by the user before that
	 * call landed — otherwise the row would sit at 'running' forever. The status read
	 * guards the read-modify-write race so we never clobber a run the runtime already
	 * completed. No-op when there is no run id (chat turns).
	 */
	private async reconcileOrphanedWorkflowRun(
		workflowRunId: string | undefined,
		threadId: string,
		code: number | null,
		errorMessage: string,
	): Promise<void> {
		if (!workflowRunId) return;
		try {
			const run = await this.workflowRunService.getRunByIdInternal(workflowRunId);
			if (run && run.status === 'running') {
				await this.workflowRunService.completeRun(workflowRunId, 'error', errorMessage);
				logger.warn(
					{ runId: workflowRunId, threadId, code },
					'[runtime] reconciled orphaned workflow run to error',
				);
			}
		} catch (err) {
			logger.error(
				{ err, runId: workflowRunId, threadId },
				'[runtime] failed to reconcile workflow run on exit',
			);
		}
	}

	/**
	 * Remove the persistent workspace directory for an agent.
	 * Called by AgentService.delete() when an agent is permanently deleted.
	 */
	removeWorkspace(agentId: string): void {
		const workspacePath = join(this.workspacesBasePath, agentId);
		if (!workspacePath.startsWith(this.workspacesBasePath)) {
			logger.warn({ agentId }, '[runtime] removeWorkspace: invalid agentId skipped');
			return;
		}
		try {
			rmSync(workspacePath, { recursive: true, force: true });
			logger.info({ agentId }, '[runtime] removed agent workspace');
		} catch (err) {
			logger.error({ err, agentId }, '[runtime] failed to remove agent workspace');
		}
	}

	/**
	 * Build the AgentRuntimeConfig that is passed to the runtime via env var.
	 * Contains no secrets — API keys and credentials stay in the backend process.
	 *
	 * The agent and model config objects are passed in from spawnForThread to avoid
	 * redundant DB fetches (spawnForThread already validated the model config).
	 * When workflowConfig is provided, the `workflow` field is included so the runtime
	 * routes to workflow-runner.ts.
	 */
	private async buildRuntimeConfig(
		agent: Agent,
		modelConfig: LlmProviderConfig,
		threadId: string,
		ownerId: string,
		triggerType: AgentTriggerType,
		skills: SkillRuntimeEntry[],
		triggerPayload?: Record<string, unknown>,
		userDatetime?: string,
		workflowConfig?: WorkflowSpawnConfig,
		channel?: ChannelType,
		missionConfig?: MissionSpawnConfig,
		missionChatMode?: boolean,
	): Promise<AgentRuntimeConfig> {
		const modelProvider = modelConfig.provider;
		const modelId = modelConfig.model;

		// Resolve credential metadata so the agent prompt can show name, integration,
		// and OAuth2 scopes (when available). We fetch all credentials for this owner
		// and filter to those on the agent.
		//
		// Scope resolution strategy (in priority order):
		//   1. The "scope" property stored in the credential's encrypted data — this is
		//      the value the user actually entered (e.g. Google Workspace lets users
		//      customise the scopes). It lives in the decrypted data blob as `data.scope`.
		//   2. The default scope declared in the definition's oauth2.scope field.
		//   3. undefined — no scope info available; agent may attempt the call freely.
		// When agent.allCredentials is set, the agent's prompt metadata lists every
		// credential the owner has (current and future); otherwise only the explicitly
		// linked ones.
		const credentials: CredentialMeta[] = [];
		if (agent.allCredentials || agent.credentialIds.length > 0) {
			const allCredentials = await this.credentialService.listByOwner(ownerId);
			for (const cred of allCredentials) {
				if (agent.allCredentials || agent.credentialIds.includes(cred.id)) {
					// Decrypt once — reused for both scope resolution and non-secret property extraction
					let data: Record<string, unknown> | null = null;
					try {
						data = await this.credentialService.getDecryptedData(cred.id, ownerId);
					} catch (err) {
						logger.warn(
							{ credId: cred.id, err },
							'[runtime] failed to decrypt credential data for runtime config',
						);
					}

					let scopes: string | undefined;
					try {
						// First: read the actual stored value from the encrypted data blob.
						if (data && typeof data.scope === 'string' && data.scope.trim().length > 0) {
							scopes = data.scope.trim();
						} else {
							// Fallback: use the default scope from the YAML definition (oauth2.scope).
							const definition = getCredentialDefinition(cred.type);
							const defScope = definition?.oauth2?.scope;
							if (typeof defScope === 'string' && defScope.trim().length > 0) {
								scopes = defScope.trim();
							}
						}
					} catch (err) {
						// Non-fatal — agent will operate without scope info for this credential.
						logger.warn(
							{ credId: cred.id, err },
							'[runtime] failed to resolve scopes for credential — omitting from prompt',
						);
					}

					// Collect non-secret properties (string/number/boolean typed fields).
					// These give the agent context it needs to construct URLs (e.g. baseUrl for
					// Home Assistant). Secret-typed fields are never included.
					let properties: Record<string, string> | undefined;
					try {
						const definition = getCredentialDefinition(cred.type);
						if (definition && data) {
							const nonSecretProps: Record<string, string> = {};
							for (const prop of definition.properties) {
								if (prop.type !== 'secret' && data[prop.name] !== undefined) {
									nonSecretProps[prop.name] = String(data[prop.name]);
								}
							}
							if (Object.keys(nonSecretProps).length > 0) {
								properties = nonSecretProps;
							}
						}
					} catch (propErr) {
						logger.warn(
							{ credId: cred.id, err: propErr },
							'[runtime] failed to resolve non-secret properties for credential',
						);
					}

					credentials.push({
						id: cred.id,
						name: cred.name,
						integration: cred.type,
						...(scopes !== undefined ? { scopes } : {}),
						...(properties !== undefined ? { properties } : {}),
					});
				}
			}
		}

		// A2A delegation chain — carried from the thread row (set by AgentMessagingService
		// for agent-initiated threads). Informational for the runtime; the host re-derives
		// and re-validates it from the thread on every A2A call. A lookup failure is
		// non-fatal — the chain only affects the runtime's own awareness.
		let delegationChain: string[] | undefined;
		try {
			const thread = await this.sessionService.getThreadByIdInternal(threadId);
			if (thread?.delegationChain && thread.delegationChain.length > 0) {
				delegationChain = thread.delegationChain;
			}
		} catch (err) {
			logger.warn(
				{ threadId, err },
				'[runtime] failed to load delegation chain for runtime config',
			);
		}

		// Knowledge base summary — file names only, for the system-prompt note that
		// tells the agent its knowledge is retrievable via memory_search. A lookup
		// failure must never block a run.
		const KB_PROMPT_MAX_FILE_NAMES = 20;
		let knowledgeBase: AgentRuntimeConfig['knowledgeBase'];
		try {
			const fileNames = await this.knowledgeBaseService.listReadyFileNamesForAgent(agent.id);
			if (fileNames.length > 0) {
				knowledgeBase = {
					fileCount: fileNames.length,
					fileNames: fileNames.slice(0, KB_PROMPT_MAX_FILE_NAMES),
				};
			}
		} catch (err) {
			logger.warn(
				{ agentId: agent.id, err },
				'[runtime] failed to load knowledge base summary — omitting from prompt',
			);
		}

		// MCP tools — offered only when the agent has internet access. Reads the
		// enabled tool metadata (no secrets) from each assigned server's cache; the
		// backend re-checks ownership + assignment + tool-enabled on every call.
		let mcpServersConfig: AgentRuntimeConfig['mcpServers'];
		if (agent.allowInternetAccess) {
			try {
				const entries = await this.mcpService.getAssignedServerTools(agent.id, ownerId);
				if (entries.length > 0) mcpServersConfig = entries;
			} catch (err) {
				logger.warn({ agentId: agent.id, err }, '[runtime] failed to load MCP tools — omitting');
			}
		}

		return {
			agentId: agent.id,
			ownerId,
			threadId,
			name: agent.name,
			systemInstruction: agent.systemInstruction ?? '',
			modelProvider,
			modelId,
			credentialIds: credentials.map((c) => c.id),
			credentials,
			// Compact skill index only — full instructions are materialized into
			// <workspace>/skills/ and read by the agent on demand.
			...(skills.length > 0 ? { skills } : {}),
			...(knowledgeBase !== undefined ? { knowledgeBase } : {}),
			embeddingModelConfigId: agent.embeddingModelConfigId,
			triggerType,
			triggerPayload,
			// User's local datetime — used to inject current date/time context into the system prompt.
			// Falls back to server time in agent-runner.ts when absent (cron/webhook/manual triggers).
			...(userDatetime !== undefined ? { userDatetime } : {}),
			// Per-agent chat tool-call cap — drives both the hard stop and the proactive
			// budget notice in agent-runner.ts. Defaults to 20 if the column is unset.
			maxToolCallsPerTurn: agent.maxToolCallsPerTurn ?? 20,
			// Browser tools are offered to the runtime only when the agent has internet
			// access AND the project-wide browser feature is enabled (hard-gate layer 1:
			// conditional tool registration). The authoritative gate is a live DB check
			// on every browser action in BrowserService (layer 2).
			browserAvailable: agent.allowInternetAccess && this.browserService.isEnabled(),
			// The render_ui (OpenUI generative UI) tool is offered only for chat turns
			// coming from the web channel — external channels (telegram/discord) and
			// cron/webhook/workflow runs cannot display interactive UI and stay text-only.
			uiRenderingAvailable: triggerType === 'chat' && channel === 'web',
			// Agent-to-agent tools are offered only when the agent has at least one
			// collaborator in its allow-list. The authoritative allow-list + depth/cycle
			// checks run host-side on every A2A call (AgentMessagingService).
			agentMessagingAvailable: agent.collaboratorIds.length > 0,
			// MCP servers assigned to this agent (enabled tools only, no secrets).
			// agent-runner registers one namespaced tool per entry; the backend
			// re-checks ownership/assignment/tool-enabled on every call.
			...(mcpServersConfig !== undefined ? { mcpServers: mcpServersConfig } : {}),
			...(delegationChain !== undefined ? { delegationChain } : {}),
			// Workflow config — present only for workflow runs. Causes the runtime to route
			// to workflow-runner.ts rather than agent-runner.ts.
			...(workflowConfig !== undefined
				? {
						workflow: {
							runId: workflowConfig.runId,
							definition: workflowConfig.definition,
							triggerContext: workflowConfig.triggerContext,
						},
					}
				: {}),
			// Mission context — present for autonomous mission wakes (triggerType
			// 'mission') and owner steering chats on a mission thread. Gates the
			// mission_* tools and feeds the mission prompt section in agent-runner.ts.
			...(missionConfig !== undefined ? { mission: missionConfig.mission } : {}),
			...(missionChatMode ? { missionChatMode: true } : {}),
		};
	}
}
