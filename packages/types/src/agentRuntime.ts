import type { ApiResponse } from './api.js';
import type { SkillRuntimeEntry } from './skill.js';
import type { ChatFile } from './chatFile.js';
import type { Workflow, WorkflowTriggerContext } from './workflow.js';
import type { MissionRuntimeInfo, MissionEvent } from './mission.js';

// ─── Enum mirrors (TypeScript unions matching the pgEnum values) ──────────────

export type AgentThreadStatus = 'idle' | 'running' | 'completed' | 'error';
export type AgentTriggerType = 'chat' | 'cron' | 'webhook' | 'manual' | 'app' | 'agent' | 'mission';
/** Valid trigger kinds — 'chat' is not a trigger, only a thread origin */
export type AgentTriggerKind = 'cron' | 'webhook' | 'manual' | 'app';
export type AgentMessageRole = 'user' | 'assistant' | 'tool_result';

// ─── Thread ───────────────────────────────────────────────────────────────────

/** An agent thread — one execution context (one Docker container spawn) */
export interface AgentThread {
	id: string;
	agentId: string;
	ownerId: string;
	title?: string;
	status: AgentThreadStatus;
	triggerType: AgentTriggerType;
	triggerId?: string;
	triggerPayload?: Record<string, unknown>;
	/**
	 * Current context window occupancy in tokens.
	 * Set to usage.input from the most recent assistant message after each LLM turn.
	 * Unlike total input token sums, this value represents what will actually be sent
	 * to the LLM on the next call. A context compaction feature can reduce this value
	 * without affecting the cumulative total-token / cost metrics.
	 * Null for threads created before this field was introduced.
	 */
	contextTokens?: number;
	/**
	 * True when this thread was created automatically by a workflow execution
	 * (cron / webhook / manual trigger with a workflowId).
	 * False for interactive user chat threads.
	 */
	isWorkflowThread: boolean;
	/**
	 * True when the user has pinned this thread to the top of the sidebar.
	 * Pinned threads sort before unpinned ones; within each group ordering is by updatedAt DESC.
	 */
	isPinned: boolean;
	/**
	 * Agent-to-agent lineage (triggerType === 'agent' threads only).
	 * initiatorAgentId is the agent that sent the message that spawned this thread;
	 * parentThreadId is the thread it was running in. Both undefined for all other threads.
	 */
	initiatorAgentId?: string;
	parentThreadId?: string;
	/**
	 * Ordered chain of agent IDs from the root turn to this thread's initiator.
	 * Server-derived; used for delegation depth/cycle enforcement. Undefined for
	 * non-agent threads.
	 */
	delegationChain?: string[];
	/**
	 * The mission this thread belongs to (triggerType 'mission' wake threads).
	 * Chat messages sent to a thread carrying a missionId run with mission context
	 * and tools attached (owner steering). Undefined for all other threads.
	 */
	missionId?: string;
	createdAt: Date;
	updatedAt: Date;
}

// ─── Message ──────────────────────────────────────────────────────────────────

/**
 * Token usage recorded on assistant messages.
 * Mirrors the usage shape returned by pi-ai's AssistantMessage.
 */
export interface MessageTokenUsage {
	input: number;
	output: number;
	cost: {
		total: number;
	};
}

/** A single message in an agent thread */
export interface AgentMessage {
	id: string;
	threadId: string;
	role: AgentMessageRole;
	/**
	 * pi-ai ContentBlock[] — serialized as JSON.
	 * Each block has a `type` field: 'text' | 'toolCall' | 'thinking' | 'image'
	 */
	content: ContentBlock[];
	/** For tool_result: the toolCallId this result corresponds to */
	toolCallId?: string;
	/** For tool_result: the tool name */
	toolName?: string;
	/** For assistant: token usage and cost (null for other roles) */
	tokenUsage?: MessageTokenUsage;
	createdAt: Date;
}

/**
 * Minimal ContentBlock type — mirrors pi-ai's ContentBlock union.
 * We define it here so frontend/backend can type-check message content
 * without importing pi-ai directly.
 */
export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'thinking'; thinking: string }
	| {
			type: 'toolCall';
			id: string;
			name: string;
			arguments: Record<string, unknown>;
	  }
	| { type: 'image'; data: string; mimeType: string };

// ─── Trigger ──────────────────────────────────────────────────────────────────

/** Cron trigger config */
export interface CronTriggerConfig {
	schedule: string; // cron expression, e.g. "0 9 * * 1-5"
	timezone?: string; // IANA timezone, e.g. "America/New_York"
}

/** Webhook trigger config */
export interface WebhookTriggerConfig {
	/** HMAC-SHA256 secret for verifying X-Hub-Signature-256 header */
	secret: string;
	/**
	 * Whether incoming requests must carry a valid X-Hub-Signature-256 HMAC signature.
	 * Absent means true — existing triggers created before this flag keep requiring signatures.
	 * When false, anyone with the webhook URL can fire the trigger.
	 */
	requireSignature?: boolean;
}

/** Manual trigger config (no fields needed) */
export type ManualTriggerConfig = Record<string, never>;

/**
 * App-based trigger config — fires a workflow when an external app emits an event
 * (e.g. a Gmail message arrives, a Notion DB item changes, a Google Form is submitted).
 *
 * The user-editable intent only. Runtime listening state (cursors, webhook
 * subscription ids, baselines) lives in the separate `agent_triggers.state` jsonb
 * column (see AppTriggerState) so the listener and the user never clobber each other.
 */
export interface AppTriggerConfig {
	/** Provider id from the app-trigger registry, e.g. 'gmail', 'notion', 'slack', 'google-forms' */
	provider: string;
	/** Event id offered by the provider, e.g. 'message.received', 'database.itemChanged' */
	event: string;
	/** Credential used to authenticate listening (poll / subscribe) and outbound calls */
	credentialId: string;
	/** Event-specific parameters validated against the provider event's paramsSchema */
	params: Record<string, unknown>;
	/** Poll cadence in seconds for poll-mode providers — clamped to the provider's minimum */
	pollIntervalSec?: number;
	/**
	 * Pub/Sub topic name for providers that push via Google Cloud Pub/Sub (Gmail).
	 * Falls back to the server-configured default topic when omitted.
	 */
	pubsubTopic?: string;
}

/**
 * Runtime listening state for an app trigger — written by AppTriggerManager, never
 * by the user. Stored in the `agent_triggers.state` jsonb column.
 */
export interface AppTriggerState {
	/** Opaque poll cursor (provider-defined, e.g. last response timestamp) */
	cursor?: unknown;
	/** ISO timestamp of the last successful poll */
	lastPolledAt?: string;
	/** External subscription / watch id returned at registration (webhook providers) */
	subscriptionId?: string;
	/** ISO timestamp at which a webhook subscription must be renewed (e.g. Gmail watch ≤ 7 days) */
	expiresAt?: string;
	/** Verification token captured during a webhook handshake (e.g. Notion) */
	verificationToken?: string;
	/** Baseline history id captured at registration (Gmail Pub/Sub history cursor) */
	baselineHistoryId?: string;
	/** ISO timestamp of the last successful listener activation / webhook registration */
	registeredAt?: string;
	/** Message from the last failed activation / registration (cleared on success) */
	lastRegisterError?: string;
	/**
	 * Whether the last activation actually registered the subscription via the app's API
	 * ('auto') or only set up internal state and requires the user to add the delivery URL
	 * in the app themselves ('manual', e.g. Notion always, Slack without a config token).
	 */
	registrationMode?: 'auto' | 'manual';
}

/**
 * App-trigger registration status surfaced to the builder (kind === 'app' only).
 * `registeredAt` set on a successful activation; `error` set when it failed; `mode`
 * distinguishes a real API registration ('auto') from one needing manual setup ('manual').
 */
export interface AppTriggerRegistrationStatus {
	registeredAt?: string;
	error?: string;
	mode?: 'auto' | 'manual';
	/**
	 * A handshake token the app sent that the user must echo back to confirm the webhook
	 * subscription (e.g. Notion's one-time verification token). Surfaced so the builder can
	 * show it with a copy button instead of burying it in the server logs.
	 */
	verificationToken?: string;
}

export type AgentTriggerConfig =
	| CronTriggerConfig
	| WebhookTriggerConfig
	| ManualTriggerConfig
	| AppTriggerConfig;

/** An agent trigger subscription */
export interface AgentTrigger {
	id: string;
	agentId: string;
	ownerId: string;
	kind: AgentTriggerKind;
	name: string;
	config: AgentTriggerConfig;
	isEnabled: boolean;
	lastFiredAt?: Date;
	description?: string;
	/**
	 * Optional ID of the workflow this trigger executes when fired.
	 * When set: trigger creates a workflow_run and executes the pipeline.
	 * When null/undefined: trigger has no workflow attached.
	 */
	workflowId?: string;
	/**
	 * App-trigger registration status (kind === 'app' only) — surfaced from the
	 * trigger's runtime state so the builder can show whether the automatic webhook
	 * setup succeeded, needs manual completion, or failed.
	 */
	appRegistration?: AppTriggerRegistrationStatus;
	createdAt: Date;
	updatedAt: Date;
}

// ─── Proxy Protocol ───────────────────────────────────────────────────────────

/**
 * Credential proxy request — sent from the agent sandbox to the host.
 * The host resolves the credential and executes the HTTP call on behalf of
 * the sandbox, so raw credential values never enter the container.
 *
 * When `credentialId` is empty or omitted, the host executes the request
 * directly without injecting any authentication. Use this for public APIs.
 */
export interface ProxyRequest {
	/**
	 * ID of the credential to use. Must be in the agent's allowed credential list.
	 * Pass an empty string or omit entirely for public APIs that need no auth.
	 */
	credentialId: string;
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
	url: string;
	/** Additional caller-supplied headers merged with credential-resolved headers */
	headers?: Record<string, string>;
	/** Additional caller-supplied query params merged with credential-resolved params */
	qs?: Record<string, string>;
	/** Request body (raw string — stringify JSON or form data before passing) */
	body?: string;
}

/** Response returned from the credential proxy to the sandbox */
export interface ProxyResponse {
	status: number;
	headers: Record<string, string>;
	/** Raw response body as a string */
	body: string;
}

// ─── LLM Proxy Protocol ───────────────────────────────────────────────────────

/**
 * LLM proxy request — sent from the sandbox to the host's LLM proxy endpoint.
 * The host resolves the LLM API key from the agent's model config and calls
 * the provider. The raw API key never enters the sandbox.
 *
 * The `messages` field mirrors pi-ai Context.messages (JSON-serializable).
 * The `tools` field mirrors pi-ai Tool[] (TypeBox schemas are plain JSON).
 */
export interface LlmProxyRequest {
	messages: unknown[]; // pi-ai Message[] — typed as unknown to avoid pi-ai import in shared types
	systemPrompt: string;
	tools?: unknown[]; // pi-ai Tool[]
	thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

// ─── Browser Protocol ─────────────────────────────────────────────────────────

/**
 * One browser operation sent from the agent sandbox to the host. The host owns
 * the actual browser (a separate, host-managed container or a local Playwright
 * instance) — the sandbox never touches it directly. Element-targeting actions
 * use a `ref` (e.g. "e3") obtained from the most recent `snapshot`/`navigate`
 * result, never raw selectors.
 */
export type BrowserCommand =
	| { action: 'navigate'; url: string }
	| { action: 'snapshot' }
	| { action: 'click'; ref: string }
	| { action: 'type'; ref: string; text: string; submit?: boolean }
	| { action: 'select'; ref: string; values: string[] }
	| { action: 'pressKey'; key: string }
	| { action: 'screenshot'; fullPage?: boolean; path?: string }
	| { action: 'readPage' }
	| { action: 'waitFor'; text?: string; state?: 'load' | 'networkidle'; timeoutMs?: number }
	| { action: 'goBack' }
	| { action: 'goForward' };

/** POST /v1/runtime/internal/browser/action — one browser command per request */
export interface BrowserActionRequest {
	command: BrowserCommand;
}

/**
 * Result of a browser command, returned to the sandbox.
 * A command may yield readable text (title / element snapshot / page text /
 * error description), an image (screenshot), or both, plus the current URL.
 */
export interface BrowserActionResult {
	/** Human/LLM-readable text: page title, element snapshot, extracted text, or an error description. */
	text?: string;
	/** Present only for `screenshot` — base64 PNG, surfaced to the chat as an image block. */
	image?: { data: string; mimeType: 'image/png' };
	/** Current page URL after the action, so the agent keeps its orientation. */
	url?: string;
	/** True when the action failed in a recoverable way (timeout, element not found) — not a fatal error. */
	isError?: boolean;
}

// ─── Sandbox Token ────────────────────────────────────────────────────────────

/**
 * Payload of the PROXY_TOKEN JWT issued to each agent container.
 * Scoped to: one agent, one thread, one set of allowed credentials.
 * TTL: 15 minutes (refreshed if the agent needs more time via a keep-alive call).
 */
export interface SandboxTokenPayload {
	agentId: string;
	ownerId: string;
	threadId: string;
	/** IDs of credentials this sandbox is allowed to use via the proxy */
	credentialIds: string[];
	/**
	 * When true, the sandbox may use ANY credential owned by `ownerId` (not just
	 * those in `credentialIds`). The proxy authorizes by ownership instead of the
	 * agent_credentials junction. Set for agents flagged with `allCredentials`.
	 */
	allCredentials?: boolean;
	/**
	 * Present when this turn belongs to a mission (autonomous wake OR owner steering
	 * chat on a mission thread). Authorizes the /internal/mission/* endpoints and
	 * attributes LLM cost to the mission's budget. Never taken from a request body.
	 */
	missionId?: string;
	iat: number;
	exp: number;
}

/**
 * Minimal credential descriptor passed to the sandbox so the agent can
 * identify which credential belongs to which service.
 * Contains no secrets — only display metadata.
 */
export interface CredentialMeta {
	/** UUID used as credentialId in call_api */
	id: string;
	/** Human-readable name the user gave this credential (e.g. "My GitHub Token") */
	name: string;
	/**
	 * Integration definition ID — matches the YAML filename (e.g. "github",
	 * "google-workspace", "openweathermap"). Tells the agent which service
	 * this credential was created for.
	 */
	integration: string;
	/**
	 * OAuth2 scope string from the integration definition (space-separated scopes).
	 * Only present for OAuth2 credentials that declare a scope in their YAML.
	 * The agent must restrict API calls to operations covered by these scopes.
	 * Absent for non-OAuth2 credentials or OAuth2 credentials with no declared scope.
	 */
	scopes?: string;
	/**
	 * Non-secret credential properties (string/number/boolean fields, never `secret`-typed).
	 * Contains values like `baseUrl`, `host`, `port` that the agent needs to construct
	 * API request URLs. Secret-typed fields (API keys, tokens, passwords) are never included.
	 * Only present when the credential definition has non-secret properties.
	 */
	properties?: Record<string, string>;
}

/**
 * Agent runtime config delivered to the sandbox on startup.
 * Contains everything the agent-runtime needs to operate — no secrets.
 */
export interface AgentRuntimeConfig {
	agentId: string;
	/** Owner of this agent — required by host to scope memory embedding calls */
	ownerId: string;
	threadId: string;
	name: string;
	systemInstruction: string;
	/** Provider + model metadata — no API key */
	modelProvider: string;
	modelId: string;
	/** IDs of credentials available to this agent (used when calling the proxy) */
	credentialIds: string[];
	/**
	 * Rich credential metadata — includes name and integration for each credential.
	 * Used by the system prompt so the agent knows which credential belongs to
	 * which service. Replaces the UUID-only credentialIds list in the prompt.
	 */
	credentials: CredentialMeta[];
	/**
	 * Skills assigned to this agent — compact index only (name, description,
	 * workspace-relative SKILL.md path). Full instructions are materialized
	 * into <workspace>/skills/<name>/ by the backend before spawn; the agent
	 * reads them on demand via read_file (progressive disclosure).
	 */
	skills?: SkillRuntimeEntry[];
	/**
	 * LLM provider config ID used for memory embeddings.
	 * Null/empty means memory tools are unavailable for this agent.
	 */
	embeddingModelConfigId?: string;
	/**
	 * Knowledge base summary — present when the agent has ready knowledge
	 * assignments. fileNames is capped at 20 entries; used only to build the
	 * system-prompt note telling the agent to retrieve content via memory_search.
	 */
	knowledgeBase?: { fileCount: number; fileNames: string[] };
	triggerType: AgentTriggerType;
	triggerPayload?: Record<string, unknown>;
	/**
	 * ISO 8601 datetime string with timezone offset representing the user's local
	 * date and time at the moment the message was sent.
	 * Falls back to server time if absent (e.g. non-chat triggers like cron/webhook).
	 */
	userDatetime?: string;
	/**
	 * Maximum number of tool calls allowed in a single chat turn. Read by
	 * agent-runner.ts to size both the hard cap (beforeToolCall) and the
	 * proactive tool-budget notice. Optional for backward compatibility —
	 * the runner falls back to 20 when absent. Workflow runs ignore this.
	 */
	maxToolCallsPerTurn?: number;
	/**
	 * Whether the browser tools (browser_navigate, browser_click, …) are available
	 * for this turn. The backend sets this to `true` only when the agent has
	 * internet access AND the project-wide browser feature is enabled. When absent
	 * or false, agent-runner does not register any browser tools. This is the
	 * UX/defense-in-depth layer of the gate — the authoritative check is a live DB
	 * read on every browser action in the backend (BrowserService).
	 */
	browserAvailable?: boolean;
	/**
	 * Whether the render_ui tool (OpenUI generative UI) is available for this
	 * turn. The backend sets this to `true` only for chat turns originating from
	 * the web channel — external channels (telegram/discord) can't display
	 * interactive UI and cron/webhook/workflow runs have no viewer, so the tool
	 * is never registered there and those turns stay plain-text.
	 */
	uiRenderingAvailable?: boolean;
	/**
	 * Whether the agent-to-agent messaging tools (list_agents, send_to_agent,
	 * ask_agent) are available for this turn. The backend sets this to `true` only
	 * when the agent has at least one collaborator in its allow-list. When absent or
	 * false, agent-runner registers no A2A tools. This is the UX/registration layer —
	 * the authoritative allow-list + depth/cycle checks run host-side on every call.
	 */
	agentMessagingAvailable?: boolean;
	/**
	 * Ordered chain of agent IDs from the root human turn down to (and including) the
	 * initiator of this thread — present only for agent-initiated threads. Carried so
	 * the target's own A2A calls extend the same chain (the host re-derives and
	 * re-validates it from the thread row; this copy is informational for the runtime).
	 */
	delegationChain?: string[];
	/**
	 * Present only for workflow runs (triggerType !== 'chat').
	 * Contains the full workflow definition (steps, etc.) and the normalized
	 * trigger context (type, triggerName, firedAt, payload) for the run.
	 * When present, workflow-runner.ts handles execution instead of agent-runner.ts.
	 */
	workflow?: {
		runId: string;
		definition: Workflow;
		triggerContext: WorkflowTriggerContext;
	};
	/**
	 * Present when this turn belongs to a mission — either an autonomous wake
	 * (triggerType 'mission') or an owner steering chat on a mission thread
	 * (triggerType 'chat' + missionChatMode). Gates the mission_* tools and
	 * feeds the mission prompt section (goal, plan document, budget, journal).
	 */
	mission?: MissionRuntimeInfo;
	/**
	 * True when this is an interactive chat turn on a mission thread (the owner
	 * steering the mission between wakes). Mission tools stay available and the
	 * prompt tells the agent to persist owner instructions into its plan document;
	 * ask_human remains registered (a human IS present, unlike autonomous wakes).
	 */
	missionChatMode?: boolean;
}

// ─── SSE Event types (host → browser) ────────────────────────────────────────

// ─── HITL Protocol ────────────────────────────────────────────────────────────

/**
 * HITL request payload — sent from the agent sandbox to the host.
 * The host holds an open HTTP connection until the human responds.
 */
export interface HitlRequest {
	/** The question or instruction shown to the human operator */
	prompt: string;
	/**
	 * Optional list of pre-defined choices to present as buttons.
	 * If absent the human may type any free-form response.
	 */
	options?: string[];
}

/** HITL response returned from the host to the sandbox once the human replies */
export interface HitlResponse {
	/** The human operator's response text */
	response: string;
}

// ─── Agent-to-Agent (A2A) Messaging Protocol ──────────────────────────────────

/**
 * A collaborator agent the current agent is allowed to message — display metadata
 * only, returned by GET /v1/runtime/internal/agents and surfaced by the list_agents
 * tool. Contains no secrets or credential info.
 */
export interface AgentCollaboratorSummary {
	id: string;
	name: string;
	description?: string;
}

/**
 * A2A message request — sent from the agent sandbox to the host to message another
 * agent it is allowed to talk to. `agentId` from the PROXY_TOKEN is the sender; the
 * target agent id is a route parameter.
 */
export interface AgentMessageRequest {
	/** The message/instruction to deliver to the target agent */
	message: string;
	/**
	 * Optional brief background from the caller's current task — appended to the
	 * delivered message so the target has what it needs without the caller's full
	 * conversation history.
	 */
	context?: string;
}

/** Response from POST /internal/agent/:targetAgentId/message (async hand-off) */
export interface AgentMessageResult {
	/** The thread created for the target agent's run — useful for a deep link */
	threadId: string;
	/**
	 * Absolute URL of the target thread in the web app, built host-side from APP_URL.
	 * Absolute (not root-relative) so the link survives delivery on external channels
	 * (telegram/discord) where a relative path would be dead.
	 */
	threadUrl?: string;
}

/**
 * Response from POST /internal/agent/:targetAgentId/ask — the ask is accepted and
 * the target spawned; the caller polls GET /internal/agent/ask/:threadId for the
 * outcome. (Polling rather than a held connection: undici's default 5-minute
 * headersTimeout would kill any longer delegation on a buffered long-poll response.)
 */
export interface AgentAskStartResult {
	/** The target thread to poll for the result */
	threadId: string;
}

/** Response from GET /internal/agent/ask/:threadId (poll a pending ask) */
export type AgentAskPollResult =
	| { status: 'running' }
	| { status: 'completed'; response: string; threadId: string }
	| { status: 'error'; error: string };

/** Final result surfaced by the ask_agent tool once polling settles */
export interface AgentAskResult {
	/** The target agent's final text output */
	response: string;
	/** The target thread that produced the response */
	threadId: string;
}

/** Discriminated union of all SSE events streamed to the browser */
export type AgentStreamEvent =
	| { type: 'message_start'; messageId: string; role: 'assistant' }
	| { type: 'text_delta'; messageId: string; delta: string }
	| { type: 'thinking_delta'; messageId: string; delta: string }
	/**
	 * Emitted when the LLM starts deciding on a tool call.
	 * toolName is populated when the provider announces it up front (most do);
	 * it may still be empty for providers that reveal the name later — the
	 * final tool_call_delta always carries it.
	 */
	| { type: 'tool_call_start'; messageId: string; toolCallId: string; toolName: string }
	/**
	 * Snapshot of the render_ui tool's `code` argument while the LLM is still
	 * streaming it, so the web UI can render the interface progressively.
	 * toolCallId is the PLACEHOLDER id from tool_call_start (contentIndex as
	 * string); snapshots are cumulative and idempotent — the final
	 * tool_call_delta supersedes them. Throttled server-side (~120ms).
	 */
	| { type: 'render_ui_partial'; messageId: string; toolCallId: string; code: string }
	/**
	 * Emitted when the LLM finishes forming a tool call.
	 * Carries the real toolCallId, the tool name, and the JSON-formatted arguments
	 * (the "thinking context" — what the agent decided to pass to the tool).
	 */
	| {
			type: 'tool_call_delta';
			messageId: string;
			/** Temporary placeholder id used in tool_call_start (contentIndex as string) */
			placeholderId: string;
			/** The real tool call id assigned by the LLM provider */
			toolCallId: string;
			toolName: string;
			/** Pretty-printed JSON of the arguments the LLM chose to pass */
			argsJson: string;
	  }
	/**
	 * Emitted when the tool has finished executing and a result is available.
	 * result contains the raw tool execution output returned to the agent.
	 * images carries any image content blocks the tool returned (e.g. a browser
	 * screenshot) so the chat UI can render them live — the `result` string is
	 * text-only, so without this the image would only appear after a reload.
	 */
	| {
			type: 'tool_call_end';
			messageId: string;
			toolCallId: string;
			result: string;
			images?: { data: string; mimeType: string }[];
	  }
	/**
	 * Emitted when the agent shares a file back to the user via the share_file
	 * tool. Carries the persisted ChatFile metadata so the chat UI can render the
	 * attachment live (image inline / chip → preview sidebar) under the message
	 * identified by `file.messageId`. Bytes are fetched via the file serving route.
	 */
	| { type: 'file_shared'; file: ChatFile }
	| { type: 'message_end'; messageId: string; usage?: MessageTokenUsage }
	/**
	 * Emitted when the agent invokes the ask_human tool.
	 * The frontend should unlock ChatInput so the user can respond,
	 * and render a visual indicator that the agent is waiting.
	 */
	| { type: 'hitl_request'; prompt: string; options?: string[] }
	/**
	 * Emitted on the CALLING agent's thread while a synchronous ask_agent delegation
	 * is in flight. 'started' fires when the target agent begins working; 'completed'
	 * or 'error' fires when its run settles. The chat UI shows a "waiting for
	 * «agent»" indicator between the two.
	 */
	| {
			type: 'agent_delegation';
			state: 'started' | 'completed' | 'error';
			targetAgentId: string;
			targetAgentName: string;
			targetThreadId: string;
	  }
	/**
	 * Emitted after the 2nd user message when an auto-generated title
	 * has been saved to the thread. The frontend should update the sidebar.
	 */
	| { type: 'thread_title_updated'; threadId: string; title: string }
	/**
	 * Emitted on the AgentStreamBus keyed by MISSION id (not thread id) whenever a
	 * mission journal entry is appended. Powers live updates on the mission detail
	 * page. Never reaches chat/thread subscribers — mission events only emit on
	 * missionId keys, which never collide with threadId keys.
	 */
	| { type: 'mission_event'; missionId: string; event: MissionEvent }
	| { type: 'error'; message: string }
	| { type: 'done' };

// ─── Request/Response bodies ──────────────────────────────────────────────────

/** POST /v1/runtime/:agentId/threads — create a new chat thread */
export interface CreateThreadRequestBody {
	ownerId: string;
	title?: string;
}

/** POST /v1/runtime/:agentId/threads/:threadId/messages — send a user message */
export interface SendMessageRequestBody {
	ownerId: string;
	content: string; // plain text; backend wraps in ContentBlock[]
	/**
	 * IDs of chat_files previously uploaded to this thread (via the file upload
	 * route) to attach to this message. The backend resolves each to a stored
	 * file, injects its content into the prompt (image block / extracted text),
	 * and links it to the persisted user message.
	 */
	fileIds?: string[];
}

/** POST /v1/runtime/:agentId/triggers — create a trigger */
export interface CreateTriggerRequestBody {
	ownerId: string;
	kind: AgentTriggerKind;
	name: string;
	config: AgentTriggerConfig;
	description?: string;
}

/** PUT /v1/runtime/:agentId/triggers/:triggerId — update a trigger */
export interface UpdateTriggerRequestBody {
	name?: string;
	config?: AgentTriggerConfig;
	isEnabled?: boolean;
	description?: string;
}

// ─── API Response Envelopes ───────────────────────────────────────────────────

export type AgentThreadResponse = ApiResponse<AgentThread>;
export type AgentThreadsListResponse = ApiResponse<AgentThread[]>;
export type AgentThreadDeleteResponse = ApiResponse<{ deleted: boolean }>;
export type AgentMessageResponse = ApiResponse<AgentMessage>;
export type AgentMessagesListResponse = ApiResponse<AgentMessage[]>;
export type AgentTriggerResponse = ApiResponse<AgentTrigger>;
export type AgentTriggersListResponse = ApiResponse<AgentTrigger[]>;
export type AgentTriggerDeleteResponse = ApiResponse<{ deleted: boolean }>;

/** PATCH /v1/runtime/:agentId/threads/:threadId — rename a thread */
export interface RenameThreadRequestBody {
	title: string;
}
