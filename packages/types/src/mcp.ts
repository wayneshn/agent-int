import type { ApiResponse } from './api.js';

// ─── Enums / unions ───────────────────────────────────────────────────────────

/** Transport used to reach an MCP server. */
export type McpTransport = 'http' | 'sse' | 'stdio';

/** How the client authenticates to the MCP server. */
export type McpAuthType = 'none' | 'header' | 'oauth';

/** Last known connection status of a server. */
export type McpServerStatus = 'unknown' | 'connected' | 'error' | 'needs_auth';

// ─── Persisted shapes ─────────────────────────────────────────────────────────

/** One discovered tool cached on the server row (with its enable flag). */
export interface McpToolCacheEntry {
	name: string;
	description?: string;
	/** JSON Schema for the tool's arguments (MCP `inputSchema`, passed through). */
	inputSchema: Record<string, unknown>;
	/** Whether this tool is exposed to agents. Default true when first discovered. */
	enabled: boolean;
}

/**
 * Server metadata safe to return to the browser — NEVER includes the encrypted
 * `data` blob (auth headers, tokens, stdio env).
 */
export interface McpServer {
	id: string;
	ownerId: string;
	name: string;
	slug: string;
	transport: McpTransport;
	url?: string;
	authType: McpAuthType;
	enabled: boolean;
	status: McpServerStatus;
	lastError?: string;
	/** Discovered tools with enable flags (present once the server has been tested). */
	tools?: McpToolCacheEntry[];
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Decrypted secret payload stored in `mcp_servers.data`. Server-side only —
 * never serialized to the client except through the redaction pattern.
 */
export interface McpServerData {
	/** Static auth headers injected on every request (authType === 'header'). */
	headers?: Record<string, string>;
	/** Local stdio launch spec (transport === 'stdio', phase 4). */
	stdio?: { command: string; args?: string[]; env?: Record<string, string> };
	/** OAuth 2.1 state (authType === 'oauth', phase 2) — client creds + tokens. */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		tokens?: Record<string, unknown>;
		codeVerifier?: string;
		endpoints?: Record<string, unknown>;
	};
}

// ─── Runtime tool metadata (embedded in AgentRuntimeConfig) ───────────────────

/** A single MCP tool descriptor delivered to the sandbox (no secrets). */
export interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

/** One assigned server + its enabled tools, embedded in the runtime config. */
export interface McpServerRuntimeEntry {
	id: string;
	slug: string;
	name: string;
	tools: McpToolDescriptor[];
}

// ─── Proxy protocol (sandbox → host) ──────────────────────────────────────────

/** POST /v1/runtime/internal/mcp/call-tool — invoke one MCP tool by name. */
export interface McpCallToolRequest {
	serverId: string;
	toolName: string;
	args: Record<string, unknown>;
}

/** Result of an MCP tool call, returned to the sandbox. */
export interface McpCallToolResult {
	/** Text content blocks flattened from the MCP result. */
	text?: string;
	/** Any image blocks the tool returned (base64), surfaced to the chat. */
	images?: { data: string; mimeType: string }[];
	/** True when the tool reported an error (recoverable — not a transport fault). */
	isError?: boolean;
}

// ─── Registry / import (phase 3) ──────────────────────────────────────────────

/** A remote endpoint entry from a registry `server.json`. */
export interface McpRegistryRemote {
	type: 'streamable-http' | 'sse';
	url: string;
	headers?: { name: string; isRequired?: boolean; isSecret?: boolean }[];
}

/** A normalized subset of a registry `server.json` for the in-app browser. */
export interface McpRegistryServer {
	name: string;
	description?: string;
	version?: string;
	remotes?: McpRegistryRemote[];
	/** True when the server only ships as a local package (stdio) — not one-click addable yet. */
	packagesOnly?: boolean;
}

// ─── Request bodies ───────────────────────────────────────────────────────────

/** POST /v1/mcp-servers */
export interface CreateMcpServerRequestBody {
	name: string;
	transport: McpTransport;
	url?: string;
	authType: McpAuthType;
	/** Non-redacted secret fields for the auth type (e.g. { headers } for 'header'). */
	data?: McpServerData;
}

/** PUT /v1/mcp-servers/:id */
export interface UpdateMcpServerRequestBody {
	name?: string;
	url?: string;
	enabled?: boolean;
	authType?: McpAuthType;
	data?: McpServerData;
}

/** PATCH /v1/mcp-servers/:id/tools — toggle a discovered tool on/off. */
export interface UpdateMcpToolRequestBody {
	toolName: string;
	enabled: boolean;
}

/** POST /v1/mcp-servers/import — paste a universal `mcpServers` JSON blob. */
export interface ImportMcpServersRequestBody {
	/** Raw JSON text (either `{ mcpServers: {...} }` or `{ servers: {...} }`). */
	json: string;
}

// ─── Response envelopes ───────────────────────────────────────────────────────

export type McpServerResponse = ApiResponse<McpServer>;
export type McpServerListResponse = ApiResponse<McpServer[]>;
export type McpServerDeleteResponse = ApiResponse<{ deleted: boolean }>;
export type McpServerTestResponse = ApiResponse<{
	status: McpServerStatus;
	tools: McpToolCacheEntry[];
	/** Present when the connection failed — the detailed error from the MCP server. */
	error?: string;
}>;
export type McpRegistryListResponse = ApiResponse<McpRegistryServer[]>;
export type McpImportResponse = ApiResponse<{ created: McpServer[] }>;
