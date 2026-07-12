import dns from 'node:dns';
import express from 'express';
import { logger } from './config/logger.js';
import { corsMiddleware } from './middleware/cors.js';
import { rateLimiter } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { healthRouter } from './routes/health.js';
import { createCredentialsRouter } from './routes/credentials.js';
import { createMcpServersRouter } from './routes/mcpServers.js';
import { createOAuth2Router } from './routes/oauth2.js';
import { createLlmProvidersRouter } from './routes/llmProviders.js';
import { startModelCatalogRefresh } from './services/llm/modelCatalog.js';
import { createAuthRouter } from './routes/auth.js';
import { createUsersRouter } from './routes/users.js';
import { createApiKeysRouter } from './routes/apiKeys.js';
import { createIamRouter } from './routes/iam.js';
import { createAgentsRouter } from './routes/agents.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createSkillsRouter } from './routes/skills.js';
import { createRuntimeRouter } from './routes/runtime.js';
import { createWebhooksRouter } from './routes/webhooks.js';
import { createWorkflowsRouter, createGlobalWorkflowsRouter } from './routes/workflows.js';
import { createAppTriggersRouter } from './routes/appTriggers.js';
import { createChannelsRouter } from './routes/channels.js';
import { createKnowledgeRouter, createAgentKnowledgeRouter } from './routes/knowledge.js';
import { createAgentBrowserRouter } from './routes/browser.js';
import { KnowledgeBaseService } from './services/KnowledgeBaseService.js';
import { CloudProviderRegistry } from './services/knowledge/providerRegistry.js';
import { ChannelService } from './services/ChannelService.js';
import { MessagePipeline } from './channels/pipeline.js';
import { ContentProcessor } from './channels/processor.js';
import { WebAdapter } from './channels/web/adapter.js';
import { TelegramPollerManager } from './channels/telegram/poller-manager.js';
import { DiscordGatewayManager } from './channels/discord/gateway-manager.js';
import { UserService } from './services/UserService.js';
import { AuthService } from './services/AuthService.js';
import { EncryptionService } from './services/EncryptionService.js';
import { CredentialService } from './services/CredentialService.js';
import { CredentialResolverService } from './services/CredentialResolverService.js';
import { AgentService } from './services/AgentService.js';
import { AgentMemoryService } from './services/AgentMemoryService.js';
import { LlmProviderService } from './services/LlmProviderService.js';
import { AgentSessionService } from './services/AgentSessionService.js';
import { agentStreamBus } from './services/AgentStreamBus.js';
import { AgentProxyService } from './services/AgentProxyService.js';
import { AgentLlmProxyService } from './services/AgentLlmProxyService.js';
import { AgentRuntimeService } from './services/AgentRuntimeService.js';
import { AgentMessagingService } from './services/AgentMessagingService.js';
import { BrowserService } from './services/BrowserService.js';
import { McpService } from './services/McpService.js';
import { ChatFileService } from './services/ChatFileService.js';
import { ProcessDriver } from './services/runtime/ProcessDriver.js';
import { DockerDriver } from './services/runtime/DockerDriver.js';
import type { ExecutionDriver } from './services/runtime/ExecutionDriver.js';
import { TriggerService } from './services/TriggerService.js';
import { AppTriggerProviderRegistry } from './services/triggers/AppTriggerProviderRegistry.js';
import { AppTriggerManager } from './services/triggers/AppTriggerManager.js';
import { WorkflowService } from './services/WorkflowService.js';
import { WorkflowRunService } from './services/WorkflowRunService.js';
import { SkillService } from './services/SkillService.js';
import { SkillInstallService } from './services/SkillInstallService.js';
import { SkillMaterializerService } from './services/SkillMaterializerService.js';
import { SkillEvolutionService } from './services/SkillEvolutionService.js';
import { MissionService } from './services/MissionService.js';
import { MissionSchedulerService } from './services/MissionSchedulerService.js';
import { NotificationService } from './services/NotificationService.js';
import { OutboundDeliveryService } from './services/OutboundDeliveryService.js';
import { createMissionsRouter } from './routes/missions.js';
import { createNotificationsRouter } from './routes/notifications.js';

// Prefer IPv4 for all outbound connections (fetch/undici, ws). Node's fetch does
// not fall back to IPv4 when an IPv6 connect hangs (no Happy Eyeballs), so flaky
// IPv6 routes cause 10s connect timeouts to dual-stack hosts like api.telegram.org.
dns.setDefaultResultOrder('ipv4first');

// --- Validate required environment variables at startup ---
const { JWT_SECRET, JWT_EXPIRES_IN, PROXY_TOKEN_SECRET } = process.env;
if (!JWT_SECRET || !JWT_EXPIRES_IN) {
	throw new Error('Missing required env vars: JWT_SECRET and JWT_EXPIRES_IN must be set');
}
if (!PROXY_TOKEN_SECRET) {
	throw new Error('Missing required env var: PROXY_TOKEN_SECRET must be set');
}

// --- Instantiate shared services ---
const userService = new UserService();
const authService = new AuthService(userService, JWT_SECRET, JWT_EXPIRES_IN);

// --- Instantiate runtime services ---
// EncryptionService reads CREDENTIAL_ENCRYPTION_KEY from env and throws if missing
const encryptionService = new EncryptionService();
const credentialService = new CredentialService(encryptionService);
const credentialResolverService = new CredentialResolverService(credentialService);
const agentService = new AgentService();
const llmProviderService = new LlmProviderService(encryptionService);
const agentMemoryService = new AgentMemoryService(
	agentService,
	llmProviderService,
	encryptionService,
);
const sessionService = new AgentSessionService();
const proxyService = new AgentProxyService(credentialResolverService, PROXY_TOKEN_SECRET);
// Mission persistence + budget accounting. Constructed early because both the
// LLM proxy (cost attribution + budget backstop) and the runtime service
// (mission context for wakes and owner steering chats) depend on it.
const missionService = new MissionService();
const llmProxyService = new AgentLlmProxyService(
	proxyService,
	agentService,
	llmProviderService,
	encryptionService,
	agentStreamBus,
	sessionService,
	agentMemoryService,
	missionService,
);
// --- Instantiate skill services ---
// SkillService: merged catalog (builtin + installed) and assignment management.
// SkillInstallService: GitHub fetch + validation + scan + install (preview/confirm).
// SkillMaterializerService: writes assigned skills into agent workspaces at spawn.
// SkillEvolutionService: background reflection worker (cron) over execution traces.
const skillService = new SkillService();
const skillInstallService = new SkillInstallService(skillService);
const skillMaterializerService = new SkillMaterializerService(skillService);
const skillEvolutionService = new SkillEvolutionService(
	agentService,
	llmProviderService,
	skillService,
);

// --- Instantiate knowledge-base services ---
// CloudProviderRegistry: pluggable cloud storage providers (Google Drive, Dropbox, OneDrive).
// KnowledgeBaseService: user-level knowledge library + per-agent assignment ingestion
// (extract → chunk → embed → agent_memory rows flagged isKnowledgeBase).
const cloudProviderRegistry = new CloudProviderRegistry(credentialResolverService);
const knowledgeBaseService = new KnowledgeBaseService(
	agentService,
	agentMemoryService,
	cloudProviderRegistry,
	credentialService,
);

// Execution driver — how agent runtimes are isolated:
//   process (default) — plain Node.js child process, code-level isolation only.
//   docker            — hardened sibling Docker container (recommended; set in
//                       docker-compose). Requires the runtime image and a
//                       reachable Docker daemon (DOCKER_HOST or docker.sock).
const executionDriver: ExecutionDriver =
	process.env.AGENT_RUNTIME_DRIVER === 'docker' ? new DockerDriver() : new ProcessDriver();
// Instantiated before runtimeService so the runtime can reconcile an orphaned
// workflow run (mark it 'error') if a runtime dies before reporting completion.
const workflowRunService = new WorkflowRunService();
// Host-managed headless browser. NO-OP unless BROWSER_FEATURE_ENABLED=true.
// Passed into runtimeService so turn-end (onClose) can close the browser context
// and persist its storageState; passed into the runtime router for /internal/browser.
const browserService = new BrowserService(agentService);
// MCP client — holds the live per-server connection pool (shared with the runtime
// proxy) and stores encrypted server credentials. Tools reach the sandbox as
// metadata only; secrets/connections stay host-side.
const mcpService = new McpService(encryptionService);
// Chat file uploads + agent-shared files (bytes on the backend-owned host volume).
const chatFileService = new ChatFileService(agentService, llmProviderService);
const runtimeService = new AgentRuntimeService(
	executionDriver,
	sessionService,
	proxyService,
	agentService,
	llmProviderService,
	credentialService,
	skillMaterializerService,
	knowledgeBaseService,
	workflowRunService,
	browserService,
	chatFileService,
	missionService,
	mcpService,
);

// Agent-to-agent messaging — authorizes an agent messaging another (collaborator
// allow-list + delegation depth/cycle guards) and spawns the target via runtimeService.
const agentMessagingService = new AgentMessagingService(
	agentService,
	sessionService,
	runtimeService,
);

// --- Instantiate channel services ---
const channelService = new ChannelService();
const contentProcessor = new ContentProcessor();
const webAdapter = new WebAdapter();
// messagePipeline is constructed here so it is accessible to both the runtime
// router (which calls pipeline.process() for the web POST /messages handler)
// and the channel pollers/gateways. The pipeline holds no per-request state
// so it is safe to share as a singleton. Each caller passes the adapter that
// received the message, so responses route back through the correct bot.
const messagePipeline = new MessagePipeline(
	sessionService,
	runtimeService,
	proxyService,
	llmProxyService,
	agentService,
	contentProcessor,
	chatFileService,
);

// TelegramPollerManager — starts long-polling loops for all active bot credentials.
// Instantiated here (not in the route) because it needs access to the pipeline
// which is wired before routes are mounted.
const telegramPollerManager = new TelegramPollerManager(
	credentialService,
	channelService,
	agentService,
	sessionService,
	messagePipeline,
	chatFileService,
	llmProxyService,
);

// DiscordGatewayManager — starts Gateway WebSocket connections for all active bot credentials.
// Same pattern as TelegramPollerManager but uses Discord's WebSocket Gateway instead of polling.
const discordGatewayManager = new DiscordGatewayManager(
	credentialService,
	channelService,
	agentService,
	sessionService,
	messagePipeline,
	chatFileService,
	llmProxyService,
);

// --- Instantiate mission delivery + scheduler ---
// OutboundDeliveryService: proactive pushes to the owner (in-app notification row
// always; Telegram/Discord best-effort via the channel managers' running adapters).
// MissionSchedulerService: the autonomous wake loop (DB next_wake_at + 30s sweep).
const notificationService = new NotificationService();
const outboundDeliveryService = new OutboundDeliveryService(
	notificationService,
	channelService,
	telegramPollerManager,
	discordGatewayManager,
);
const missionSchedulerService = new MissionSchedulerService(
	missionService,
	runtimeService,
	sessionService,
	outboundDeliveryService,
	llmProxyService,
);

// --- Instantiate workflow services ---
// workflowRunService is constructed earlier (wired into runtimeService).
const workflowService = new WorkflowService();

// TriggerService now accepts WorkflowService + WorkflowRunService for workflow routing
const triggerService = new TriggerService(
	runtimeService,
	sessionService,
	workflowService,
	workflowRunService,
);

// App-trigger system — data-driven providers (Gmail/Notion/Slack/Google Forms) that listen
// for external events (poll / push webhook / stream) and funnel each into a workflow run via
// TriggerService.fireAppEvent(). The manager owns the in-memory listeners; the agent_triggers
// row (kind='app') is the durable record. Independent of the channels system.
const appTriggerRegistry = new AppTriggerProviderRegistry();
const appTriggerManager = new AppTriggerManager(
	appTriggerRegistry,
	credentialResolverService,
	credentialService,
	triggerService,
);

const app = express();
const PORT = process.env.BACKEND_PORT ?? 4000;

// Number of trusted reverse proxy hops in front of this app (e.g. 1 for nginx).
// Must be a number — express-rate-limit v8 rejects the boolean `true` because it
// allows clients to spoof X-Forwarded-For and bypass IP-based rate limiting.
// Use 0 for local dev (no proxy), 1 for a single nginx/load-balancer hop, etc.
app.set('trust proxy', parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10));

// --- Global middleware ---
app.use(corsMiddleware);

// Mounted before the rate limiter too — external services deliver at arbitrary
// frequency (this replaces the old /v1/webhooks/ rate-limiter exclusion).
app.use('/v1/webhooks', createWebhooksRouter(triggerService, appTriggerManager));

// Global JSON parser (10mb) for browser-facing routes. Sandbox-internal routes
// (/v1/runtime/internal/*) are EXEMPTED here and parse their own body with a much
// larger limit in the runtime router — an LLM stream request can carry image
// content blocks (base64 uploads) that exceed 10mb. They are PROXY_TOKEN-gated and
// only called by agent runtimes, so the larger limit is not browser-reachable.
const globalJsonParser = express.json({ limit: '10mb' });
app.use((req, res, next) => {
	if (req.path.startsWith('/v1/runtime/internal/')) return next();
	return globalJsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

// Rate limiter — applied globally with public endpoint exclusions
app.use((req, res, next) => {
	const excluded = [
		/^\/v1\/auth\/status$/,
		/^\/v1\/auth\/setup$/,
		/^\/v1\/health$/,
		// OAuth2 callback must remain public — the provider redirects here without a token
		/^\/v1\/oauth2\/callback$/,
		// Note: /v1/webhooks/ is mounted before this middleware (raw-body requirement),
		// so it never reaches the rate limiter and needs no exclusion here.
		// Sandbox-internal endpoints are called by agent child processes (localhost),
		// not by browser clients. All sandbox calls originate from 127.0.0.1, so they
		// would all share a single IP bucket and exhaust it quickly during active turns
		// (llm/stream + proxy + message appends + memory writes + workflow step logs per turn).
		// These routes are already secured by PROXY_TOKEN verification — rate limiting adds no value.
		/^\/v1\/runtime\/internal\//,
		// SSE stream endpoint — the browser holds this connection open for the duration
		// of an agent turn. Reconnects (network drops, tab focus events) count against
		// the per-IP limit. Excluding it prevents false-positive 429s on the stream.
		// The endpoint itself is protected by requireAuth (JWT/API-key).
		/^\/v1\/runtime\/[^/]+\/threads\/[^/]+\/stream$/,
		// Dashboard aggregation endpoints back the home page, which fans out several
		// reads (and may poll) on every visit. They are read-only and protected by
		// requireAuth, so excluding them avoids false-positive 429s during normal use.
		/^\/v1\/dashboard\//,
	];
	if (excluded.some((p) => p.test(req.path))) return next();
	return rateLimiter(req, res, next);
});

// --- v1 routes ---
app.use('/v1/health', healthRouter);
app.use(
	'/v1/credentials',
	createCredentialsRouter(authService, (credentialId) => {
		// Stop any channel bot poller/gateway still running on the deleted
		// credential's token. Both calls are no-ops if nothing is tracked.
		telegramPollerManager.stopPoller(credentialId);
		discordGatewayManager.stopGateway(credentialId);
		// Stop any app triggers (poll/webhook/stream) using the deleted credential.
		void appTriggerManager.stopByCredential(credentialId);
	}),
);
app.use('/v1/mcp-servers', createMcpServersRouter(authService, mcpService));
app.use('/v1/oauth2', createOAuth2Router(authService));
app.use('/v1/llm-providers', createLlmProvidersRouter(authService));
app.use('/v1/auth', createAuthRouter(authService));
app.use('/v1/users', createUsersRouter(authService));
app.use('/v1/api-keys', createApiKeysRouter(authService));
app.use('/v1/iam', createIamRouter(authService));
app.use('/v1/agents', createAgentsRouter(authService, skillService));
app.use(
	'/v1/dashboard',
	createDashboardRouter(authService, sessionService, workflowRunService, missionService),
);
app.use('/v1/skills', createSkillsRouter(authService, skillService, skillInstallService));

// Knowledge library routes — user-level files + cloud provider browsing
app.use(
	'/v1/knowledge',
	createKnowledgeRouter(
		authService,
		knowledgeBaseService,
		cloudProviderRegistry,
		credentialService,
	),
);
// Agent knowledge assignments — scoped under agents (mergeParams, like workflows)
app.use(
	'/v1/agents/:agentId/knowledge',
	createAgentKnowledgeRouter(authService, knowledgeBaseService),
);

// Agent browser-session management (owner-facing) — scoped under agents (mergeParams)
app.use(
	'/v1/agents/:agentId/browser',
	createAgentBrowserRouter(authService, agentService, browserService),
);

// Runtime routes — user-facing + sandbox-internal (PROXY_TOKEN auth)
app.use(
	'/v1/runtime',
	createRuntimeRouter(
		authService,
		sessionService,
		runtimeService,
		proxyService,
		llmProxyService,
		triggerService,
		agentMemoryService,
		workflowRunService,
		workflowService,
		messagePipeline,
		webAdapter,
		skillService,
		browserService,
		mcpService,
		chatFileService,
		agentMessagingService,
		missionService,
		outboundDeliveryService,
		missionSchedulerService,
	),
);

// Channel management routes — pairing codes and channel links
app.use(
	'/v1/channels',
	createChannelsRouter(
		authService,
		channelService,
		agentService,
		credentialService,
		telegramPollerManager,
		discordGatewayManager,
	),
);

// Workflow routes — scoped under agents (GET/POST /v1/agents/:agentId/workflows/...)
// triggerService is passed so cron jobs are scheduled immediately on create/update/delete
// (WorkflowService manages trigger DB rows directly to avoid a circular dep, so it
// cannot call TriggerService itself — the route layer bridges that gap).
app.use(
	'/v1/agents/:agentId/workflows',
	createWorkflowsRouter(
		authService,
		workflowService,
		workflowRunService,
		triggerService,
		appTriggerManager,
	),
);

// Mission routes — autonomous long-term goals, scoped under agents (mergeParams)
app.use(
	'/v1/agents/:agentId/missions',
	createMissionsRouter(authService, missionService, missionSchedulerService, runtimeService),
);

// Notification routes — the web app's notification bell
app.use('/v1/notifications', createNotificationsRouter(authService, notificationService));

// Global workflow routes — owner-wide read-only listing for the top-level workflows page
app.use('/v1/workflows', createGlobalWorkflowsRouter(authService, workflowService));

// App-trigger catalog — providers + events + param schemas + dynamic resource listings
app.use(
	'/v1/app-triggers',
	createAppTriggersRouter(
		authService,
		appTriggerRegistry,
		credentialResolverService,
		credentialService,
		appTriggerManager,
	),
);

// Global error handler — must be registered last, after all routes
app.use(errorHandler);

// Validate the execution driver before accepting traffic — a misconfigured
// docker driver (missing image, unreachable daemon) must fail the boot, not
// the first user message.
await runtimeService.init();

// Prepare the browser provider (pull image + reap orphans in container mode).
// A NO-OP when BROWSER_FEATURE_ENABLED != true — no image is pulled and no
// container is started on a default deployment. Runs after the execution driver
// init() so the runtime network it shares already exists.
await browserService.init();

app.listen(PORT, async () => {
	logger.info({ port: PORT, runtimeDriver: executionDriver.name }, '[backend] server running');
	// Knowledge rows left 'processing' by a previous crash can never complete —
	// flip them to 'error' so users get an actionable state instead of a stuck spinner
	await knowledgeBaseService.failInterruptedProcessing();
	// Load and schedule all enabled cron triggers on startup
	await triggerService.loadAll();
	// Recover missions stranded without a wake time (crash mid-wake), then start
	// the mission sweep loop — the schedule itself lives in the DB (next_wake_at).
	await missionSchedulerService.recoverOnBoot();
	missionSchedulerService.start();
	// Activate all enabled app triggers (poll timers / webhook subscriptions / stream conns)
	await appTriggerManager.loadActive();
	// Start Telegram long-polling for all active bot credentials
	await telegramPollerManager.loadActivePollers();
	// Start Discord Gateway connections for all active bot credentials
	await discordGatewayManager.loadActiveGateways();
	// Schedule the skill evolution worker (SKILL_EVOLUTION_CRON, default every 6h)
	skillEvolutionService.start();
	// Seed + schedule the daily live model-catalog refresh from models.dev (non-blocking;
	// falls back to the generated @repo/models baseline on any failure).
	startModelCatalogRefresh();
});

// Kill all live agent runtimes on shutdown so containers/processes are not
// stranded across restarts (driver init() reaps any survivors as a backstop).
let shuttingDown = false;
const gracefulShutdown = async (signal: string): Promise<void> => {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ signal }, '[backend] shutting down');
	// Stop the mission sweep loop — due missions are picked up again on next boot.
	missionSchedulerService.stop();
	// Clear app-trigger timers + stream connections before exiting.
	void appTriggerManager.stopAll();
	// Close browser sessions (flush visited-URL history + save storageState) and stop
	// the browser container. AWAITED before exit so an in-flight session's history is
	// persisted — but bounded so a stuck browser/container teardown can't block SIGTERM
	// until Docker escalates to SIGKILL (and loses the writes anyway).
	const withTimeout = (p: Promise<unknown>, ms: number): Promise<unknown> =>
		Promise.race([
			p.catch(() => undefined),
			new Promise<void>((res) => {
				const t = setTimeout(res, ms);
				t.unref();
			}),
		]);
	await withTimeout(browserService.shutdown(), 8000);
	void runtimeService.shutdown().finally(() => process.exit(0));
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
