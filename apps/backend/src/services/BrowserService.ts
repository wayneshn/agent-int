import {
	existsSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	statSync,
	rmSync,
	renameSync,
} from 'fs';
import { resolve, join, dirname, sep } from 'path';
import { isIP } from 'net';
import { lookup as dnsLookup } from 'dns/promises';
import Docker from 'dockerode';
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
	type Locator,
} from 'playwright-core';
import type {
	BrowserCommand,
	BrowserActionRequest,
	BrowserActionResult,
	BrowserSessionStatus,
	BrowserHistoryEntry,
	SandboxTokenPayload,
} from '@repo/types';
import { logger } from '../config/logger.js';
import { isBlockedAddress } from '../utils/ssrfGuard.js';
import type { AgentService } from './AgentService.js';
import {
	collectInteractiveElements,
	readBodyText,
	type SnapshotElement,
} from './browser/pageScripts.js';

/** Label applied to every browser container — used for orphan reaping. */
const BROWSER_LABEL = 'valmis.browser';

/** Default viewport for every browser context. */
const VIEWPORT = { width: 1280, height: 800 };

/** Hard caps on returned payloads so a tool result never floods the LLM context. */
const MAX_SNAPSHOT_ELEMENTS = 200;
const MAX_PAGE_TEXT_CHARS = 20000;
const MAX_ERROR_CHARS = 400;

/** Most-recent visited pages kept per agent (history.json). */
const HISTORY_CAP = 500;

/** Debounce for incremental history flushes after a visit — durability vs. write rate. */
const HISTORY_FLUSH_DEBOUNCE_MS = 2000;

/** A live per-thread browser session. */
interface BrowserSession {
	context: BrowserContext;
	page: Page;
	agentId: string;
	createdAt: number;
	lastUsedAt: number;
	/** Visited pages this session, flushed into the agent's history.json on persist. */
	visitedUrls: BrowserHistoryEntry[];
	/** Reset on every action — reaps the session after inactivity. */
	idleTimer: ReturnType<typeof setTimeout>;
	/** Debounced incremental history flush — coalesces a burst of visits into one write. */
	historyFlushTimer?: ReturnType<typeof setTimeout>;
	/** Set once at creation, never reset — hard cap on total session lifetime. */
	maxTimer: ReturnType<typeof setTimeout>;
}

/**
 * Host-side browser automation. The agent sandbox never runs or touches a
 * browser directly — it sends one {@link BrowserCommand} per tool call to the
 * backend, which drives Playwright against a browser the host controls.
 *
 * Provider modes (auto-selected, see resolveMode):
 *   - container: connect (CDP or Playwright protocol) to a separate, host-managed
 *     browser container launched through the Docker socket-proxy. Used in
 *     production (AGENT_RUNTIME_DRIVER=docker), where the backend shares a Docker
 *     network with the browser container and can reach it by IP.
 *   - local: launch a headless Chromium in-process via the full `playwright`
 *     package. Used on bare-metal / no-Docker test environments. Safe — the
 *     "no browser inside the agent runtime" rule is about the sandbox, not the
 *     trusted backend.
 * Both modes yield a Playwright Browser; everything downstream (per-thread
 * BrowserContext isolation, snapshots, storageState, the gate) is identical.
 *
 * Isolation: ONE shared Browser, one isolated BrowserContext per threadId
 * (separate cookies/cache/storage). Contexts are torn down at turn end (and on
 * idle), exporting storageState first so the agent auto-reconnects with the same
 * login next time.
 *
 * Hard gate: the project-wide BROWSER_FEATURE_ENABLED flag must be 'true' (else
 * the whole feature — image pull, container, tools — is off), AND every action
 * does a LIVE DB read of the agent's allowInternetAccess and refuses if it is
 * off. The runtime-config `browserAvailable` flag (set by AgentRuntimeService)
 * is only the UX/defense-in-depth layer; this live check is authoritative.
 *
 * State persistence (storageState — cookies + localStorage) is stored per-agent
 * in AGENT_BROWSER_STATE_PATH, a backend-only directory that is NEVER mounted
 * into any runtime container, so the agent/LLM cannot read its own session
 * cookies (which it could otherwise exfiltrate via call_api).
 */
export class BrowserService {
	private readonly docker: Docker;
	private readonly enabled: boolean;
	private readonly configuredMode: 'auto' | 'container' | 'local';
	private mode: 'container' | 'local' | null = null;

	// Container-mode config
	private readonly image: string;
	private readonly network: string;
	private readonly containerPort: number;
	private readonly connectMode: 'cdp' | 'ws';
	private readonly wsEndpointOverride: string | undefined;
	private readonly token: string | undefined;
	private readonly memoryLimitBytes: number;
	private readonly nanoCpus: number;
	private readonly pidsLimit: number;

	// Session config
	private readonly maxSessions: number;
	private readonly idleTimeoutMs: number;
	private readonly actionTimeoutMs: number;
	private readonly navigationTimeoutMs: number;
	private readonly stateBasePath: string;
	// Local-mode only: launch an existing browser binary instead of Playwright's
	// downloaded one. `executablePath` points at a chromium/chrome binary;
	// `channel` (e.g. 'chrome') uses an installed branded browser. Either lets a
	// bare-metal dev skip `playwright install`.
	private readonly localExecutablePath: string | undefined;
	private readonly localChannel: string | undefined;
	// Per-agent workspace base — same resolution as AgentRuntimeService. Used by
	// browser_screenshot({ path }) to save a PNG into the agent's workspace.
	private readonly workspacesBasePath: string;
	// Hard cap on a session's total lifetime, regardless of activity, so a session
	// that keeps getting touched still can't live forever (owner constraint).
	private readonly maxLifetimeMs: number;
	// Tears down the entire shared browser (and, in container mode, its container)
	// after this long with zero active sessions, so an idle deployment reclaims the
	// browser's memory instead of keeping it warm forever. The next command relaunches it.
	private readonly containerIdleTimeoutMs: number;

	private sharedBrowser: Browser | null = null;
	private browserContainerId: string | null = null;
	/** Dedupes concurrent on-demand pulls — see ensureImage. */
	private imagePullInFlight: Promise<void> | null = null;
	/** Live sessions keyed by threadId. */
	private readonly sessions = new Map<string, BrowserSession>();
	/** Fires after containerIdleTimeoutMs with no sessions → tears the browser down. */
	private containerIdleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly agentService: AgentService) {
		// dockerode honours DOCKER_HOST / DOCKER_TLS_VERIFY automatically.
		this.docker = new Docker();
		this.enabled = process.env.BROWSER_FEATURE_ENABLED === 'true';

		const rawMode = (process.env.BROWSER_MODE ?? 'auto').toLowerCase();
		this.configuredMode =
			rawMode === 'container' || rawMode === 'local' ? (rawMode as 'container' | 'local') : 'auto';

		this.image = process.env.BROWSER_IMAGE ?? 'ghcr.io/valmishq/valmis-browser:latest';
		// Dedicated browser network — kept separate from the agent runtime networks so
		// agents can never reach the shared browser's debug port (cross-agent cookie
		// theft guard). The backend must be attached to it (compose does this).
		this.network = process.env.BROWSER_NETWORK ?? 'valmis_browser';
		this.containerPort = parseInt(process.env.BROWSER_CONTAINER_PORT ?? '3000', 10);
		// Default 'ws' (Playwright protocol) to match the default valmis-browser image.
		// browserless users set BROWSER_CONNECT_MODE=cdp explicitly.
		this.connectMode = process.env.BROWSER_CONNECT_MODE === 'cdp' ? 'cdp' : 'ws';
		this.wsEndpointOverride = process.env.BROWSER_WS_ENDPOINT || undefined;
		this.token = process.env.BROWSER_TOKEN || undefined;
		this.memoryLimitBytes =
			parseInt(process.env.BROWSER_MEMORY_LIMIT_MB ?? '1024', 10) * 1024 * 1024;
		this.nanoCpus = Math.round(parseFloat(process.env.BROWSER_CPU_LIMIT ?? '1') * 1e9);
		this.pidsLimit = parseInt(process.env.BROWSER_PIDS_LIMIT ?? '512', 10);

		this.localExecutablePath = process.env.BROWSER_LOCAL_EXECUTABLE_PATH || undefined;
		this.localChannel = process.env.BROWSER_LOCAL_CHANNEL || undefined;
		this.maxSessions = parseInt(process.env.BROWSER_MAX_CONCURRENT_SESSIONS ?? '10', 10);
		this.idleTimeoutMs = parseInt(process.env.BROWSER_SESSION_IDLE_TIMEOUT_MS ?? '300000', 10);
		this.actionTimeoutMs = parseInt(process.env.BROWSER_ACTION_TIMEOUT_MS ?? '15000', 10);
		this.navigationTimeoutMs = parseInt(process.env.BROWSER_NAVIGATION_TIMEOUT_MS ?? '30000', 10);
		// Backend-only state dir — NEVER under AGENT_WORKSPACES_PATH (cookies must
		// not be readable by the agent's file tools). Default: repo-root sibling.
		// In docker-compose this points at the consolidated app-data volume
		// (/opt/app-data/browser-state).
		this.stateBasePath =
			process.env.AGENT_BROWSER_STATE_PATH ?? resolve(process.cwd(), '../../.agent-browser-state');
		this.workspacesBasePath =
			process.env.AGENT_WORKSPACES_PATH ?? resolve(process.cwd(), '../../.agent-workspaces');
		this.maxLifetimeMs = parseInt(process.env.BROWSER_SESSION_MAX_LIFETIME_MS ?? '1800000', 10);
		// Default 1h. After this long with no sessions, the shared browser/container
		// is torn down (it is otherwise kept warm for the backend's whole lifetime).
		this.containerIdleTimeoutMs = parseInt(
			process.env.BROWSER_CONTAINER_IDLE_TIMEOUT_MS ?? '3600000',
			10,
		);
	}

	/** Whether the browser feature is enabled project-wide (the master kill-switch). */
	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Resolve the effective provider mode. `auto` picks container only when the
	 * backend itself runs the docker execution driver (production compose, where
	 * the backend shares a network with the browser container); otherwise local.
	 * This deliberately avoids "Docker is reachable" probing, which would wrongly
	 * pick container mode on a macOS dev host where the host cannot reach
	 * container IPs.
	 */
	private resolveMode(): 'container' | 'local' {
		if (this.mode) return this.mode;
		if (this.configuredMode === 'container' || this.configuredMode === 'local') {
			this.mode = this.configuredMode;
		} else {
			this.mode = process.env.AGENT_RUNTIME_DRIVER === 'docker' ? 'container' : 'local';
		}
		return this.mode;
	}

	/**
	 * Prepare the browser provider. A NO-OP when the feature flag is off — so a
	 * default deployment never pulls the browser image or starts a container.
	 * Call once at backend startup, after the execution driver's init().
	 */
	async init(): Promise<void> {
		if (!this.enabled) {
			logger.info('[browser] feature disabled (BROWSER_FEATURE_ENABLED != true) — skipping init');
			return;
		}
		const mode = this.resolveMode();
		if (mode === 'local') {
			logger.info('[browser] local mode — headless chromium will launch in-process on first use');
			return;
		}
		// Container mode.
		if (this.wsEndpointOverride) {
			logger.info(
				{ endpoint: this.wsEndpointOverride },
				'[browser] container mode — using externally-managed browser endpoint',
			);
			return;
		}
		await this.ensureNetwork();
		await this.pullImage();
		await this.reapOrphans();
		logger.info(
			{ image: this.image, network: this.network, connectMode: this.connectMode },
			'[browser] container mode initialised (browser launches lazily on first use)',
		);
	}

	/** Tear down every session (saving state) and the shared browser + container. */
	async shutdown(): Promise<void> {
		this.cancelContainerIdleTimer();
		const threadIds = [...this.sessions.keys()];
		for (const threadId of threadIds) {
			await this.closeSession(threadId);
		}
		if (this.sharedBrowser) {
			try {
				await this.sharedBrowser.close();
			} catch {
				// already gone
			}
			this.sharedBrowser = null;
		}
		if (this.browserContainerId) {
			try {
				await this.docker.getContainer(this.browserContainerId).remove({ force: true });
			} catch {
				// already gone
			}
			this.browserContainerId = null;
		}
	}

	/**
	 * Called at the END of an agent turn (from AgentRuntimeService.onClose). The
	 * browser is kept OPEN across turns of the same thread so a follow-up turn
	 * ("now take a screenshot") stays on the same page instead of a fresh
	 * about:blank. We only persist storageState and re-arm the idle timer here.
	 * Full teardown happens on idle timeout, the max-lifetime cap, thread delete,
	 * or shutdown (see closeSession). Best-effort — never throws.
	 */
	async saveOnTurnEnd(threadId: string): Promise<void> {
		const session = this.sessions.get(threadId);
		if (!session) return;
		await this.persistState(session, threadId);
		// Re-arm idle so the kept-open session is still reaped after inactivity.
		clearTimeout(session.idleTimer);
		session.idleTimer = this.armIdleTimer(threadId);
	}

	/**
	 * Fully tear down a thread's browser session — save storageState, then close
	 * the context and drop it. Triggered by the idle timeout, the max-lifetime
	 * cap, thread deletion, and shutdown. Best-effort — never throws.
	 */
	async closeSession(threadId: string): Promise<void> {
		const session = this.sessions.get(threadId);
		if (!session) return;
		this.sessions.delete(threadId);
		clearTimeout(session.idleTimer);
		clearTimeout(session.maxTimer);
		await this.persistState(session, threadId);
		try {
			await session.context.close();
		} catch {
			// context may already be gone if the browser disconnected
		}
		this.armContainerIdleTimerIfEmpty();
	}

	/** Export a session's storageState to its backend-only per-agent path + flush history. */
	private async persistState(session: BrowserSession, threadId: string): Promise<void> {
		// Flush any pages visited this turn into the agent's history.json (capped).
		this.flushHistory(session);
		try {
			const statePath = this.storageStatePath(session.agentId);
			mkdirSync(join(this.stateBasePath, session.agentId), { recursive: true });
			await session.context.storageState({ path: statePath });
		} catch (err) {
			logger.warn({ err, threadId }, '[browser] failed to save storageState — non-fatal');
		}
	}

	/**
	 * Persist this session's buffered visits into the agent's history.json (merge +
	 * cap), then clear the buffer. SYNCHRONOUS — no await between loadHistory and
	 * saveHistory — so concurrent flushes in this single-process backend cannot
	 * interleave into a lost update. Touches only in-memory data + the filesystem,
	 * so it still works when the browser/context is already dead. Best-effort.
	 */
	private flushHistory(session: BrowserSession): void {
		if (session.historyFlushTimer) {
			clearTimeout(session.historyFlushTimer);
			session.historyFlushTimer = undefined;
		}
		if (session.visitedUrls.length === 0) return;
		try {
			const merged = [...this.loadHistory(session.agentId), ...session.visitedUrls];
			this.saveHistory(session.agentId, merged.slice(-HISTORY_CAP));
			session.visitedUrls = [];
		} catch (err) {
			logger.warn(
				{ err, agentId: session.agentId },
				'[browser] failed to flush history — non-fatal',
			);
		}
	}

	/** Schedule a debounced history flush so a crash/redeploy loses at most a short window of visits. */
	private scheduleHistoryFlush(session: BrowserSession): void {
		if (session.historyFlushTimer) clearTimeout(session.historyFlushTimer);
		session.historyFlushTimer = setTimeout(() => {
			session.historyFlushTimer = undefined;
			this.flushHistory(session);
		}, HISTORY_FLUSH_DEBOUNCE_MS);
		session.historyFlushTimer.unref();
	}

	// ─── Command entry point ───────────────────────────────────────────────────

	/**
	 * Execute one browser command on behalf of a sandbox. Runs the hard gate,
	 * lazily creates the thread's session, then dispatches. Recoverable failures
	 * (timeouts, missing element, browser blip) are returned as `isError` text so
	 * the LLM can react; only the gate/availability checks throw (→ the route
	 * returns { success:false }).
	 */
	async execute(
		token: SandboxTokenPayload,
		req: BrowserActionRequest,
	): Promise<BrowserActionResult> {
		if (!this.enabled) {
			throw new Error('Browser automation is not enabled in this deployment.');
		}

		// ── HARD GATE (authoritative, live DB) ────────────────────────────────
		// Mirrors the credential-revocation live check in AgentProxyService: an
		// internet-OFF flip takes effect immediately, even mid-session.
		const agent = await this.agentService.getByIdInternal(token.agentId);
		if (!agent) {
			throw new Error('Agent not found.');
		}
		if (!agent.allowInternetAccess) {
			logger.warn(
				{ agentId: token.agentId, threadId: token.threadId },
				'[browser] access denied — allowInternetAccess is off for this agent',
			);
			throw new Error('Browser access denied: this agent does not have internet access enabled.');
		}

		const session = await this.getOrCreateSession(token.threadId, token.agentId);
		this.touch(session);

		try {
			return await this.dispatch(session, req.command);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(
				{ err, threadId: token.threadId, action: req.command.action },
				'[browser] command failed',
			);
			// If the underlying browser/page died, drop the session so the next call
			// rebuilds it from saved state instead of reusing a dead context.
			if (!this.sharedBrowser?.isConnected() || session.page.isClosed()) {
				await this.dropSession(token.threadId);
			}
			let url: string | undefined;
			try {
				url = session.page.isClosed() ? undefined : session.page.url();
			} catch {
				url = undefined;
			}
			return {
				text: `Browser ${req.command.action} failed: ${message.slice(0, MAX_ERROR_CHARS)}`,
				isError: true,
				url,
			};
		}
	}

	// ─── Sessions ──────────────────────────────────────────────────────────────

	private async getOrCreateSession(threadId: string, agentId: string): Promise<BrowserSession> {
		const existing = this.sessions.get(threadId);
		if (existing && !existing.page.isClosed()) return existing;
		if (existing) await this.dropSession(threadId);

		if (this.sessions.size >= this.maxSessions) {
			throw new Error('Too many browser sessions are active right now. Please try again shortly.');
		}

		const browser = await this.getBrowser();
		const options: Parameters<Browser['newContext']>[0] = { viewport: VIEWPORT };
		const statePath = this.storageStatePath(agentId);
		if (existsSync(statePath)) {
			// Playwright reads storageState on the CLIENT side (this backend process)
			// in both provider modes, so a backend path works for container mode too.
			options.storageState = statePath;
		}
		const context = await browser.newContext(options);
		context.setDefaultTimeout(this.actionTimeoutMs);
		context.setDefaultNavigationTimeout(this.navigationTimeoutMs);
		const page = await context.newPage();

		const maxTimer = setTimeout(() => {
			logger.info({ threadId }, '[browser] session reached max lifetime — closing');
			void this.closeSession(threadId);
		}, this.maxLifetimeMs);
		maxTimer.unref();

		const now = Date.now();
		const session: BrowserSession = {
			context,
			page,
			agentId,
			createdAt: now,
			lastUsedAt: now,
			visitedUrls: [],
			idleTimer: this.armIdleTimer(threadId),
			maxTimer,
		};
		this.sessions.set(threadId, session);
		// Record EVERY committed main-frame navigation — clicks on links, form posts,
		// type+submit, server/JS redirects, goBack/goForward, and most SPA pushState
		// route changes — not just explicit browser_navigate. recordVisit's dedup +
		// about:blank filter make this idempotent; it also schedules a debounced flush.
		page.on('framenavigated', (frame) => {
			if (frame === page.mainFrame()) void this.recordVisit(session, page);
		});
		logger.info({ threadId, agentId }, '[browser] session created');
		return session;
	}

	private armIdleTimer(threadId: string): ReturnType<typeof setTimeout> {
		const timer = setTimeout(() => {
			logger.info({ threadId }, '[browser] session idle timeout — closing');
			void this.closeSession(threadId);
		}, this.idleTimeoutMs);
		timer.unref();
		return timer;
	}

	private touch(session: BrowserSession): void {
		session.lastUsedAt = Date.now();
		clearTimeout(session.idleTimer);
		// Re-arm the IDLE timer only (the max-lifetime timer is never reset).
		for (const [threadId, s] of this.sessions) {
			if (s === session) {
				session.idleTimer = this.armIdleTimer(threadId);
				return;
			}
		}
	}

	/** Drop a session whose browser context is dead — but flush its history first. */
	private async dropSession(threadId: string): Promise<void> {
		const session = this.sessions.get(threadId);
		if (!session) return;
		this.sessions.delete(threadId);
		clearTimeout(session.idleTimer);
		clearTimeout(session.maxTimer);
		// Persist buffered visits before discarding. visitedUrls is in-memory and the
		// history write is pure filesystem I/O, so it succeeds even with a dead context
		// (unlike storageState in persistState, which needs the live context). This
		// covers the browser-OOM / page-crash loss path.
		this.flushHistory(session);
		try {
			await session.context.close();
		} catch {
			// already gone
		}
		this.armContainerIdleTimerIfEmpty();
	}

	/**
	 * Arm the idle-teardown timer once the last session is gone. The shared browser
	 * is otherwise kept warm for the backend's whole lifetime; this reclaims it (and
	 * its container) after containerIdleTimeoutMs of zero sessions. No-op while any
	 * session is live, and cancelled the moment the browser is needed again
	 * (see getBrowser). unref'd so it never holds the process open.
	 */
	private armContainerIdleTimerIfEmpty(): void {
		if (this.sessions.size > 0) return;
		if (this.containerIdleTimer) clearTimeout(this.containerIdleTimer);
		this.containerIdleTimer = setTimeout(() => {
			void this.closeIdleBrowser();
		}, this.containerIdleTimeoutMs);
		this.containerIdleTimer.unref();
	}

	/** Cancel a pending idle teardown — called whenever the browser is needed again. */
	private cancelContainerIdleTimer(): void {
		if (this.containerIdleTimer) {
			clearTimeout(this.containerIdleTimer);
			this.containerIdleTimer = null;
		}
	}

	/**
	 * Tear down the shared browser and (container mode) its container after a long
	 * idle stretch. Re-checks under the timer that no session was created in the
	 * meantime. The next browser command transparently relaunches everything via
	 * getBrowser → ensureContainer. Best-effort — never throws.
	 */
	private async closeIdleBrowser(): Promise<void> {
		this.containerIdleTimer = null;
		if (this.sessions.size > 0) return; // a session appeared since the timer armed
		if (this.sharedBrowser) {
			try {
				await this.sharedBrowser.close();
			} catch {
				// already gone
			}
			this.sharedBrowser = null;
		}
		if (this.browserContainerId) {
			const id = this.browserContainerId;
			this.browserContainerId = null;
			try {
				await this.docker.getContainer(id).remove({ force: true });
			} catch {
				// already gone
			}
			logger.info(
				{ containerId: id.slice(0, 12), idleMs: this.containerIdleTimeoutMs },
				'[browser] removed idle browser container (no sessions for the idle window)',
			);
		}
	}

	// ─── Browser provider ──────────────────────────────────────────────────────

	private async getBrowser(): Promise<Browser> {
		// The browser is being used again — abort any pending idle teardown.
		this.cancelContainerIdleTimer();
		if (this.sharedBrowser?.isConnected()) return this.sharedBrowser;
		const browser = await this.connectBrowser();
		browser.on('disconnected', () => {
			logger.warn('[browser] shared browser disconnected — clearing sessions');
			this.sharedBrowser = null;
			for (const [, session] of this.sessions) {
				clearTimeout(session.idleTimer);
				clearTimeout(session.maxTimer);
				// Persist buffered visits before dropping — the browser is gone but the
				// history write does not need it (covers the browser-crash loss path).
				this.flushHistory(session);
			}
			this.sessions.clear();
		});
		this.sharedBrowser = browser;
		return browser;
	}

	private async connectBrowser(): Promise<Browser> {
		const mode = this.resolveMode();
		if (mode === 'local') {
			let pw: typeof import('playwright');
			try {
				pw = await import('playwright');
			} catch {
				throw new Error(
					'Local browser mode requires the "playwright" package with installed browsers. ' +
						'Run: pnpm --filter @repo/backend exec playwright install chromium, ' +
						'or set BROWSER_MODE=container.',
				);
			}
			logger.info(
				{ executablePath: this.localExecutablePath ?? null, channel: this.localChannel ?? null },
				'[browser] launching in-process chromium (local mode)',
			);
			return pw.chromium.launch({
				headless: true,
				...(this.localExecutablePath ? { executablePath: this.localExecutablePath } : {}),
				...(this.localChannel ? { channel: this.localChannel } : {}),
			});
		}

		// Container mode — connect to the host-managed browser container, retrying
		// briefly while the server inside it finishes starting.
		const endpoint = await this.resolveEndpoint();
		const attempts = 8;
		let lastErr: unknown;
		for (let i = 0; i < attempts; i++) {
			try {
				return this.connectMode === 'ws'
					? await chromium.connect(endpoint, { timeout: 15000 })
					: await chromium.connectOverCDP(endpoint, { timeout: 15000 });
			} catch (err) {
				lastErr = err;
				await delay(1000);
			}
		}
		throw new Error(
			`Could not connect to the browser at ${endpoint}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
		);
	}

	private async resolveEndpoint(): Promise<string> {
		if (this.wsEndpointOverride) return this.wsEndpointOverride;
		const ip = await this.ensureContainer();
		const base = `ws://${ip}:${this.containerPort}`;
		return this.token ? `${base}?token=${this.token}` : base;
	}

	/** Ensure the shared browser container is running; return its IP on our network. */
	private async ensureContainer(): Promise<string> {
		if (this.browserContainerId) {
			try {
				const info = await this.docker.getContainer(this.browserContainerId).inspect();
				if (info.State.Running) return this.ipFromInspect(info);
			} catch {
				// container gone — recreate below
			}
			this.browserContainerId = null;
		}

		// Self-heal a pruned image. The browser image is unreferenced whenever no
		// container is running (e.g. after an idle timeout), so an orchestrator's
		// scheduled `docker image prune` can remove it between sessions and the next
		// createContainer would 404. Re-pull only when actually missing.
		await this.ensureImage();

		const env: string[] = [];
		if (this.token) env.push(`TOKEN=${this.token}`);

		const container = await this.docker.createContainer({
			Image: this.image,
			Env: env,
			Labels: { [BROWSER_LABEL]: 'true' },
			HostConfig: {
				NetworkMode: this.network,
				Memory: this.memoryLimitBytes,
				MemorySwap: this.memoryLimitBytes,
				NanoCpus: this.nanoCpus,
				PidsLimit: this.pidsLimit,
				SecurityOpt: ['no-new-privileges'],
			},
		});
		await container.start();
		this.browserContainerId = container.id;
		const info = await container.inspect();
		const ip = this.ipFromInspect(info);
		logger.info(
			{ containerId: container.id.slice(0, 12), ip, image: this.image },
			'[browser] launched browser container',
		);
		return ip;
	}

	private ipFromInspect(info: Docker.ContainerInspectInfo): string {
		const ip = info.NetworkSettings?.Networks?.[this.network]?.IPAddress;
		if (!ip) {
			throw new Error(
				`Browser container has no IP address on network "${this.network}" — ` +
					'ensure BROWSER_NETWORK matches a network the backend is attached to.',
			);
		}
		return ip;
	}

	private async pullImage(): Promise<void> {
		try {
			const stream = await this.docker.pull(this.image);
			await new Promise<void>((res, rej) => {
				this.docker.modem.followProgress(stream, (err) => (err ? rej(err) : res()));
			});
			logger.info({ image: this.image }, '[browser] image up to date');
		} catch (pullErr) {
			try {
				await this.docker.getImage(this.image).inspect();
				logger.warn(
					{ image: this.image, pullErr },
					'[browser] registry pull failed — continuing with the local image',
				);
			} catch {
				throw new Error(
					`[browser] image "${this.image}" not found locally and could not be pulled ` +
						`(${pullErr instanceof Error ? pullErr.message : String(pullErr)}). ` +
						'Set BROWSER_IMAGE to an available image or disable BROWSER_FEATURE_ENABLED.',
				);
			}
		}
	}

	/**
	 * Guarantee the browser image is present locally before (re)creating the
	 * container, re-pulling on demand if it was pruned. The fast path is a single
	 * local image inspect (no network); the pull cost is paid only after an
	 * orchestrator's scheduled image prune. Concurrent callers share one pull.
	 */
	private async ensureImage(): Promise<void> {
		try {
			await this.docker.getImage(this.image).inspect();
			return; // present locally — fast path, no registry round-trip
		} catch {
			// Missing locally (pruned) — fall through to an on-demand pull.
		}

		if (!this.imagePullInFlight) {
			logger.warn(
				{ image: this.image },
				'[browser] image missing locally (pruned?) — pulling on demand before launching container',
			);
			this.imagePullInFlight = this.pullImage().finally(() => {
				this.imagePullInFlight = null;
			});
		}
		await this.imagePullInFlight;
	}

	/**
	 * Ensure the browser network exists (dev backstop — production compose
	 * pre-creates it and attaches the backend). The browser container is kept on
	 * its OWN network, NOT the agent runtime networks: the shared browser holds
	 * several agents' contexts/cookies, so an internet-enabled agent (which shares
	 * the runtime network) must not be able to reach the browser's CDP port and
	 * drive it / steal another agent's session. Only the backend is on this network.
	 */
	private async ensureNetwork(): Promise<void> {
		try {
			await this.docker.getNetwork(this.network).inspect();
		} catch {
			try {
				logger.info({ network: this.network }, '[browser] creating missing browser network');
				await this.docker.createNetwork({
					Name: this.network,
					Labels: { [BROWSER_LABEL]: 'true' },
				});
			} catch (err) {
				logger.warn(
					{ err, network: this.network },
					'[browser] could not ensure browser network — relying on it pre-existing',
				);
			}
		}
	}

	private async reapOrphans(): Promise<void> {
		try {
			const orphans = await this.docker.listContainers({
				all: true,
				filters: { label: [`${BROWSER_LABEL}=true`] },
			});
			for (const info of orphans) {
				try {
					await this.docker.getContainer(info.Id).remove({ force: true });
					logger.warn(
						{ containerId: info.Id.slice(0, 12) },
						'[browser] removed orphaned browser container',
					);
				} catch {
					// already gone
				}
			}
		} catch (err) {
			logger.warn({ err }, '[browser] orphan reap failed — non-fatal');
		}
	}

	// ─── Command dispatch ──────────────────────────────────────────────────────

	private async dispatch(
		session: BrowserSession,
		command: BrowserCommand,
	): Promise<BrowserActionResult> {
		const { page } = session;
		switch (command.action) {
			case 'navigate': {
				// SSRF / local-file guard — refuse the navigation BEFORE the browser dials
				// it. Recoverable (returned as isError text) so the LLM can pick another URL.
				const blocked = await this.checkNavigationTarget(command.url);
				if (blocked) return { text: blocked, isError: true, url: page.url() };
				await page.goto(command.url, {
					waitUntil: 'load',
					timeout: this.navigationTimeoutMs,
				});
				await this.settle(page);
				// Visit recorded by the page 'framenavigated' listener (see getOrCreateSession).
				return { text: await this.snapshot(page), url: page.url() };
			}
			case 'snapshot': {
				return { text: await this.snapshot(page), url: page.url() };
			}
			case 'click': {
				const locator = await this.refLocator(page, command.ref);
				if (!locator) return this.refNotFound(command.ref, page);
				await locator.click({ timeout: this.actionTimeoutMs });
				await this.settle(page);
				return { text: `Clicked ${command.ref}.\n\n${await this.snapshot(page)}`, url: page.url() };
			}
			case 'type': {
				const locator = await this.refLocator(page, command.ref);
				if (!locator) return this.refNotFound(command.ref, page);
				await locator.fill(command.text, { timeout: this.actionTimeoutMs });
				if (command.submit) {
					await locator.press('Enter');
					await this.settle(page);
				}
				return {
					text: `Typed into ${command.ref}${command.submit ? ' and submitted' : ''}.`,
					url: page.url(),
				};
			}
			case 'select': {
				return this.selectOption(page, command.ref, command.values);
			}
			case 'pressKey': {
				await page.keyboard.press(command.key);
				await this.settle(page);
				return { text: `Pressed ${command.key}.`, url: page.url() };
			}
			case 'screenshot': {
				const buffer = await page.screenshot({ fullPage: command.fullPage ?? false });
				let savedNote = '';
				if (command.path) {
					const saved = this.saveScreenshot(session.agentId, command.path, buffer);
					savedNote = ` Saved to workspace at ${saved}.`;
				}
				return {
					text: `Screenshot captured.${savedNote}`,
					image: { data: buffer.toString('base64'), mimeType: 'image/png' },
					url: page.url(),
				};
			}
			case 'readPage': {
				// Concatenate the main document AND every iframe (e.g. embedded forms/
				// widgets) so the agent reads content that isn't in the top frame.
				const parts: string[] = [];
				for (const frame of page.frames()) {
					const t = await frame.evaluate(readBodyText).catch(() => '');
					if (t.trim()) parts.push(t.trim());
				}
				const text = parts.join('\n\n');
				const trimmed =
					text.length > MAX_PAGE_TEXT_CHARS
						? text.slice(0, MAX_PAGE_TEXT_CHARS) + '\n… [truncated]'
						: text;
				return { text: trimmed || '(page has no readable text)', url: page.url() };
			}
			case 'waitFor': {
				const timeout = command.timeoutMs ?? this.actionTimeoutMs;
				if (command.text) {
					await page.getByText(command.text).first().waitFor({ timeout });
				} else if (command.state) {
					await page.waitForLoadState(command.state, { timeout });
				} else {
					await page.waitForTimeout(Math.min(timeout, 5000));
				}
				return { text: 'Wait complete.', url: page.url() };
			}
			case 'goBack': {
				await page.goBack({ waitUntil: 'load' }).catch(() => undefined);
				await this.settle(page);
				return { text: await this.snapshot(page), url: page.url() };
			}
			case 'goForward': {
				await page.goForward({ waitUntil: 'load' }).catch(() => undefined);
				await this.settle(page);
				return { text: await this.snapshot(page), url: page.url() };
			}
		}
	}

	// ─── Navigation guard (SSRF / local-file) ───────────────────────────────────

	/**
	 * Vet a navigation target before the browser loads it. Refuses:
	 *   - any non-http(s) scheme (file:, data:, chrome:, view-source:, …) — these
	 *     would read local files / internal pages (severe in local mode, where the
	 *     browser runs in this backend process);
	 *   - loopback, link-local (incl. the 169.254.169.254 cloud-metadata endpoint),
	 *     and RFC-1918 private hosts — the classic SSRF targets.
	 * Hostnames are DNS-resolved and EVERY resolved address is checked, so a public
	 * name that points at an internal IP is still blocked (best-effort against DNS
	 * rebinding — we cannot pin the exact IP the browser later dials). Returns an
	 * error string to surface to the agent, or null when the URL is allowed.
	 */
	private async checkNavigationTarget(rawUrl: string): Promise<string | null> {
		let parsed: URL;
		try {
			parsed = new URL(rawUrl);
		} catch {
			return `"${rawUrl}" is not a valid absolute URL (expected e.g. https://example.com).`;
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return `Navigation to ${parsed.protocol} URLs is not allowed — only http and https are supported.`;
		}

		const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
		let addresses: string[];
		if (isIP(hostname) !== 0) {
			addresses = [hostname];
		} else {
			try {
				addresses = (await dnsLookup(hostname, { all: true })).map((r) => r.address);
			} catch {
				// Unresolvable — let the browser attempt it (it will fail the same way).
				return null;
			}
		}
		for (const addr of addresses) {
			if (isBlockedAddress(addr)) {
				return (
					`Navigation to "${parsed.hostname}" is blocked: it resolves to a private, loopback, ` +
					`or link-local address (${addr}), which agents may not access.`
				);
			}
		}
		return null;
	}

	// ─── Snapshot + ref helpers ────────────────────────────────────────────────

	/** Best-effort wait for the page to settle (covers SPA hydration / async loads). */
	private async settle(page: Page): Promise<void> {
		await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
	}

	/**
	 * Tag every visible interactive element (in the main document AND every iframe)
	 * with a stable `data-ai-ref` attribute and return a compact, ref-annotated
	 * listing. The agent acts on refs (e1, f1e2, …) which resolve back to elements
	 * by attribute at action time. Retries once if the first pass finds nothing
	 * (late client-side hydration).
	 */
	private async snapshot(page: Page): Promise<string> {
		let collected = await this.collectAcrossFrames(page);
		if (collected.total === 0) {
			await delay(600);
			collected = await this.collectAcrossFrames(page);
		}
		const title = await page.title();
		if (collected.total === 0) {
			return `Page: ${title || '(untitled)'}\n(no interactive elements found — try browser_read_page)`;
		}
		return `Page: ${title || '(untitled)'}\n${collected.text}`;
	}

	/** Run the snapshot script in every frame; refs are prefixed per-frame (globally unique). */
	private async collectAcrossFrames(page: Page): Promise<{ total: number; text: string }> {
		const frames = page.frames();
		const sections: string[] = [];
		let total = 0;
		for (let fi = 0; fi < frames.length && total < MAX_SNAPSHOT_ELEMENTS; fi++) {
			const prefix = fi === 0 ? '' : `f${fi}`;
			const els = (await frames[fi]
				.evaluate(collectInteractiveElements, { max: MAX_SNAPSHOT_ELEMENTS - total, prefix })
				.catch(() => [] as SnapshotElement[])) as SnapshotElement[];
			if (els.length === 0) continue;
			total += els.length;
			const lines = els.map(
				(e) => `[${e.ref}] ${e.role}${e.name ? ` "${e.name}"` : ''}${e.type ? ` (${e.type})` : ''}`,
			);
			const header =
				fi === 0
					? 'Interactive elements:'
					: `Interactive elements in embedded frame ${prefix} (${frames[fi].url()}):`;
			sections.push(`${header}\n${lines.join('\n')}`);
		}
		return { total, text: sections.join('\n\n') };
	}

	/**
	 * Resolve a validated `ref` to a Playwright Locator by searching ALL frames for
	 * the (globally unique) `data-ai-ref` attribute. Returns null if not found
	 * (e.g. stale ref after the page changed).
	 */
	private async refLocator(page: Page, ref: string): Promise<Locator | null> {
		if (!/^(f\d+)?e\d+$/.test(ref)) {
			throw new Error(
				`Invalid element ref "${ref}". Refs look like "e3" (or "f1e3" for an embedded frame) and come from a snapshot.`,
			);
		}
		for (const frame of page.frames()) {
			const loc = frame.locator(`[data-ai-ref="${ref}"]`).first();
			if ((await loc.count()) > 0) return loc;
		}
		return null;
	}

	/**
	 * Select an option, handling BOTH native `<select>` and custom dropdowns
	 * (e.g. `<input role="combobox">` + a listbox). Tries the native API first;
	 * on failure, clicks to open and clicks the matching option/text.
	 */
	private async selectOption(
		page: Page,
		ref: string,
		values: string[],
	): Promise<BrowserActionResult> {
		const locator = await this.refLocator(page, ref);
		if (!locator) return this.refNotFound(ref, page);

		try {
			const selected = await locator.selectOption(values, { timeout: this.actionTimeoutMs });
			return { text: `Selected ${selected.join(', ') || '(none)'} in ${ref}.`, url: page.url() };
		} catch {
			// Not a native <select> — treat as a custom dropdown.
		}

		const want = values[0];
		if (!want) {
			return { text: `No value provided to select in ${ref}.`, isError: true, url: page.url() };
		}
		await locator.click({ timeout: this.actionTimeoutMs }).catch(() => undefined);
		await this.settle(page);
		for (const frame of page.frames()) {
			const option = frame.getByRole('option', { name: want }).first();
			if ((await option.count()) > 0) {
				await option.click({ timeout: this.actionTimeoutMs }).catch(() => undefined);
				await this.settle(page);
				return { text: `Selected "${want}" in ${ref} (custom dropdown).`, url: page.url() };
			}
		}
		return {
			text:
				`Opened ${ref} but found no option matching "${want}". Call browser_snapshot to list the ` +
				`options (role=option) now visible, then browser_click the one you want.`,
			isError: true,
			url: page.url(),
		};
	}

	/** Write a screenshot PNG into the agent's workspace (path-traversal guarded). */
	private saveScreenshot(agentId: string, relPath: string, buffer: Buffer): string {
		if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
			throw new Error(`Invalid agentId for workspace path: ${agentId}`);
		}
		const root = join(this.workspacesBasePath, agentId);
		const resolved = resolve(root, relPath);
		const rootWithSep = root.endsWith(sep) ? root : root + sep;
		if (resolved !== root && !resolved.startsWith(rootWithSep)) {
			throw new Error(`Path traversal not allowed: ${relPath}`);
		}
		mkdirSync(dirname(resolved), { recursive: true });
		writeFileSync(resolved, buffer);
		return relPath;
	}

	private refNotFound(ref: string, page: Page): BrowserActionResult {
		return {
			text: `Element ${ref} was not found on the current page. Call browser_snapshot to get fresh element refs.`,
			isError: true,
			url: page.url(),
		};
	}

	// ─── End-user session management (owner-driven, via the browser modal) ──────

	/**
	 * Summarise an agent's browser state for the management modal: whether the
	 * feature/agent allow it, the persisted login (cookies/origins/size/last-saved),
	 * the recorded history, and any currently-live sessions.
	 */
	getStatus(agentId: string, allowInternetAccess: boolean): BrowserSessionStatus {
		const persisted = this.readPersistedSummary(agentId);
		const history = this.loadHistory(agentId);
		const now = Date.now();
		const activeSessions = [...this.sessions.entries()]
			.filter(([, s]) => s.agentId === agentId)
			.map(([threadId, s]) => ({
				threadId,
				url: s.page.isClosed() ? '' : safeUrl(s.page),
				idleSeconds: Math.round((now - s.lastUsedAt) / 1000),
			}));
		return {
			featureEnabled: this.enabled,
			browserAvailable: this.enabled && allowInternetAccess,
			persisted,
			history: {
				count: history.length,
				...(history.length > 0 ? { lastVisitedAt: history[history.length - 1].visitedAt } : {}),
			},
			activeSessions,
		};
	}

	/** Most-recent-first list of the agent's recorded visited pages. */
	listHistory(agentId: string): BrowserHistoryEntry[] {
		return [...this.loadHistory(agentId)].reverse();
	}

	/** Close a specific thread's session ONLY if it belongs to this agent (ownership guard). */
	async closeAgentThreadSession(agentId: string, threadId: string): Promise<boolean> {
		const s = this.sessions.get(threadId);
		if (!s || s.agentId !== agentId) return false;
		await this.closeSession(threadId);
		return true;
	}

	/** Close every live session belonging to an agent. Returns how many were closed. */
	async closeAgentSessions(agentId: string): Promise<number> {
		const threadIds = [...this.sessions.entries()]
			.filter(([, s]) => s.agentId === agentId)
			.map(([threadId]) => threadId);
		for (const threadId of threadIds) await this.closeSession(threadId);
		return threadIds.length;
	}

	/** Clear saved logins/cookies: close live sessions, then delete storageState.json. */
	async clearLoginData(agentId: string): Promise<void> {
		await this.closeAgentSessions(agentId);
		this.rmIfExists(this.storageStatePath(agentId));
	}

	/** Clear the agent's recorded history (file + any in-memory buffer). */
	clearHistory(agentId: string): void {
		this.rmIfExists(this.historyPath(agentId));
		for (const s of this.sessions.values()) {
			if (s.agentId === agentId) s.visitedUrls = [];
		}
	}

	/** Full reset: close live sessions + delete storageState + delete history. */
	async resetBrowser(agentId: string): Promise<void> {
		await this.closeAgentSessions(agentId);
		this.rmIfExists(this.storageStatePath(agentId));
		this.rmIfExists(this.historyPath(agentId));
	}

	/** Append the current page (deduping a repeat of the last URL) to this session's buffer. */
	private async recordVisit(session: BrowserSession, page: Page): Promise<void> {
		try {
			if (page.isClosed()) return;
			const url = page.url();
			if (!url || url === 'about:blank') return;
			const last = session.visitedUrls[session.visitedUrls.length - 1];
			if (last && last.url === url) return;
			const title = await page.title().catch(() => '');
			session.visitedUrls.push({ url, title, visitedAt: new Date().toISOString() });
			this.scheduleHistoryFlush(session);
		} catch {
			// history is best-effort
		}
	}

	/** Parse the persisted storageState into a non-secret summary (never returns cookie values). */
	private readPersistedSummary(agentId: string): BrowserSessionStatus['persisted'] {
		const path = this.storageStatePath(agentId);
		if (!existsSync(path)) {
			return { exists: false, cookieCount: 0, origins: [], sizeBytes: 0 };
		}
		try {
			const raw = readFileSync(path, 'utf8');
			const state = JSON.parse(raw) as {
				cookies?: { domain?: string }[];
				origins?: { origin?: string }[];
			};
			const cookies = state.cookies ?? [];
			const domains = new Set<string>();
			for (const c of cookies) if (c.domain) domains.add(c.domain.replace(/^\./, ''));
			for (const o of state.origins ?? []) {
				if (o.origin) {
					try {
						domains.add(new URL(o.origin).hostname);
					} catch {
						domains.add(o.origin);
					}
				}
			}
			return {
				exists: true,
				cookieCount: cookies.length,
				origins: [...domains].sort(),
				lastSavedAt: statSync(path).mtime.toISOString(),
				sizeBytes: Buffer.byteLength(raw),
			};
		} catch {
			return { exists: true, cookieCount: 0, origins: [], sizeBytes: 0 };
		}
	}

	private loadHistory(agentId: string): BrowserHistoryEntry[] {
		const path = this.historyPath(agentId);
		if (!existsSync(path)) return [];
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8'));
			return Array.isArray(parsed) ? (parsed as BrowserHistoryEntry[]) : [];
		} catch {
			return [];
		}
	}

	private saveHistory(agentId: string, entries: BrowserHistoryEntry[]): void {
		mkdirSync(join(this.stateBasePath, agentId), { recursive: true });
		// Write to a sibling temp file then atomically rename over history.json, so a
		// write interrupted by SIGTERM/OOM can never leave a truncated file (which
		// loadHistory would read as [] and the next save would overwrite — wiping all
		// prior history). rename is atomic within the same filesystem/volume.
		const finalPath = this.historyPath(agentId);
		const tmpPath = `${finalPath}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(entries));
		renameSync(tmpPath, finalPath);
	}

	private rmIfExists(path: string): void {
		try {
			if (existsSync(path)) rmSync(path, { force: true });
		} catch (err) {
			logger.warn({ err, path }, '[browser] failed to remove file — non-fatal');
		}
	}

	// ─── Paths ─────────────────────────────────────────────────────────────────

	private storageStatePath(agentId: string): string {
		if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
			throw new Error(`Invalid agentId for browser state path: ${agentId}`);
		}
		return join(this.stateBasePath, agentId, 'storageState.json');
	}

	private historyPath(agentId: string): string {
		if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
			throw new Error(`Invalid agentId for browser history path: ${agentId}`);
		}
		return join(this.stateBasePath, agentId, 'history.json');
	}
}

/** Promise-based delay (no foreground blocking primitives available in scripts). */
function delay(ms: number): Promise<void> {
	return new Promise((res) => {
		const t = setTimeout(res, ms);
		t.unref();
	});
}

/** page.url() guarded against a closed/destroyed page. */
function safeUrl(page: Page): string {
	try {
		return page.url();
	} catch {
		return '';
	}
}

