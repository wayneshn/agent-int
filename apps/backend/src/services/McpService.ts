import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { db } from '../db/index.js';
import { mcpServers, agentMcpServers, agents } from '../db/schema/index.js';
import { EncryptionService } from './EncryptionService.js';
import { assertPublicUrl } from '../utils/ssrfGuard.js';
import { logger } from '../config/logger.js';
import type {
	McpServer,
	McpServerData,
	McpServerStatus,
	McpToolCacheEntry,
	McpServerRuntimeEntry,
	McpCallToolResult,
	McpTransport,
	McpAuthType,
} from '@repo/types';

/** Sentinel placed in redacted header values returned to the edit form. */
export const MCP_SENTINEL = '__REDACTED__';

/** How long an idle live connection is kept before being closed. */
const CONNECTION_IDLE_MS = 5 * 60 * 1000;

/** Client identity advertised to MCP servers. */
const CLIENT_INFO = { name: 'valmis', version: '1.0.0' };

interface CreateMcpServerInput {
	ownerId: string;
	name: string;
	transport: McpTransport;
	url?: string;
	authType: McpAuthType;
	data: McpServerData;
}

interface UpdateMcpServerInput {
	name?: string;
	url?: string;
	enabled?: boolean;
	authType?: McpAuthType;
	data?: McpServerData;
}

interface LiveConnection {
	client: Client;
	transport: Transport;
	idleTimer: ReturnType<typeof setTimeout>;
}

/** Row → safe metadata (no `data` blob). */
function toServer(row: typeof mcpServers.$inferSelect): McpServer {
	return {
		id: row.id,
		ownerId: row.ownerId,
		name: row.name,
		slug: row.slug,
		transport: row.transport as McpTransport,
		url: row.url ?? undefined,
		authType: row.authType as McpAuthType,
		enabled: row.enabled,
		status: row.status as McpServerStatus,
		lastError: row.lastError ?? undefined,
		tools: row.toolsCache ?? undefined,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Build a URL-safe slug from a display name. */
function slugify(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return base.length > 0 ? base : 'server';
}

/**
 * Service responsible for MCP server CRUD and for holding the LIVE connections
 * used to discover and invoke tools. Modeled on BrowserService (long-lived,
 * pooled, idle-reaped) + CredentialService (encryption + redaction).
 *
 * Secrets live only in the encrypted `data` blob and never leave the backend —
 * the sandbox asks the host to invoke a tool by name via the proxy, and this
 * service injects the auth host-side. Ownership is enforced in every query.
 */
export class McpService {
	private encryption: EncryptionService;
	private connections = new Map<string, LiveConnection>();

	constructor(encryption: EncryptionService) {
		this.encryption = encryption;
	}

	// ─── CRUD ──────────────────────────────────────────────────────────────────

	async listByOwner(ownerId: string): Promise<McpServer[]> {
		const rows = await db
			.select()
			.from(mcpServers)
			.where(eq(mcpServers.ownerId, ownerId))
			.orderBy(desc(mcpServers.createdAt));
		return rows.map(toServer);
	}

	async getById(id: string, ownerId: string): Promise<McpServer | null> {
		const rows = await db
			.select()
			.from(mcpServers)
			.where(and(eq(mcpServers.id, id), eq(mcpServers.ownerId, ownerId)))
			.limit(1);
		return rows[0] ? toServer(rows[0]) : null;
	}

	/** Decrypt the secret blob for a server (ownership-checked). */
	async getDecryptedData(id: string, ownerId: string): Promise<McpServerData | null> {
		const rows = await db
			.select({ data: mcpServers.data })
			.from(mcpServers)
			.where(and(eq(mcpServers.id, id), eq(mcpServers.ownerId, ownerId)))
			.limit(1);
		if (!rows[0]) return null;
		return JSON.parse(this.encryption.decrypt(rows[0].data)) as McpServerData;
	}

	/** Redacted secret blob for the edit form (header values → sentinel). */
	async getRedactedData(id: string, ownerId: string): Promise<McpServerData | null> {
		const data = await this.getDecryptedData(id, ownerId);
		if (!data) return null;
		const redacted: McpServerData = { ...data };
		if (redacted.headers) {
			redacted.headers = Object.fromEntries(
				Object.keys(redacted.headers).map((k) => [k, MCP_SENTINEL]),
			);
		}
		if (redacted.stdio?.env) {
			redacted.stdio = {
				...redacted.stdio,
				env: Object.fromEntries(Object.keys(redacted.stdio.env).map((k) => [k, MCP_SENTINEL])),
			};
		}
		delete redacted.oauth;
		return redacted;
	}

	async create(input: CreateMcpServerInput): Promise<McpServer> {
		const id = uuidv4();
		const now = new Date();
		const slug = await this.uniqueSlug(input.ownerId, slugify(input.name));
		const [row] = await db
			.insert(mcpServers)
			.values({
				id,
				ownerId: input.ownerId,
				name: input.name,
				slug,
				transport: input.transport,
				url: input.url ?? null,
				authType: input.authType,
				data: this.encryption.encrypt(JSON.stringify(input.data)),
				enabled: true,
				status: 'unknown',
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		return toServer(row);
	}

	async update(
		id: string,
		ownerId: string,
		input: UpdateMcpServerInput,
	): Promise<McpServer | null> {
		const existing = await this.getById(id, ownerId);
		if (!existing) return null;

		const updates: Partial<typeof mcpServers.$inferInsert> = { updatedAt: new Date() };
		if (input.name !== undefined) updates.name = input.name;
		if (input.url !== undefined) updates.url = input.url;
		if (input.enabled !== undefined) updates.enabled = input.enabled;
		if (input.authType !== undefined) updates.authType = input.authType;
		if (input.data !== undefined) {
			// Unredact against the stored blob so sentinel values keep the real secret.
			const stored = (await this.getDecryptedData(id, ownerId)) ?? {};
			const merged = this.unredactData(input.data, stored);
			updates.data = this.encryption.encrypt(JSON.stringify(merged));
			// Changing auth/config invalidates the discovered connection.
			updates.status = 'unknown';
		}

		await db
			.update(mcpServers)
			.set(updates)
			.where(and(eq(mcpServers.id, id), eq(mcpServers.ownerId, ownerId)));
		this.dropConnection(id);
		return this.getById(id, ownerId);
	}

	async delete(id: string, ownerId: string): Promise<boolean> {
		const result = await db
			.delete(mcpServers)
			.where(and(eq(mcpServers.id, id), eq(mcpServers.ownerId, ownerId)));
		this.dropConnection(id);
		return (result.rowCount ?? 0) > 0;
	}

	// ─── Tool discovery / management ───────────────────────────────────────────

	/**
	 * Connect to a server, list its tools, and persist them to `tools_cache`
	 * (preserving prior enable flags; new tools default enabled). Updates status.
	 */
	async testAndListTools(
		id: string,
		ownerId: string,
	): Promise<{ status: McpServerStatus; tools: McpToolCacheEntry[]; error?: string }> {
		const server = await this.getById(id, ownerId);
		if (!server) throw new Error('MCP server not found');

		try {
			const { client } = await this.connect(id, ownerId);
			const listed = await client.listTools();
			const prior = new Map((server.tools ?? []).map((t) => [t.name, t.enabled]));
			const tools: McpToolCacheEntry[] = listed.tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<
					string,
					unknown
				>,
				enabled: prior.get(t.name) ?? true,
			}));
			await db
				.update(mcpServers)
				.set({ toolsCache: tools, status: 'connected', lastError: null, updatedAt: new Date() })
				.where(and(eq(mcpServers.id, id), eq(mcpServers.ownerId, ownerId)));
			return { status: 'connected', tools };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const status: McpServerStatus = server.authType === 'oauth' ? 'needs_auth' : 'error';
			await db
				.update(mcpServers)
				.set({ status, lastError: message.slice(0, 500), updatedAt: new Date() })
				.where(and(eq(mcpServers.id, id), eq(mcpServers.ownerId, ownerId)));
			logger.warn({ err, serverId: id }, '[mcp] test/list tools failed');
			return { status, tools: server.tools ?? [], error: message };
		}
	}

	/** Toggle a single discovered tool on/off in the cache. */
	async setToolEnabled(
		id: string,
		ownerId: string,
		toolName: string,
		enabled: boolean,
	): Promise<McpToolCacheEntry[] | null> {
		const server = await this.getById(id, ownerId);
		if (!server?.tools) return null;
		const tools = server.tools.map((t) => (t.name === toolName ? { ...t, enabled } : t));
		await db
			.update(mcpServers)
			.set({ toolsCache: tools, updatedAt: new Date() })
			.where(and(eq(mcpServers.id, id), eq(mcpServers.ownerId, ownerId)));
		return tools;
	}

	/**
	 * Enabled tool metadata for every enabled server assigned to an agent — read
	 * from the cache (no live connection). Applies the per-agent `enabledTools`
	 * subset when set. Embedded into AgentRuntimeConfig at spawn time.
	 */
	async getAssignedServerTools(agentId: string, ownerId: string): Promise<McpServerRuntimeEntry[]> {
		const rows = await db
			.select({
				id: mcpServers.id,
				slug: mcpServers.slug,
				name: mcpServers.name,
				toolsCache: mcpServers.toolsCache,
				enabled: mcpServers.enabled,
				perAgent: agentMcpServers.enabledTools,
			})
			.from(agentMcpServers)
			.innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
			.where(and(eq(agentMcpServers.agentId, agentId), eq(mcpServers.ownerId, ownerId)));

		const entries: McpServerRuntimeEntry[] = [];
		for (const row of rows) {
			if (!row.enabled || !row.toolsCache) continue;
			const perAgent = row.perAgent ? new Set(row.perAgent) : null;
			const tools = row.toolsCache
				.filter((t) => t.enabled && (!perAgent || perAgent.has(t.name)))
				.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
			if (tools.length > 0) {
				entries.push({ id: row.id, slug: row.slug, name: row.name, tools });
			}
		}
		return entries;
	}

	// ─── Per-agent assignments ─────────────────────────────────────────────────

	/** List the MCP server IDs assigned to an agent (ownership-checked via the agent). */
	async listAgentAssignments(agentId: string, ownerId: string): Promise<string[]> {
		if (!(await this.ownsAgent(agentId, ownerId))) return [];
		const rows = await db
			.select({ mcpServerId: agentMcpServers.mcpServerId })
			.from(agentMcpServers)
			.where(eq(agentMcpServers.agentId, agentId));
		return rows.map((r) => r.mcpServerId);
	}

	/**
	 * Replace an agent's MCP server assignments with `serverIds`. Only IDs of
	 * servers the owner actually owns are inserted (server-side replace pattern,
	 * mirrors AgentService's credential sync). Returns false if the agent is not
	 * owned by `ownerId`.
	 */
	async setAgentAssignments(
		agentId: string,
		ownerId: string,
		serverIds: string[],
	): Promise<boolean> {
		if (!(await this.ownsAgent(agentId, ownerId))) return false;
		const owned = await db
			.select({ id: mcpServers.id })
			.from(mcpServers)
			.where(eq(mcpServers.ownerId, ownerId));
		const ownedSet = new Set(owned.map((r) => r.id));
		const valid = [...new Set(serverIds)].filter((id) => ownedSet.has(id));

		await db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId));
		if (valid.length > 0) {
			await db
				.insert(agentMcpServers)
				.values(valid.map((mcpServerId) => ({ agentId, mcpServerId })));
		}
		return true;
	}

	private async ownsAgent(agentId: string, ownerId: string): Promise<boolean> {
		const rows = await db
			.select({ id: agents.id })
			.from(agents)
			.where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)))
			.limit(1);
		return rows.length > 0;
	}

	// ─── Tool invocation (called from the runtime proxy) ───────────────────────

	/**
	 * Invoke one MCP tool on behalf of a sandbox. Performs a LIVE re-check that
	 * the server is still owned, enabled, assigned to the agent, and that the tool
	 * is enabled — defeating stale PROXY_TOKENs (mirrors AgentProxyService).
	 */
	async callTool(
		ownerId: string,
		agentId: string,
		serverId: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<McpCallToolResult> {
		const server = await this.getById(serverId, ownerId);
		if (!server || !server.enabled) {
			throw new Error('MCP server is not available');
		}
		const assigned = await db
			.select({ enabledTools: agentMcpServers.enabledTools })
			.from(agentMcpServers)
			.where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, serverId)))
			.limit(1);
		if (!assigned[0]) {
			throw new Error('MCP server is not assigned to this agent');
		}
		const perAgent = assigned[0].enabledTools ? new Set(assigned[0].enabledTools) : null;
		const cached = (server.tools ?? []).find((t) => t.name === toolName);
		if (!cached || !cached.enabled || (perAgent && !perAgent.has(toolName))) {
			throw new Error(`Tool "${toolName}" is not enabled on this server`);
		}

		const { client } = await this.connect(serverId, ownerId);
		const result = await client.callTool({ name: toolName, arguments: args });
		return this.normalizeToolResult(result);
	}

	// ─── Connection pool ───────────────────────────────────────────────────────

	private async connect(id: string, ownerId: string): Promise<LiveConnection> {
		const existing = this.connections.get(id);
		if (existing) {
			existing.idleTimer.refresh();
			return existing;
		}

		const server = await this.getById(id, ownerId);
		if (!server) throw new Error('MCP server not found');
		if (server.transport === 'stdio') {
			throw new Error('stdio MCP servers are not supported yet');
		}
		if (!server.url) throw new Error('MCP server has no URL');
		if (server.authType === 'oauth') {
			throw new Error('This server requires OAuth — connect it first');
		}
		await assertPublicUrl(server.url);

		const data = (await this.getDecryptedData(id, ownerId)) ?? {};
		const requestInit: RequestInit | undefined =
			server.authType === 'header' && data.headers ? { headers: data.headers } : undefined;

		// Honor the chosen transport — NEVER cross-fall-back to the other transport
		// (that only hides the real error). But many hosted servers expose the
		// endpoint on a subpath while users paste the BASE url, so if the given url
		// fails, retry the SAME transport against the conventional endpoint path
		// (/mcp for Streamable HTTP, /sse for SSE). Same host, so the SSRF check
		// above still covers it.
		const transportKind: McpTransport = server.transport === 'sse' ? 'sse' : 'http';
		const candidates = candidateUrls(server.url, transportKind);
		let lastErr: unknown;
		let authErr: unknown;
		for (const candidate of candidates) {
			const client = new Client(CLIENT_INFO);
			const transport: Transport =
				transportKind === 'sse'
					? new SSEClientTransport(new URL(candidate), { requestInit })
					: new StreamableHTTPClientTransport(new URL(candidate), { requestInit });
			try {
				await client.connect(transport);
				const idleTimer = setTimeout(() => this.dropConnection(id), CONNECTION_IDLE_MS);
				if (typeof idleTimer.unref === 'function') idleTimer.unref();
				const conn: LiveConnection = { client, transport, idleTimer };
				this.connections.set(id, conn);
				return conn;
			} catch (err) {
				await client.close().catch(() => {});
				lastErr = err;
				// An auth failure is the actionable root cause regardless of which
				// candidate hit it — remember the first one so it wins the message.
				const status = errStatus(err);
				if ((status === 401 || status === 403) && authErr === undefined) authErr = err;
			}
		}
		throw new Error(connectErrorMessage(transportKind, authErr ?? lastErr));
	}

	private dropConnection(id: string): void {
		const conn = this.connections.get(id);
		if (!conn) return;
		clearTimeout(conn.idleTimer);
		this.connections.delete(id);
		void conn.client.close().catch(() => {});
	}

	/** Close every live connection (server shutdown). */
	async shutdown(): Promise<void> {
		for (const id of [...this.connections.keys()]) this.dropConnection(id);
	}

	// ─── Helpers ───────────────────────────────────────────────────────────────

	private normalizeToolResult(result: Awaited<ReturnType<Client['callTool']>>): McpCallToolResult {
		const content = Array.isArray(result.content) ? result.content : [];
		const texts: string[] = [];
		const images: { data: string; mimeType: string }[] = [];
		for (const block of content as Array<Record<string, unknown>>) {
			if (block.type === 'text' && typeof block.text === 'string') {
				texts.push(block.text);
			} else if (block.type === 'image' && typeof block.data === 'string') {
				images.push({
					data: block.data,
					mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png',
				});
			} else if (
				block.type === 'resource' &&
				block.resource &&
				typeof block.resource === 'object'
			) {
				const res = block.resource as Record<string, unknown>;
				if (typeof res.text === 'string') texts.push(res.text);
			}
		}
		return {
			text: texts.length > 0 ? texts.join('\n') : undefined,
			images: images.length > 0 ? images : undefined,
			isError: result.isError === true,
		};
	}

	/**
	 * Merge an incoming (possibly redacted) secret blob over the stored one so an
	 * edit never destroys a secret the client didn't retype. Generic and
	 * nesting-aware (mirrors CredentialService's unredact, but for MCP's nested
	 * shape): every MCP_SENTINEL is restored from the matching stored value across
	 * `headers`, `stdio.env`, and `oauth`; a sentinel with no stored counterpart is
	 * dropped rather than persisted literally.
	 *
	 * Top-level keys the client omits are preserved from `stored` (so editing only
	 * `headers` leaves `oauth`/`stdio` intact). Inside a nested object the client
	 * DID send, its key set is authoritative — a header/env var the user removed is
	 * gone — matching the redacted-form round-trip where every existing key is
	 * echoed back.
	 */
	private unredactData(incoming: McpServerData, stored: McpServerData): McpServerData {
		const result: Record<string, unknown> = { ...(stored as Record<string, unknown>) };
		for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
			result[key] = restoreRedactedValue(value, (stored as Record<string, unknown>)[key]);
		}
		return result as McpServerData;
	}

	private async uniqueSlug(ownerId: string, base: string): Promise<string> {
		const existing = await db
			.select({ slug: mcpServers.slug })
			.from(mcpServers)
			.where(eq(mcpServers.ownerId, ownerId));
		const taken = new Set(existing.map((r) => r.slug));
		if (!taken.has(base)) return base;
		for (let i = 2; i < 1000; i++) {
			const candidate = `${base}-${i}`;
			if (!taken.has(candidate)) return candidate;
		}
		return `${base}-${uuidv4().slice(0, 8)}`;
	}
}

// ─── Secret redaction round-trip ────────────────────────────────────────────────

/** True for a non-null, non-array plain object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Restore one value from a redacted edit-form submission against its stored
 * counterpart. A bare MCP_SENTINEL becomes the stored value; a plain object is
 * rebuilt from the incoming key set (authoritative) with each nested sentinel
 * restored (and dropped when absent from `stored`); everything else passes
 * through unchanged. Recurses so `stdio.env` and `oauth` are handled like
 * `headers`.
 */
function restoreRedactedValue(value: unknown, stored: unknown): unknown {
	if (value === MCP_SENTINEL) return stored;
	if (isPlainObject(value)) {
		const storedObj = isPlainObject(stored) ? stored : {};
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (v === MCP_SENTINEL) {
				if (k in storedObj) out[k] = storedObj[k]; // else drop — no stored secret to restore
			} else {
				out[k] = restoreRedactedValue(v, storedObj[k]);
			}
		}
		return out;
	}
	return value;
}

// ─── Connect error formatting ──────────────────────────────────────────────────

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * URLs to try, in order, for a given transport. First the URL exactly as the user
 * entered it, then — if its path doesn't already end with the conventional
 * endpoint suffix — the same URL with `/mcp` (Streamable HTTP) or `/sse` (SSE)
 * appended. Covers the common case of pasting a server's BASE url.
 */
function candidateUrls(rawUrl: string, transport: McpTransport): string[] {
	const suffix = transport === 'sse' ? '/sse' : '/mcp';
	const trimmed = rawUrl.replace(/\/+$/, '');
	try {
		const u = new URL(trimmed);
		if (!u.pathname.endsWith(suffix)) {
			return [rawUrl, trimmed + suffix];
		}
	} catch {
		// Not a valid URL — let the single attempt fail with a clear message.
	}
	return [rawUrl];
}

/** StreamableHTTPError / SseError both carry the HTTP status on `.code`. */
function errStatus(err: unknown): number | undefined {
	if (err && typeof err === 'object') {
		const code = (err as { code?: unknown }).code;
		if (typeof code === 'number') return code;
	}
	return undefined;
}

/**
 * Turn a transport connect failure into an actionable message. Keeps the real
 * status/text (no fallback masking) and adds a hint for the common cases:
 * a rejected token, or a server whose optional GET event-stream isn't a 405.
 */
function connectErrorMessage(transport: McpTransport, err: unknown): string {
	const raw = errMessage(err);
	const status = errStatus(err);
	const label = transport === 'sse' ? 'SSE' : 'Streamable HTTP';
	if (status === 401) {
		return `${label} connection rejected (401 Unauthorized) — check the server's auth header / token.`;
	}
	if (status === 403) {
		return `${label} connection forbidden (403) — the token may lack the required scope.`;
	}
	// The SDK opens an OPTIONAL standalone GET event-stream on connect; a server
	// that answers it with anything other than 405 makes the SDK throw here even
	// though POST tool calls would work. Make that legible.
	if (/open SSE stream|event stream/i.test(raw)) {
		return (
			`${label} connect failed while opening the server's event stream` +
			`${status ? ` (HTTP ${status})` : ''}: ${raw}. ` +
			`The server may not support the Streamable HTTP GET stream — try the SSE transport, ` +
			`or point the URL at the server's dedicated Streamable HTTP endpoint.`
		);
	}
	return `${label} connection failed${status ? ` (HTTP ${status})` : ''}: ${raw}`;
}
