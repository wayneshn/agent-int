import type { ApiResponse } from './api.js';

// ─── Memory Type ──────────────────────────────────────────────────────────────

/**
 * Four-layer memory classification based on cognitive memory research.
 *
 * - episodic:   Raw records of events (conversation logs, task outcomes)
 * - semantic:   Distilled facts and long-term domain knowledge
 * - procedural: Behavioral rules, patterns, and operating constraints
 * - working:    Short-lived context scoped to the current thread
 */
export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'working';

// ─── Core Agent Types ─────────────────────────────────────────────────────────

/** Agent record returned by the API */
export interface Agent {
	id: string;
	ownerId: string;
	name: string;
	description?: string;
	systemInstruction?: string;
	/** Emoji character (default) or image URL for the agent's avatar */
	avatarUrl?: string;
	/** IDs of credentials this agent has access to (the explicit manual selection) */
	credentialIds: string[];
	/**
	 * IDs of other agents this agent is allowed to message via the agent-to-agent
	 * tools (list_agents / send_to_agent / ask_agent). Default-deny — empty means the
	 * agent has no messaging capability. All targets must belong to the same owner.
	 */
	collaboratorIds: string[];
	/**
	 * When true, the agent uses ALL of the owner's credentials (current and any
	 * added later), overriding `credentialIds`. Default false.
	 */
	allCredentials: boolean;
	/** LLM provider config ID used for chat/completion */
	modelConfigId?: string;
	/** LLM provider config ID used for generating memory embeddings */
	embeddingModelConfigId?: string;
	/**
	 * Dimension of the embedding vectors stored in agent_memory.
	 * Derived from the selected embedding model config.
	 */
	embeddingDim?: number;
	/**
	 * Whether the agent's sandboxed runtime may reach the public internet
	 * (run_terminal/run_code egress). Only enforced when the backend runs the
	 * docker execution driver — credential-proxied call_api requests are
	 * unaffected either way. Default true.
	 */
	allowInternetAccess: boolean;
	/**
	 * Maximum number of tool calls the agent may make in a single chat turn.
	 * Enforced by agent-runner.ts (interactive chat). Default 20.
	 */
	maxToolCallsPerTurn: number;
	createdAt: Date;
	updatedAt: Date;
}

/** A single memory entry stored in the agent's vector memory */
export interface AgentMemoryEntry {
	id: string;
	agentId: string;
	/** Optional thread scope — populated for 'working' memory entries */
	threadId?: string;
	/** Memory classification */
	memoryType: MemoryType;
	content: string;
	metadata?: Record<string, unknown>;
	/** True for chunks generated from a knowledge-base file — hidden from the memory UI */
	isKnowledgeBase?: boolean;
	/** Owning knowledge assignment (agent_knowledge_files row) for knowledge-base chunks */
	agentKnowledgeFileId?: string;
	createdAt: Date;
}

/** A memory search result — memory entry with similarity score */
export interface AgentMemorySearchResult {
	id: string;
	agentId: string;
	threadId?: string;
	memoryType: MemoryType;
	content: string;
	metadata?: Record<string, unknown>;
	isKnowledgeBase?: boolean;
	agentKnowledgeFileId?: string;
	createdAt: Date;
	/** Cosine similarity (1 - cosine distance); higher is more similar. ~1.0 = near-identical,
	 *  ~0 = unrelated, may be slightly negative for very dissimilar entries. */
	similarity: number;
}

// ─── Memory Proxy Protocol (sandbox → host) ───────────────────────────────────

/**
 * Memory write request — sent from the agent sandbox to the host.
 * The host resolves the embedding model, generates the vector, and persists the entry.
 */
export interface MemoryWriteRequest {
	content: string;
	memoryType: MemoryType;
	/** Optional thread scope — typically the current threadId for 'working' memory */
	threadId?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Memory search request — sent from the agent sandbox to the host.
 * The host embeds the query and returns the closest memory entries.
 */
export interface MemorySearchRequest {
	query: string;
	/** Optional filter by memory type — if omitted, searches all types */
	memoryType?: MemoryType;
	/** Optional thread scope filter */
	threadId?: string;
	/** Number of results to return (default 5, max 20) */
	topK?: number;
}

/**
 * Memory delete request — sent from the agent sandbox to the host.
 * Deletes one or more memory entries by ID in a single operation.
 * The host enforces agentId from the PROXY_TOKEN — entries from other agents cannot be deleted.
 */
export interface MemoryDeleteRequest {
	/** One or more memory entry UUIDs to delete */
	memoryIds: string[];
}

/** Response returned to the sandbox after a memory delete operation */
export interface MemoryDeleteResponse {
	/** Number of entries actually deleted (may be less than requested if some IDs were not found) */
	deletedCount: number;
}

// ─── Request Bodies ───────────────────────────────────────────────────────────

/**
 * POST /v1/agents — create a new agent.
 * Ownership is derived from the authenticated token, never from the body.
 */
export interface CreateAgentRequestBody {
	name: string;
	description?: string;
	systemInstruction?: string;
	avatarUrl?: string;
	credentialIds?: string[];
	/** IDs of other agents this agent may message (agent-to-agent allow-list). */
	collaboratorIds?: string[];
	/** When true, the agent uses all of the owner's credentials (current and future). */
	allCredentials?: boolean;
	modelConfigId?: string;
	embeddingModelConfigId?: string;
	embeddingDim?: number;
	allowInternetAccess?: boolean;
	/** Max tool calls per chat turn (clamped to 1–100 by the API; defaults to 20). */
	maxToolCallsPerTurn?: number;
}

/** PUT /v1/agents/:id — update an existing agent */
export interface UpdateAgentRequestBody {
	name?: string;
	description?: string;
	systemInstruction?: string;
	avatarUrl?: string;
	credentialIds?: string[];
	/** IDs of other agents this agent may message (agent-to-agent allow-list). */
	collaboratorIds?: string[];
	/** When true, the agent uses all of the owner's credentials (current and future). */
	allCredentials?: boolean;
	modelConfigId?: string;
	embeddingModelConfigId?: string;
	embeddingDim?: number;
	allowInternetAccess?: boolean;
	/** Max tool calls per chat turn (clamped to 1–100 by the API). */
	maxToolCallsPerTurn?: number;
}

// ─── Run Summary (aggregated per-thread observability) ───────────────────────

/**
 * Aggregated stats for one agent thread — returned by GET /v1/agents/:id/runs.
 * All data is derived from agent_threads + agent_messages, no extra table needed.
 */
export interface AgentRunSummary {
	/** Thread ID */
	id: string;
	agentId: string;
	/** User-visible conversation title */
	title?: string;
	/** Thread lifecycle status */
	status: 'idle' | 'running' | 'completed' | 'error';
	/** How this thread was initiated */
	triggerType: 'chat' | 'cron' | 'webhook' | 'manual' | 'app' | 'agent';
	/** Total number of messages in the thread (all roles) */
	messageCount: number;
	/** Number of tool_result messages (proxy for tool calls made) */
	toolCallCount: number;
	/** Sum of input tokens across all assistant messages in this thread */
	totalInputTokens: number;
	/** Sum of output tokens across all assistant messages */
	totalOutputTokens: number;
	/** Sum of cost.total across all assistant messages (USD) */
	totalCost: number;
	/**
	 * Input token count from the most recent assistant message.
	 * This equals the context window occupancy for the last turn
	 * (the provider counts all history as input).
	 */
	lastInputTokens: number;
	createdAt: Date;
	updatedAt: Date;
}

// ─── Browser session management (end-user) ───────────────────────────────────

/** One persisted/active browser-session summary for an agent's management modal. */
export interface BrowserSessionStatus {
	/** Whether the project-wide browser feature is enabled (BROWSER_FEATURE_ENABLED). */
	featureEnabled: boolean;
	/** featureEnabled AND the agent has internet access — the effective gate. */
	browserAvailable: boolean;
	/** Persisted login state (Playwright storageState: cookies + localStorage). */
	persisted: {
		exists: boolean;
		cookieCount: number;
		/** Distinct sites the agent is logged into (cookie domains + localStorage origins). */
		origins: string[];
		/** ISO timestamp the state was last saved (file mtime), if any. */
		lastSavedAt?: string;
		sizeBytes: number;
	};
	/** Recorded visited-URL history summary. */
	history: { count: number; lastVisitedAt?: string };
	/** Currently-live browser sessions for this agent (usually 0 or 1). */
	activeSessions: { threadId: string; url: string; idleSeconds: number }[];
}

/** A single recorded visited page. */
export interface BrowserHistoryEntry {
	url: string;
	title: string;
	/** ISO timestamp of the visit. */
	visitedAt: string;
}

export type BrowserSessionStatusResponse = ApiResponse<BrowserSessionStatus>;
export type BrowserHistoryListResponse = ApiResponse<BrowserHistoryEntry[]>;
export type BrowserActionResponse = ApiResponse<{ ok: true; closed?: number }>;

// ─── API Response Envelopes ───────────────────────────────────────────────────

export type AgentResponse = ApiResponse<Agent>;
export type AgentsListResponse = ApiResponse<Agent[]>;
export type AgentDeleteResponse = ApiResponse<{ deleted: boolean }>;
export type AgentMemoryListResponse = ApiResponse<AgentMemoryEntry[]>;
export type AgentMemoryDeleteResponse = ApiResponse<{ deleted: boolean }>;
export type AgentMemoryWriteResponse = ApiResponse<AgentMemoryEntry>;
export type AgentMemorySearchResponse = ApiResponse<AgentMemorySearchResult[]>;
export type AgentRunsListResponse = ApiResponse<AgentRunSummary[]>;
