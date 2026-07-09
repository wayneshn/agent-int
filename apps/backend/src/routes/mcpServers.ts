import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../config/logger.js';
import type { AuthService } from '../services/AuthService.js';
import type { McpService } from '../services/McpService.js';
import type {
	McpServerResponse,
	McpServerListResponse,
	McpServerDeleteResponse,
	McpServerTestResponse,
	McpImportResponse,
	McpServer,
	McpServerData,
	McpTransport,
	McpAuthType,
	CreateMcpServerRequestBody,
	UpdateMcpServerRequestBody,
	UpdateMcpToolRequestBody,
	ImportMcpServersRequestBody,
} from '@repo/types';

const VALID_TRANSPORTS: McpTransport[] = ['http', 'sse', 'stdio'];
const VALID_AUTH_TYPES: McpAuthType[] = ['none', 'header', 'oauth'];

/**
 * Factory — creates the MCP servers router. All routes requireAuth; ownerId comes
 * from the authenticated token (req.user.sub), never the client.
 *
 * The McpService is injected (not module-scoped) because it holds the live
 * connection pool shared with the runtime proxy and AgentRuntimeService.
 *
 * Routes:
 *   GET    /v1/mcp-servers            — list servers
 *   GET    /v1/mcp-servers/:id        — one server (metadata + cached tools)
 *   GET    /v1/mcp-servers/:id/data   — redacted secret blob (edit form pre-fill)
 *   POST   /v1/mcp-servers            — create
 *   PUT    /v1/mcp-servers/:id        — update
 *   DELETE /v1/mcp-servers/:id        — delete
 *   POST   /v1/mcp-servers/:id/test   — connect + discover tools
 *   PATCH  /v1/mcp-servers/:id/tools  — toggle a discovered tool on/off
 *   POST   /v1/mcp-servers/import     — import a universal `mcpServers` JSON blob
 */
export function createMcpServersRouter(
	authService: AuthService,
	mcpService: McpService,
	onServerDeleted?: (serverId: string) => void,
): Router {
	const router = Router();
	const auth = requireAuth(authService);

	router.get('/', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res
				.status(401)
				.json({ success: false, error: 'Unauthorized' } satisfies McpServerListResponse);
			return;
		}
		const list = await mcpService.listByOwner(ownerId);
		res.json({ success: true, data: list } satisfies McpServerListResponse);
	});

	// ─── Per-agent assignments (used by the agent form) ────────────────────────

	router.get('/agent/:agentId', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const ids = await mcpService.listAgentAssignments(req.params.agentId as string, ownerId);
		res.json({ success: true, data: ids });
	});

	router.put('/agent/:agentId', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { mcpServerIds } = req.body as { mcpServerIds?: string[] };
		const ok = await mcpService.setAgentAssignments(
			req.params.agentId as string,
			ownerId,
			Array.isArray(mcpServerIds) ? mcpServerIds : [],
		);
		if (!ok) {
			res.status(404).json({ success: false, error: 'Agent not found' });
			return;
		}
		res.json({ success: true, data: { updated: true } });
	});

	router.get('/:id', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' } satisfies McpServerResponse);
			return;
		}
		const server = await mcpService.getById(req.params.id as string, ownerId);
		if (!server) {
			res
				.status(404)
				.json({ success: false, error: 'MCP server not found' } satisfies McpServerResponse);
			return;
		}
		res.json({ success: true, data: server } satisfies McpServerResponse);
	});

	router.get('/:id/data', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const data = await mcpService.getRedactedData(req.params.id as string, ownerId);
		if (!data) {
			res.status(404).json({ success: false, error: 'MCP server not found' });
			return;
		}
		res.json({ success: true, data });
	});

	router.post('/', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' } satisfies McpServerResponse);
			return;
		}
		const { name, transport, url, authType, data } = req.body as CreateMcpServerRequestBody;
		const validation = validateServerInput({ name, transport, url, authType });
		if (validation) {
			res.status(400).json({ success: false, error: validation } satisfies McpServerResponse);
			return;
		}
		const server = await mcpService.create({
			ownerId,
			name,
			transport,
			url,
			authType,
			data: data ?? {},
		});
		res.status(201).json({ success: true, data: server } satisfies McpServerResponse);
	});

	router.put('/:id', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' } satisfies McpServerResponse);
			return;
		}
		const { name, url, enabled, authType, data } = req.body as UpdateMcpServerRequestBody;
		if (authType && !VALID_AUTH_TYPES.includes(authType)) {
			res
				.status(400)
				.json({ success: false, error: 'Invalid authType' } satisfies McpServerResponse);
			return;
		}
		const updated = await mcpService.update(req.params.id as string, ownerId, {
			name,
			url,
			enabled,
			authType,
			data,
		});
		if (!updated) {
			res
				.status(404)
				.json({ success: false, error: 'MCP server not found' } satisfies McpServerResponse);
			return;
		}
		res.json({ success: true, data: updated } satisfies McpServerResponse);
	});

	router.delete('/:id', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res
				.status(401)
				.json({ success: false, error: 'Unauthorized' } satisfies McpServerDeleteResponse);
			return;
		}
		const id = req.params.id as string;
		const deleted = await mcpService.delete(id, ownerId);
		if (!deleted) {
			res
				.status(404)
				.json({ success: false, error: 'MCP server not found' } satisfies McpServerDeleteResponse);
			return;
		}
		onServerDeleted?.(id);
		res.json({ success: true, data: { deleted: true } } satisfies McpServerDeleteResponse);
	});

	router.post('/:id/test', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res
				.status(401)
				.json({ success: false, error: 'Unauthorized' } satisfies McpServerTestResponse);
			return;
		}
		try {
			const result = await mcpService.testAndListTools(req.params.id as string, ownerId);
			res.json({ success: true, data: result } satisfies McpServerTestResponse);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Test failed';
			res.status(404).json({ success: false, error: message } satisfies McpServerTestResponse);
		}
	});

	router.patch('/:id/tools', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { toolName, enabled } = req.body as UpdateMcpToolRequestBody;
		if (typeof toolName !== 'string' || typeof enabled !== 'boolean') {
			res.status(400).json({ success: false, error: 'toolName and enabled are required' });
			return;
		}
		const tools = await mcpService.setToolEnabled(
			req.params.id as string,
			ownerId,
			toolName,
			enabled,
		);
		if (!tools) {
			res.status(404).json({ success: false, error: 'MCP server or tool not found' });
			return;
		}
		res.json({ success: true, data: tools });
	});

	router.post('/import', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' } satisfies McpImportResponse);
			return;
		}
		const { json } = req.body as ImportMcpServersRequestBody;
		let parsed: unknown;
		try {
			parsed = JSON.parse(json);
		} catch {
			res.status(400).json({ success: false, error: 'Invalid JSON' } satisfies McpImportResponse);
			return;
		}
		const entries = extractServerEntries(parsed);
		if (entries.length === 0) {
			res.status(400).json({
				success: false,
				error: 'No servers found — expected an "mcpServers" (or "servers") object',
			} satisfies McpImportResponse);
			return;
		}
		const created: McpServer[] = [];
		for (const entry of entries) {
			try {
				created.push(await mcpService.create({ ...entry, ownerId }));
			} catch (err) {
				logger.warn({ err, name: entry.name }, '[mcp] import entry failed');
			}
		}
		res.status(201).json({ success: true, data: { created } } satisfies McpImportResponse);
	});

	return router;
}

function validateServerInput(input: {
	name?: string;
	transport?: McpTransport;
	url?: string;
	authType?: McpAuthType;
}): string | null {
	if (!input.name) return 'name is required';
	if (!input.transport || !VALID_TRANSPORTS.includes(input.transport)) return 'Invalid transport';
	if (!input.authType || !VALID_AUTH_TYPES.includes(input.authType)) return 'Invalid authType';
	if (input.transport !== 'stdio' && !input.url) return 'url is required for remote servers';
	return null;
}

/**
 * Parse a universal `mcpServers` (or VS Code `servers`) config object into
 * create inputs. Remote entries carry a `url`; command-based entries become
 * stdio servers (stored, connectable once stdio support lands).
 */
function extractServerEntries(parsed: unknown): Array<{
	name: string;
	transport: McpTransport;
	url?: string;
	authType: McpAuthType;
	data: McpServerData;
}> {
	if (!parsed || typeof parsed !== 'object') return [];
	const root = parsed as Record<string, unknown>;
	const map = (root.mcpServers ?? root.servers ?? root) as Record<string, unknown>;
	if (!map || typeof map !== 'object') return [];

	const out: Array<{
		name: string;
		transport: McpTransport;
		url?: string;
		authType: McpAuthType;
		data: McpServerData;
	}> = [];
	for (const [name, raw] of Object.entries(map)) {
		if (!raw || typeof raw !== 'object') continue;
		const cfg = raw as Record<string, unknown>;
		const url = typeof cfg.url === 'string' ? cfg.url : undefined;
		const headers =
			cfg.headers && typeof cfg.headers === 'object'
				? (cfg.headers as Record<string, string>)
				: undefined;
		if (url) {
			const type = cfg.type === 'sse' ? 'sse' : 'http';
			out.push({
				name,
				transport: type,
				url,
				authType: headers ? 'header' : 'none',
				data: headers ? { headers } : {},
			});
		} else if (typeof cfg.command === 'string') {
			out.push({
				name,
				transport: 'stdio',
				authType: 'none',
				data: {
					stdio: {
						command: cfg.command,
						args: Array.isArray(cfg.args) ? (cfg.args as string[]) : undefined,
						env:
							cfg.env && typeof cfg.env === 'object'
								? (cfg.env as Record<string, string>)
								: undefined,
					},
				},
			});
		}
	}
	return out;
}
