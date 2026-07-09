import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { AgentSessionService } from '../services/AgentSessionService.js';
import {
	ChatFileService,
	MAX_CHAT_FILE_BYTES,
	MAX_CHAT_FILES_PER_REQUEST,
	resolveServeMimeType,
	type ChatUploadInput,
} from '../services/ChatFileService.js';
import { AgentRuntimeService } from '../services/AgentRuntimeService.js';
import { AgentMessagingService } from '../services/AgentMessagingService.js';
import { AgentProxyService } from '../services/AgentProxyService.js';
import { AgentLlmProxyService } from '../services/AgentLlmProxyService.js';
import { AgentMemoryService } from '../services/AgentMemoryService.js';
import { TriggerService } from '../services/TriggerService.js';
import { WorkflowRunService } from '../services/WorkflowRunService.js';
import { WorkflowService } from '../services/WorkflowService.js';
import { SkillService } from '../services/SkillService.js';
import { BrowserService } from '../services/BrowserService.js';
import { McpService } from '../services/McpService.js';
import { MissionService, MISSION_PLAN_MAX_LENGTH } from '../services/MissionService.js';
import { MissionSchedulerService } from '../services/MissionSchedulerService.js';
import { OutboundDeliveryService } from '../services/OutboundDeliveryService.js';
import { agentStreamBus } from '../services/AgentStreamBus.js';
import { MessagePipeline } from '../channels/pipeline.js';
import { WebAdapter } from '../channels/web/adapter.js';
import { logger } from '../config/logger.js';
import { specToGraph } from '@repo/utils';
import type { AuthService } from '../services/AuthService.js';
import type {
	AgentThreadResponse,
	AgentThreadsListResponse,
	AgentThreadDeleteResponse,
	AgentMessagesListResponse,
	AgentTriggerResponse,
	AgentTriggersListResponse,
	AgentTriggerDeleteResponse,
	RenameThreadRequestBody,
	CreateTriggerRequestBody,
	UpdateTriggerRequestBody,
	ProxyRequest,
	LlmProxyRequest,
	SandboxTokenPayload,
	HitlRequest,
	BrowserActionRequest,
	McpCallToolRequest,
	MemoryWriteRequest,
	MemorySearchRequest,
	MemoryDeleteRequest,
	AgentMessageRequest,
	SkillTraceRequestBody,
	ContentBlock,
	WorkflowSummary,
	WorkflowTriggerContext,
	WorkflowSpec,
	WorkflowStep,
	ChatFileUploadResponse,
	ChatFilesListResponse,
	ChatFileDeleteResponse,
	AgentMission,
	MissionPlanUpdateRequest,
	MissionLogRequest,
	MissionScheduleWakeRequest,
	MissionCompleteRequest,
	MissionReportRequest,
	MissionApprovalCreateRequest,
	CreateMissionRequest,
	UpdateMissionRequest,
	MissionControlRequest,
} from '@repo/types';

/**
 * Normalises a tool result ContentBlock[] into a single displayable string for the browser.
 *
 * Rules:
 *   - Only text blocks are included (image blocks carry base64 data, not useful in a small UI strip).
 *   - Each text value is truncated to TOOL_RESULT_MAX_CHARS and marked "[truncated]" when cut.
 *   - If there is no text output at all, returns a fallback placeholder.
 */
const TOOL_RESULT_MAX_CHARS = 1000;

function formatToolResult(blocks: ContentBlock[]): string {
	const textParts = blocks
		.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
		.map((b) => {
			if (b.text.length > TOOL_RESULT_MAX_CHARS) {
				return b.text.slice(0, TOOL_RESULT_MAX_CHARS) + '… [truncated]';
			}
			return b.text;
		});

	return textParts.length > 0 ? textParts.join('\n') : '(no text output)';
}

/**
 * Runtime router — two sets of routes:
 *
 * 1. User-facing (JWT auth):
 *    POST   /v1/runtime/:agentId/threads                        — create chat thread
 *    GET    /v1/runtime/:agentId/threads                        — list threads
 *    POST   /v1/runtime/:agentId/threads/:threadId/messages     — send user message + spawn container
 *    GET    /v1/runtime/:agentId/threads/:threadId/messages     — get message history
 *    GET    /v1/runtime/:agentId/threads/:threadId/stream       — SSE stream of agent events
 *    POST   /v1/runtime/:agentId/triggers                       — create trigger
 *    GET    /v1/runtime/:agentId/triggers                       — list triggers
 *    PUT    /v1/runtime/:agentId/triggers/:triggerId            — update trigger
 *    DELETE /v1/runtime/:agentId/triggers/:triggerId            — delete trigger
 *    POST   /v1/runtime/:agentId/triggers/:triggerId/fire       — fire manual trigger
 *
 * 2. Sandbox-internal (PROXY_TOKEN auth — called from agent child processes):
 *    GET    /v1/runtime/internal/config                         — fetch agent runtime config
 *    GET    /v1/runtime/internal/thread/:threadId/messages      — load message history
 *    POST   /v1/runtime/internal/thread/:threadId/messages      — append a message (tool_result only)
 *    POST   /v1/runtime/internal/proxy                          — credential proxy
 *    POST   /v1/runtime/internal/llm/stream                     — LLM proxy (streams response)
 *
 * IMPORTANT — ownership enforcement:
 *   All user-facing routes derive ownerId from req.user.sub (the authenticated JWT/API-key
 *   identity set by requireAuth). Client-supplied ownerId values in body/query are never used.
 *   If sub is missing the request is rejected with 401.
 *
 * Thread ↔ Agent cross-check:
 *   Routes that accept both :agentId and :threadId verify that thread.agentId === agentId
 *   to prevent a user from accessing a thread from a different agent via URL manipulation.
 */
export function createRuntimeRouter(
	authService: AuthService,
	sessionService: AgentSessionService,
	runtimeService: AgentRuntimeService,
	proxyService: AgentProxyService,
	llmProxyService: AgentLlmProxyService,
	triggerService: TriggerService,
	memoryService: AgentMemoryService,
	workflowRunService: WorkflowRunService,
	workflowService: WorkflowService,
	messagePipeline: MessagePipeline,
	webAdapter: WebAdapter,
	skillService: SkillService,
	browserService: BrowserService,
	mcpService: McpService,
	chatFileService: ChatFileService,
	messagingService: AgentMessagingService,
	missionService: MissionService,
	outboundDeliveryService: OutboundDeliveryService,
	missionSchedulerService: MissionSchedulerService,
): Router {
	const router = Router();
	const auth = requireAuth(authService);

	// In-memory multipart parsing for chat file uploads (bytes are written to the
	// host volume by ChatFileService, not by multer). Same pattern as knowledge.ts.
	const upload = multer({
		storage: multer.memoryStorage(),
		limits: { fileSize: MAX_CHAT_FILE_BYTES, files: MAX_CHAT_FILES_PER_REQUEST },
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Sandbox-internal routes — PROXY_TOKEN auth (must be declared before :agentId routes)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Sandbox-internal auth middleware.
	 * Reads the PROXY_TOKEN from Authorization: Bearer header and verifies it.
	 * Attaches the decoded payload as req.sandboxToken for downstream handlers.
	 * All /internal/* handlers rely on this — they do NOT re-verify the token themselves.
	 */
	router.use('/internal', async (req: Request, res: Response, next) => {
		const authHeader = req.headers.authorization;
		if (!authHeader?.startsWith('Bearer ')) {
			res.status(401).json({ success: false, error: 'Missing PROXY_TOKEN' });
			return;
		}
		const token = authHeader.slice(7);
		try {
			const payload = await proxyService.verifyProxyToken(token);
			(req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken = payload;
			next();
		} catch {
			res.status(401).json({ success: false, error: 'Invalid or expired PROXY_TOKEN' });
		}
	});

	// Body parser for sandbox-internal routes — exempted from the global 10mb parser
	// (see index.ts) because LLM stream requests and persisted tool/image results can
	// carry base64 image content blocks (chat uploads, browser screenshots) far larger
	// than 10mb. PROXY_TOKEN-gated, so not browser-reachable. Configurable via env.
	const INTERNAL_BODY_LIMIT = process.env.RUNTIME_INTERNAL_BODY_LIMIT ?? '64mb';
	router.use('/internal', express.json({ limit: INTERNAL_BODY_LIMIT }));

	/**
	 * GET /v1/runtime/internal/config
	 * Sandbox fetches its runtime config on startup (no secrets included). Used when
	 * the config was too large to inline via the RUNTIME_CONFIG env var (workflows),
	 * so spawnForThread stashed it for one-shot retrieval keyed by threadId. A miss
	 * (expired / never stashed / different backend instance) is logged loudly — the
	 * runtime then fails fast and its run is reconciled to error, never left silent.
	 */
	router.get('/internal/config', (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const config = runtimeService.takePendingConfig(sandboxToken.threadId);
		if (!config) {
			logger.warn(
				{ threadId: sandboxToken.threadId, agentId: sandboxToken.agentId },
				'[runtime] config requested but none pending (expired or already consumed)',
			);
			res.status(404).json({ success: false, error: 'No pending runtime config for this thread' });
			return;
		}
		res.json({ success: true, data: config });
	});

	/**
	 * GET /v1/runtime/internal/thread/:threadId/messages
	 * Sandbox loads conversation history to restore pi-ai context.
	 */
	router.get('/internal/thread/:threadId/messages', async (req: Request, res: Response) => {
		const { threadId } = req.params as { threadId: string };
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;

		// Enforce that the sandbox can only access its own thread
		if (sandboxToken.threadId !== threadId) {
			res.status(403).json({ success: false, error: 'Thread ID mismatch' });
			return;
		}

		const messages = await sessionService.listMessagesInternal(threadId);

		// Inject file attachments into user messages FOR THE AGENT ONLY. These blocks
		// (image content + extracted document text + workspace-path notes) are
		// system-generated and deliberately absent from the persisted/displayed
		// message, so they never appear in the user's chat bubble — they are added
		// here, in-memory, only on the history the runtime loads.
		try {
			const files = await chatFileService.listForThread(threadId, sandboxToken.ownerId);
			const uploads = files.filter((f) => f.source === 'user_upload' && f.messageId);
			if (uploads.length > 0) {
				const visionCapable = await chatFileService.agentSupportsVision(
					sandboxToken.agentId,
					sandboxToken.ownerId,
				);
				const byMessage = new Map<string, typeof uploads>();
				for (const f of uploads) {
					const arr = byMessage.get(f.messageId as string) ?? [];
					arr.push(f);
					byMessage.set(f.messageId as string, arr);
				}
				for (const msg of messages) {
					const msgFiles = byMessage.get(msg.id);
					if (!msgFiles) continue;
					for (const f of msgFiles) {
						msg.content.push(...chatFileService.buildPromptBlocks(f, visionCapable));
					}
				}
			}
		} catch (err) {
			logger.warn(
				{ err, threadId },
				'[runtime] failed to inject file attachments into history — continuing without',
			);
		}

		res.json({ success: true, data: messages });
	});

	/**
	 * POST /v1/runtime/internal/thread/:threadId/messages
	 * Sandbox appends a tool_result message to the thread.
	 * Only 'tool_result' role is accepted — other roles are rejected to prevent
	 * the sandbox from injecting user or assistant messages into history.
	 *
	 * Body parsing uses the large internal-router limit (see the '/internal' json
	 * middleware above) so tool results with large bodies or image blocks fit.
	 */
	router.post('/internal/thread/:threadId/messages', async (req: Request, res: Response) => {
		const { threadId } = req.params as { threadId: string };
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;

		if (sandboxToken.threadId !== threadId) {
			res.status(403).json({ success: false, error: 'Thread ID mismatch' });
			return;
		}

		const { role, content, toolCallId, toolName, tokenUsage } = req.body as {
			role: string;
			content: unknown[];
			toolCallId?: string;
			toolName?: string;
			tokenUsage?: unknown;
		};

		// Enforce that sandboxes may only append tool_result messages.
		// Any other role would corrupt conversation history.
		if (role !== 'tool_result') {
			res.status(400).json({
				success: false,
				error: 'Only tool_result messages may be appended by the sandbox',
			});
			return;
		}

		try {
			const message = await sessionService.appendMessage({
				threadId,
				role,
				content: content as Parameters<typeof sessionService.appendMessage>[0]['content'],
				toolCallId,
				toolName,
				tokenUsage: tokenUsage as Parameters<typeof sessionService.appendMessage>[0]['tokenUsage'],
			});

			// Emit tool_call_end SSE so the browser can display the result inside
			// the ToolCallIndicator that was opened by the earlier tool_call_delta event.
			// The result string is normalised (text only, truncated to 250 chars) before
			// being sent to avoid flooding the SSE stream with large payloads.
			if (toolCallId) {
				const blocks = content as Parameters<typeof sessionService.appendMessage>[0]['content'];
				const resultText = formatToolResult(blocks);
				// Carry any image blocks (e.g. a browser screenshot) so the chat UI can
				// render them live — formatToolResult is text-only, so without this the
				// image would only appear after a page reload.
				const images = blocks
					.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
					.map((b) => ({ data: b.data, mimeType: b.mimeType }));
				agentStreamBus.emit(sandboxToken.threadId, {
					type: 'tool_call_end',
					// messageId is not used by the frontend handler for tool_call_end;
					// the result is keyed purely by toolCallId.
					messageId: '',
					toolCallId,
					result: resultText,
					...(images.length > 0 ? { images } : {}),
				});
			}

			res.status(201).json({ success: true, data: message });
		} catch (err) {
			logger.error({ err, threadId }, '[runtime] failed to append internal message');
			res.status(500).json({ success: false, error: 'Failed to append message' });
		}
	});

	/**
	 * POST /v1/runtime/internal/proxy
	 * Credential proxy — sandbox makes an API call using a resolved credential.
	 * The PROXY_TOKEN is already verified by the /internal middleware; the token
	 * is read from req.sandboxToken — no second verification round-trip.
	 */
	router.post('/internal/proxy', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		// Re-read the raw token from the header so executeProxyRequest can do its
		// credential allowlist check (it needs the full token, not just the payload).
		const proxyToken = (req.headers.authorization as string).slice(7);

		try {
			const proxyResponse = await proxyService.executeProxyRequest(
				proxyToken,
				req.body as ProxyRequest,
			);
			res.json({ success: true, data: proxyResponse });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Proxy request failed';
			logger.warn({ err, agentId: sandboxToken.agentId }, '[runtime] proxy request failed');
			res.status(400).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/llm/stream
	 * LLM proxy — sandbox sends a completion request; host resolves the API key,
	 * calls the LLM provider, streams events to AgentStreamBus (→ browser SSE),
	 * and returns the final content for the sandbox's tool loop.
	 * The PROXY_TOKEN is already verified by the /internal middleware.
	 */
	router.post('/internal/llm/stream', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const proxyToken = (req.headers.authorization as string).slice(7);

		try {
			const content = await llmProxyService.executeStream(proxyToken, req.body as LlmProxyRequest);
			res.json({ success: true, data: { content } });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'LLM proxy failed';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] LLM proxy failed');
			res.status(500).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/hitl/request
	 * Human-in-the-Loop — sandbox pauses and waits for a human response.
	 *
	 * This is a long-polling endpoint: it does NOT respond until the human sends
	 * a message via the normal chat message endpoint. The connection is held open
	 * for up to HITL_TIMEOUT_MS (30 min). On timeout it returns 408.
	 *
	 * Flow:
	 *   1. Sandbox POSTs { prompt, options? } here.
	 *   2. proxyService.submitHitlRequest() stores the pending resolver + emits
	 *      a `hitl_request` SSE event so the browser unlocks the chat input.
	 *   3. Route handler awaits the promise.
	 *   4. Human types a reply → POST /:agentId/threads/:threadId/messages detects
	 *      the pending HITL, calls resolveHitlRequest(), and does NOT spawn a child.
	 *   5. Promise resolves here → response { response: string } returned to sandbox.
	 */
	router.post('/internal/hitl/request', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { prompt, options } = req.body as HitlRequest;

		if (!prompt) {
			res.status(400).json({ success: false, error: 'prompt is required' });
			return;
		}

		logger.info(
			{ agentId: sandboxToken.agentId, threadId: sandboxToken.threadId },
			'[runtime] HITL request received from sandbox',
		);

		try {
			const humanResponse = await proxyService.submitHitlRequest(sandboxToken.threadId, {
				prompt,
				options,
			});
			res.json({ success: true, data: { response: humanResponse } });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'HITL request failed';
			logger.warn(
				{ err, threadId: sandboxToken.threadId },
				'[runtime] HITL request failed or timed out',
			);
			res.status(408).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/browser/action
	 * Drives the host-managed browser on behalf of the sandbox — one BrowserCommand
	 * per call. The authoritative hard gate (BROWSER_FEATURE_ENABLED + a LIVE DB
	 * read of the agent's allowInternetAccess) lives in BrowserService.execute, so
	 * a runtime whose agent had internet access revoked mid-session is refused here,
	 * not merely by the absence of the browser tools. agentId/threadId come from the
	 * verified PROXY_TOKEN — never from the request body.
	 */
	router.post('/internal/browser/action', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const body = req.body as BrowserActionRequest;

		if (!body?.command?.action) {
			res.status(400).json({ success: false, error: 'command.action is required' });
			return;
		}

		try {
			const result = await browserService.execute(sandboxToken, body);
			res.json({ success: true, data: result });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Browser action failed';
			logger.warn(
				{ err, agentId: sandboxToken.agentId, threadId: sandboxToken.threadId },
				'[runtime] browser action failed',
			);
			res.status(400).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/mcp/call-tool
	 * Invokes one tool on an assigned MCP server on behalf of the sandbox. The
	 * live connection + secrets live host-side in McpService, which re-checks on
	 * every call that the server is still owned, enabled, assigned to this agent,
	 * and that the tool is enabled. agentId/ownerId come from the verified
	 * PROXY_TOKEN — never from the request body.
	 */
	router.post('/internal/mcp/call-tool', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const body = req.body as McpCallToolRequest;

		if (!body?.serverId || !body?.toolName) {
			res.status(400).json({ success: false, error: 'serverId and toolName are required' });
			return;
		}

		try {
			const result = await mcpService.callTool(
				sandboxToken.ownerId,
				sandboxToken.agentId,
				body.serverId,
				body.toolName,
				body.args ?? {},
			);
			res.json({ success: true, data: result });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'MCP tool call failed';
			logger.warn(
				{ err, agentId: sandboxToken.agentId, serverId: body?.serverId, toolName: body?.toolName },
				'[runtime] mcp call-tool failed',
			);
			res.status(400).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/files/share
	 * Agent shares a file from its workspace back to the user. The host reads the
	 * file from the agent's workspace (mounted backend-side), copies it into the
	 * chat-files host volume, links it to the most recent message, and emits a
	 * `file_shared` SSE event so the chat renders it live. agentId/ownerId/threadId
	 * come from the verified PROXY_TOKEN — never from the body.
	 */
	router.post('/internal/files/share', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { path: relPath } = req.body as { path?: string };

		if (!relPath || typeof relPath !== 'string') {
			res.status(400).json({ success: false, error: 'path is required' });
			return;
		}

		try {
			const workspacePath = runtimeService.getWorkspacePath(sandboxToken.agentId);
			// Link to the latest ASSISTANT message so the attachment renders under the
			// agent's bubble (a later tool_result in the same turn would not render).
			const messageId = await sessionService.getLatestMessageId(sandboxToken.threadId, 'assistant');
			const file = await chatFileService.registerAgentOutput({
				agentId: sandboxToken.agentId,
				ownerId: sandboxToken.ownerId,
				threadId: sandboxToken.threadId,
				messageId,
				workspacePath,
				relPath,
			});
			agentStreamBus.emit(sandboxToken.threadId, { type: 'file_shared', file });
			res.status(201).json({ success: true, data: file });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to share file';
			logger.warn(
				{ err, agentId: sandboxToken.agentId, threadId: sandboxToken.threadId },
				'[runtime] share file failed',
			);
			res.status(400).json({ success: false, error: message });
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// User-facing routes — JWT auth
	// ownerId is always derived from req.user.sub (set by requireAuth).
	// Client-supplied ownerId values in body/query are never trusted.
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * POST /v1/runtime/:agentId/threads
	 * Create a new chat thread.
	 *
	 * Previous-thread summarization into long-term memory is NOT triggered here —
	 * the MessagePipeline fires it on the thread's first user message, so threads
	 * created by any channel (web, telegram, discord) summarize exactly once.
	 */
	router.post('/:agentId/threads', auth, async (req: Request, res: Response) => {
		const { agentId } = req.params as { agentId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { title } = req.body as { title?: string };

		try {
			const thread = await sessionService.createThread({ agentId, ownerId, title });
			const body: AgentThreadResponse = { success: true, data: thread };
			res.status(201).json(body);
		} catch (err) {
			logger.error({ err }, '[runtime] failed to create thread');
			res.status(500).json({ success: false, error: 'Failed to create thread' });
		}
	});

	/**
	 * PATCH /v1/runtime/:agentId/threads/:threadId
	 * Rename a thread. Body: { title: string }
	 */
	router.patch('/:agentId/threads/:threadId', auth, async (req: Request, res: Response) => {
		const { agentId, threadId } = req.params as { agentId: string; threadId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		const { title } = req.body as RenameThreadRequestBody;
		if (!title || typeof title !== 'string' || !title.trim()) {
			res.status(400).json({ success: false, error: 'title is required' });
			return;
		}

		try {
			// Verify ownership and agent-thread relationship
			const thread = await sessionService.getThreadById(threadId, ownerId);
			if (!thread || thread.agentId !== agentId) {
				res.status(404).json({ success: false, error: 'Thread not found' });
				return;
			}

			await sessionService.updateThreadTitle(threadId, ownerId, title.trim());
			const updated = await sessionService.getThreadById(threadId, ownerId);
			const body: AgentThreadResponse = { success: true, data: updated! };
			res.json(body);
		} catch (err) {
			logger.error({ err, threadId }, '[runtime] failed to rename thread');
			res.status(500).json({ success: false, error: 'Failed to rename thread' });
		}
	});

	/**
	 * PATCH /v1/runtime/:agentId/threads/:threadId/pin
	 * Pin or unpin a thread. Body: { isPinned: boolean }
	 */
	router.patch('/:agentId/threads/:threadId/pin', auth, async (req: Request, res: Response) => {
		const { agentId, threadId } = req.params as { agentId: string; threadId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		const { isPinned } = req.body as { isPinned?: unknown };
		if (typeof isPinned !== 'boolean') {
			res.status(400).json({ success: false, error: 'isPinned (boolean) is required' });
			return;
		}

		try {
			// Verify ownership and agent-thread relationship
			const thread = await sessionService.getThreadById(threadId, ownerId);
			if (!thread || thread.agentId !== agentId) {
				res.status(404).json({ success: false, error: 'Thread not found' });
				return;
			}

			const updated = await sessionService.pinThread(threadId, ownerId, isPinned);
			if (!updated) {
				res.status(404).json({ success: false, error: 'Thread not found' });
				return;
			}
			const body: AgentThreadResponse = { success: true, data: updated };
			res.json(body);
		} catch (err) {
			logger.error({ err, threadId }, '[runtime] failed to pin/unpin thread');
			res.status(500).json({ success: false, error: 'Failed to update pin status' });
		}
	});

	/**
	 * DELETE /v1/runtime/:agentId/threads/:threadId
	 * Delete a thread and all its messages.
	 */
	router.delete('/:agentId/threads/:threadId', auth, async (req: Request, res: Response) => {
		const { agentId, threadId } = req.params as { agentId: string; threadId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		try {
			// Verify ownership and agent-thread relationship
			const thread = await sessionService.getThreadById(threadId, ownerId);
			if (!thread || thread.agentId !== agentId) {
				const body: AgentThreadDeleteResponse = { success: false, error: 'Thread not found' };
				res.status(404).json(body);
				return;
			}

			const deleted = await sessionService.deleteThread(threadId, ownerId);
			if (!deleted) {
				const body: AgentThreadDeleteResponse = { success: false, error: 'Thread not found' };
				res.status(404).json(body);
				return;
			}
			// Close any open browser session for this thread (frees the context +
			// saves its state). Best-effort — never blocks the delete response.
			void browserService.closeSession(threadId);
			const body: AgentThreadDeleteResponse = { success: true, data: { deleted: true } };
			res.json(body);
		} catch (err) {
			logger.error({ err, threadId }, '[runtime] failed to delete thread');
			res.status(500).json({ success: false, error: 'Failed to delete thread' });
		}
	});

	/**
	 * GET /v1/runtime/:agentId/threads
	 * List all threads for an agent.
	 */
	router.get('/:agentId/threads', auth, async (req: Request, res: Response) => {
		const { agentId } = req.params as { agentId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		try {
			const threads = await sessionService.listThreads(agentId, ownerId);
			const body: AgentThreadsListResponse = { success: true, data: threads };
			res.json(body);
		} catch (err) {
			logger.error({ err, agentId }, '[runtime] failed to list threads');
			res.status(500).json({ success: false, error: 'Failed to list threads' });
		}
	});

	/**
	 * POST /v1/runtime/:agentId/threads/:threadId/messages
	 * Send a user message to a thread and spawn a container to process it.
	 *
	 * The web channel goes through the same MessagePipeline as every external
	 * channel (HITL resolution, concurrency guard, persistence, auto-title,
	 * previous-thread summarization, spawn). The route only does what the
	 * adapters do for their platforms: authenticate and resolve identity.
	 */
	router.post('/:agentId/threads/:threadId/messages', auth, async (req: Request, res: Response) => {
		const { agentId, threadId } = req.params as { agentId: string; threadId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		try {
			// Verify thread belongs to the authenticated user and to the requested
			// agent — prevents cross-user/cross-agent access via URL manipulation.
			const thread = await sessionService.getThreadById(threadId, ownerId);
			if (!thread || thread.agentId !== agentId) {
				res.status(404).json({ success: false, error: 'Thread not found' });
				return;
			}

			const inbound = await webAdapter.handleInbound({
				rawBody: req.body,
				headers: req.headers,
				params: { agentId, threadId, userId: ownerId },
				query: {},
			});

			if (!inbound) {
				res.status(400).json({ success: false, error: 'content is required' });
				return;
			}

			const result = await messagePipeline.process(inbound, webAdapter);

			if (!result.ok) {
				res.status(result.status).json({ success: false, error: result.error });
				return;
			}

			res.status(201).json({ success: true, data: result.userMessage });
		} catch (err) {
			logger.error({ err, agentId, threadId }, '[runtime] failed to send message');
			res.status(500).json({ success: false, error: 'Failed to send message' });
		}
	});

	/**
	 * POST /v1/runtime/:agentId/threads/:threadId/cancel
	 * Stop the current (or stuck) turn and return the thread to 'idle'.
	 *
	 * Kills the live runtime process/container if one exists; otherwise (the run
	 * already exited, or was orphaned by a crash that left the row stuck at
	 * 'running') it just reconciles the thread state so the user can send again.
	 */
	router.post('/:agentId/threads/:threadId/cancel', auth, async (req: Request, res: Response) => {
		const { agentId, threadId } = req.params as { agentId: string; threadId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		try {
			// Verify ownership and agent-thread relationship before stopping anything.
			const thread = await sessionService.getThreadById(threadId, ownerId);
			if (!thread || thread.agentId !== agentId) {
				res.status(404).json({ success: false, error: 'Thread not found' });
				return;
			}

			await runtimeService.cancelTurn(threadId);
			const updated = await sessionService.getThreadById(threadId, ownerId);
			const body: AgentThreadResponse = { success: true, data: updated! };
			res.json(body);
		} catch (err) {
			logger.error({ err, agentId, threadId }, '[runtime] failed to cancel turn');
			res.status(500).json({ success: false, error: 'Failed to stop the agent' });
		}
	});

	/**
	 * GET /v1/runtime/:agentId/threads/:threadId/messages
	 * Get the full message history for a thread.
	 */
	router.get('/:agentId/threads/:threadId/messages', auth, async (req: Request, res: Response) => {
		const { agentId, threadId } = req.params as { agentId: string; threadId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		try {
			// Verify thread ownership and that it belongs to the requested agent
			const thread = await sessionService.getThreadById(threadId, ownerId);
			if (!thread || thread.agentId !== agentId) {
				res.status(404).json({ success: false, error: 'Thread not found' });
				return;
			}

			const messages = await sessionService.listMessages(threadId, ownerId);
			const body: AgentMessagesListResponse = { success: true, data: messages };
			res.json(body);
		} catch (err) {
			logger.error({ err, threadId }, '[runtime] failed to get messages');
			res.status(500).json({ success: false, error: 'Failed to get messages' });
		}
	});

	// ─── Chat file routes ─────────────────────────────────────────────────────

	/**
	 * Verify a thread belongs to the authenticated owner and the requested agent.
	 * Returns true when ok; otherwise writes a 404 and returns false.
	 */
	const verifyThread = async (
		agentId: string,
		threadId: string,
		ownerId: string,
		res: Response,
	): Promise<boolean> => {
		const thread = await sessionService.getThreadById(threadId, ownerId);
		if (!thread || thread.agentId !== agentId) {
			res.status(404).json({ success: false, error: 'Thread not found' });
			return false;
		}
		return true;
	};

	/**
	 * POST /v1/runtime/:agentId/threads/:threadId/files
	 * Multipart upload (field name: files) of attachments for a thread. Image
	 * uploads are rejected when the agent's model has no vision capability.
	 * Returns the created rows; document text extraction runs in the background.
	 */
	router.post('/:agentId/threads/:threadId/files', auth, (req: Request, res: Response) => {
		const { agentId, threadId } = req.params as { agentId: string; threadId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		upload.array('files', MAX_CHAT_FILES_PER_REQUEST)(req, res, async (err?: unknown) => {
			if (err) {
				const message =
					err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
						? `File exceeds the ${MAX_CHAT_FILE_BYTES / (1024 * 1024)}MB limit.`
						: err instanceof Error
							? err.message
							: 'Upload failed.';
				res.status(400).json({ success: false, error: message });
				return;
			}

			if (!(await verifyThread(agentId, threadId, ownerId, res))) return;

			const files = (req.files ?? []) as Express.Multer.File[];
			if (files.length === 0) {
				res.status(400).json({ success: false, error: 'No files uploaded.' });
				return;
			}

			const uploads: ChatUploadInput[] = files.map((file) => ({
				// Multer decodes the original name as latin1 — re-decode as UTF-8.
				name: Buffer.from(file.originalname, 'latin1').toString('utf8'),
				mimeType: file.mimetype,
				sizeBytes: file.size,
				data: file.buffer,
			}));

			try {
				const created = await chatFileService.saveUploads(agentId, ownerId, threadId, uploads);
				const body: ChatFileUploadResponse = { success: true, data: created };
				res.status(201).json(body);
			} catch (uploadErr) {
				const message = uploadErr instanceof Error ? uploadErr.message : 'Upload failed.';
				res.status(400).json({ success: false, error: message });
			}
		});
	});

	/**
	 * GET /v1/runtime/:agentId/threads/:threadId/files
	 * List a thread's files (uploads + agent-shared), oldest first.
	 */
	router.get('/:agentId/threads/:threadId/files', auth, async (req: Request, res: Response) => {
		const { agentId, threadId } = req.params as { agentId: string; threadId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		if (!(await verifyThread(agentId, threadId, ownerId, res))) return;

		const files = await chatFileService.listForThread(threadId, ownerId);
		const body: ChatFilesListResponse = { success: true, data: files };
		res.json(body);
	});

	/**
	 * GET /v1/runtime/:agentId/threads/:threadId/files/:fileId
	 * Stream a file's bytes. Inline by default (images render in-page, PDFs preview);
	 * pass ?download=1 for an attachment download.
	 */
	router.get(
		'/:agentId/threads/:threadId/files/:fileId',
		auth,
		async (req: Request, res: Response) => {
			const { agentId, threadId, fileId } = req.params as {
				agentId: string;
				threadId: string;
				fileId: string;
			};
			const ownerId = req.user?.sub;
			if (!ownerId) {
				res.status(401).json({ success: false, error: 'Unauthorized' });
				return;
			}
			if (!(await verifyThread(agentId, threadId, ownerId, res))) return;

			const file = await chatFileService.getForOwner(fileId, ownerId);
			if (!file || file.threadId !== threadId) {
				res.status(404).json({ success: false, error: 'File not found' });
				return;
			}

			try {
				const bytes = chatFileService.readBytes(file);
				// Re-derive a specific Content-Type when the stored one is generic, so
				// PDFs/images preview inline instead of triggering a download.
				const serveMime = resolveServeMimeType(file.name, file.mimeType);
				// Never render user/agent-controlled HTML inline (stored-XSS guard) — force
				// a download for it regardless of the inline default. Other types preview
				// inline unless ?download=1 was requested.
				const forceAttachment = serveMime === 'text/html';
				const disposition = req.query.download === '1' || forceAttachment ? 'attachment' : 'inline';
				res.setHeader('Content-Type', serveMime);
				// Stop the browser from MIME-sniffing the bytes into an executable type.
				res.setHeader('X-Content-Type-Options', 'nosniff');
				res.setHeader(
					'Content-Disposition',
					`${disposition}; filename="${encodeURIComponent(file.name)}"`,
				);
				res.setHeader('Cache-Control', 'private, max-age=3600');
				res.send(bytes);
			} catch (err) {
				logger.error({ err, fileId }, '[runtime] failed to serve chat file');
				res.status(404).json({ success: false, error: 'File not found' });
			}
		},
	);

	/**
	 * DELETE /v1/runtime/:agentId/threads/:threadId/files/:fileId
	 * Delete a chat file (row + bytes + extracted-text sidecar).
	 */
	router.delete(
		'/:agentId/threads/:threadId/files/:fileId',
		auth,
		async (req: Request, res: Response) => {
			const { agentId, threadId, fileId } = req.params as {
				agentId: string;
				threadId: string;
				fileId: string;
			};
			const ownerId = req.user?.sub;
			if (!ownerId) {
				res.status(401).json({ success: false, error: 'Unauthorized' });
				return;
			}
			if (!(await verifyThread(agentId, threadId, ownerId, res))) return;

			const file = await chatFileService.getForOwner(fileId, ownerId);
			if (!file || file.threadId !== threadId) {
				res.status(404).json({ success: false, error: 'File not found' });
				return;
			}
			const deleted = await chatFileService.delete(fileId, ownerId);
			const body: ChatFileDeleteResponse = { success: true, data: { deleted } };
			res.json(body);
		},
	);

	/**
	 * GET /v1/runtime/:agentId/threads/:threadId/stream
	 * SSE endpoint — browser subscribes here to receive real-time agent events.
	 *
	 * Connection lifecycle:
	 *   1. Browser connects → SSE headers set, subscribe to AgentStreamBus for this thread
	 *   2. Agent events emitted via AgentStreamBus → written as SSE data frames
	 *   3. On browser disconnect → unsubscribe and clear heartbeat
	 */
	router.get('/:agentId/threads/:threadId/stream', auth, async (req: Request, res: Response) => {
		const { agentId, threadId } = req.params as { agentId: string; threadId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		try {
			// Verify ownership and agent match before opening the SSE connection
			const thread = await sessionService.getThreadById(threadId, ownerId);
			if (!thread || thread.agentId !== agentId) {
				res.status(404).json({ success: false, error: 'Thread not found' });
				return;
			}

			// SSE headers
			res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache');
			res.setHeader('Connection', 'keep-alive');
			res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
			res.flushHeaders();

			// Suggest a 3s reconnect backoff to the browser's EventSource.
			res.write('retry: 3000\n\n');

			// Observable heartbeat every 15s. A named `ping` event (not a bare `:`
			// comment) is visible to the browser's EventSource, so the client-side
			// watchdog can tell a live-but-quiet turn from a dead connection and force
			// a reconnect. It also keeps idle proxies from closing the socket.
			const heartbeat = setInterval(() => {
				res.write('event: ping\ndata: {}\n\n');
			}, 15_000);

			const unsubscribe = agentStreamBus.subscribe(threadId, (event) => {
				res.write(`data: ${JSON.stringify(event)}\n\n`);
			});

			// If the turn already finished before this connection was established —
			// e.g. the client reconnected after completion, or is opening a thread
			// that isn't running — emit a `done` immediately so the UI never hangs
			// waiting for an event that already fired while it was disconnected.
			// A live ('running') turn keeps streaming through the subscription above.
			if (thread.status !== 'running') {
				res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
			}

			req.on('close', () => {
				clearInterval(heartbeat);
				unsubscribe();
			});
		} catch (err) {
			logger.error({ err, threadId }, '[runtime] failed to setup stream');
			res.status(500).json({ success: false, error: 'Failed to setup stream' });
		}
	});

	// ─── Trigger Routes ───────────────────────────────────────────────────────

	/**
	 * POST /v1/runtime/:agentId/triggers
	 * Create a new trigger for an agent.
	 */
	router.post('/:agentId/triggers', auth, async (req: Request, res: Response) => {
		const { agentId } = req.params as { agentId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { kind, name, config, description } = req.body as CreateTriggerRequestBody;

		if (!kind || !name || !config) {
			const body: AgentTriggerResponse = {
				success: false,
				error: 'kind, name and config are required',
			};
			res.status(400).json(body);
			return;
		}

		try {
			const trigger = await triggerService.create({
				agentId,
				ownerId,
				kind,
				name,
				config,
				description,
			});
			const body: AgentTriggerResponse = { success: true, data: trigger };
			res.status(201).json(body);
		} catch (err) {
			logger.error({ err }, '[runtime] failed to create trigger');
			res.status(500).json({ success: false, error: 'Failed to create trigger' });
		}
	});

	/**
	 * GET /v1/runtime/:agentId/triggers
	 * List all triggers for an agent.
	 */
	router.get('/:agentId/triggers', auth, async (req: Request, res: Response) => {
		const { agentId } = req.params as { agentId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		try {
			const triggers = await triggerService.listByAgent(agentId, ownerId);
			const body: AgentTriggersListResponse = { success: true, data: triggers };
			res.json(body);
		} catch (err) {
			logger.error({ err, agentId }, '[runtime] failed to list triggers');
			res.status(500).json({ success: false, error: 'Failed to list triggers' });
		}
	});

	/**
	 * PUT /v1/runtime/:agentId/triggers/:triggerId
	 * Update a trigger.
	 */
	router.put('/:agentId/triggers/:triggerId', auth, async (req: Request, res: Response) => {
		const { triggerId } = req.params as { triggerId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		try {
			const trigger = await triggerService.update(
				triggerId,
				ownerId,
				req.body as UpdateTriggerRequestBody,
			);
			if (!trigger) {
				res.status(404).json({ success: false, error: 'Trigger not found' });
				return;
			}
			const body: AgentTriggerResponse = { success: true, data: trigger };
			res.json(body);
		} catch (err) {
			logger.error({ err }, '[runtime] failed to update trigger');
			res.status(500).json({ success: false, error: 'Failed to update trigger' });
		}
	});

	/**
	 * DELETE /v1/runtime/:agentId/triggers/:triggerId
	 * Delete a trigger.
	 */
	router.delete('/:agentId/triggers/:triggerId', auth, async (req: Request, res: Response) => {
		const { triggerId } = req.params as { triggerId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		try {
			const deleted = await triggerService.delete(triggerId, ownerId);
			if (!deleted) {
				const body: AgentTriggerDeleteResponse = { success: false, error: 'Trigger not found' };
				res.status(404).json(body);
				return;
			}
			const body: AgentTriggerDeleteResponse = { success: true, data: { deleted: true } };
			res.json(body);
		} catch (err) {
			logger.error({ err, triggerId }, '[runtime] failed to delete trigger');
			res.status(500).json({ success: false, error: 'Failed to delete trigger' });
		}
	});

	/**
	 * POST /v1/runtime/:agentId/triggers/:triggerId/fire
	 * Manually fire a trigger (only valid for kind='manual').
	 */
	router.post('/:agentId/triggers/:triggerId/fire', auth, async (req: Request, res: Response) => {
		const { triggerId } = req.params as { triggerId: string };
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}

		try {
			await triggerService.fireManualTrigger(triggerId, ownerId);
			res.json({ success: true, data: { fired: true } });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to fire trigger';
			logger.warn({ err, triggerId }, '[runtime] failed to fire manual trigger');
			res.status(400).json({ success: false, error: message });
		}
	});

	// ─── Workflow internal endpoints (PROXY_TOKEN auth) ──────────────────────

	/**
	 * POST /v1/runtime/internal/workflow/step-start
	 * Sandbox logs the start of a workflow step.
	 * Returns { stepLogId } for use in the corresponding step-end call.
	 */
	router.post('/internal/workflow/step-start', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { runId, stepId, stepIndex, stepName, inputContext, attemptNumber } = req.body as {
			runId: string;
			stepId: string;
			stepIndex: number;
			stepName: string;
			inputContext: Record<string, unknown>;
			attemptNumber?: number;
		};

		if (!runId || !stepId || stepIndex === undefined || !stepName) {
			res
				.status(400)
				.json({ success: false, error: 'runId, stepId, stepIndex, stepName are required' });
			return;
		}

		try {
			// Verify the run belongs to the sandbox's agent
			const run = await workflowRunService.getRunByIdInternal(runId);
			if (!run || run.agentId !== sandboxToken.agentId) {
				res.status(403).json({ success: false, error: 'Workflow run not found or access denied' });
				return;
			}

			const stepLog = await workflowRunService.startStepLog({
				runId,
				stepId,
				stepIndex,
				stepName,
				inputContext: inputContext ?? {},
				attemptNumber,
			});
			res.status(201).json({ success: true, data: { stepLogId: stepLog.id } });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Workflow step start failed';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] workflow step start failed');
			res.status(500).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/workflow/step-end
	 * Sandbox logs the completion (success, failed, or skipped) of a workflow step.
	 */
	router.post('/internal/workflow/step-end', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { stepLogId, status, outputData, error } = req.body as {
			stepLogId: string;
			status: string;
			outputData?: Record<string, unknown>;
			error?: string;
		};

		if (!stepLogId || !status) {
			res.status(400).json({ success: false, error: 'stepLogId and status are required' });
			return;
		}

		try {
			await workflowRunService.completeStepLog(stepLogId, {
				status: status as 'running' | 'success' | 'failed' | 'skipped',
				outputData,
				error,
			});
			res.json({ success: true, data: { updated: true } });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Workflow step end failed';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] workflow step end failed');
			res.status(500).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/workflow/run-complete
	 * Sandbox marks the entire workflow run as completed or errored.
	 */
	router.post('/internal/workflow/run-complete', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { runId, status, error } = req.body as {
			runId: string;
			status: string;
			error?: string;
		};

		if (!runId || !status) {
			res.status(400).json({ success: false, error: 'runId and status are required' });
			return;
		}

		try {
			// Verify the run belongs to this agent before allowing completion
			const run = await workflowRunService.getRunByIdInternal(runId);
			if (!run || run.agentId !== sandboxToken.agentId) {
				res.status(403).json({ success: false, error: 'Workflow run not found or access denied' });
				return;
			}

			await workflowRunService.completeRun(runId, status as 'completed' | 'error', error);
			res.json({ success: true, data: { completed: true } });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Workflow run complete failed';
			logger.error(
				{ err, agentId: sandboxToken.agentId },
				'[runtime] workflow run complete failed',
			);
			res.status(500).json({ success: false, error: message });
		}
	});

	// ─── Workflow agent tool endpoints (PROXY_TOKEN auth) ────────────────────

	/**
	 * POST /v1/runtime/internal/workflow/create
	 * Sandbox creates a new workflow for this agent.
	 *
	 * The agent provides name, description, and step definitions. Steps are
	 * mapped to full WorkflowStep objects with UUIDs generated here on the host.
	 * The workflow is validated by WorkflowService.create() (Zod) before insert.
	 * Returns the created Workflow object including its generated ID.
	 *
	 * Security: agentId and ownerId are derived from the PROXY_TOKEN — the sandbox
	 * can only create workflows for its own agent.
	 */
	router.post('/internal/workflow/create', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { name, description, steps, graph, trigger } = req.body as {
			name: string;
			description?: string;
			steps?: Array<{
				name: string;
				instruction: string;
				allowedTools?: string[];
				allTools?: boolean;
				allowedCredentialIds?: string[];
				allCredentials?: boolean;
				errorHandlingAction?: 'stop' | 'continue' | 'retry';
			}>;
			graph?: WorkflowSpec;
			trigger?: {
				kind?: 'cron' | 'webhook' | 'manual';
				name?: string;
				config?: Record<string, unknown>;
				description?: string;
			};
		};

		const hasGraph = !!graph && Array.isArray(graph.nodes) && graph.nodes.length > 0;
		const hasSteps = Array.isArray(steps) && steps.length > 0;
		if (!name || (!hasGraph && !hasSteps)) {
			res.status(400).json({
				success: false,
				error: 'name and either `steps` (linear) or `graph` (branching/looping) are required',
			});
			return;
		}

		try {
			// WorkflowService defaults the trigger to manual if omitted.
			const triggerInput = trigger
				? {
						kind: trigger.kind,
						name: trigger.name,
						config: trigger.config as import('@repo/types').AgentTriggerConfig | undefined,
						description: trigger.description,
					}
				: undefined;

			let workflow;
			if (hasGraph) {
				// High-level spec → real node/edge graph. UUIDs are generated host-side by
				// specToGraph, which also wires handles, the loop back-edge, and positions.
				const { nodes, edges } = specToGraph(graph!);
				workflow = await workflowService.create({
					agentId: sandboxToken.agentId,
					ownerId: sandboxToken.ownerId,
					name,
					description,
					nodes,
					edges,
					isEnabled: true,
					trigger: triggerInput,
				});
			} else {
				// Linear steps — host generates UUIDs so the sandbox cannot inject arbitrary IDs.
				const { randomUUID } = await import('crypto');
				const workflowSteps: WorkflowStep[] = steps!.map((s) => ({
					id: randomUUID(),
					name: s.name,
					instruction: s.instruction,
					allowedTools: s.allowedTools ?? [],
					allTools: s.allTools ?? false,
					allowedCredentialIds: s.allowedCredentialIds ?? [],
					allCredentials: s.allCredentials ?? false,
					errorHandling: {
						action: (s.errorHandlingAction ?? 'stop') as 'stop' | 'continue' | 'retry',
					},
				}));
				workflow = await workflowService.create({
					agentId: sandboxToken.agentId,
					ownerId: sandboxToken.ownerId,
					name,
					description,
					steps: workflowSteps,
					isEnabled: true,
					trigger: triggerInput,
				});
			}

			// Schedule the cron job immediately if the trigger is of kind 'cron'.
			// WorkflowService cannot do this itself (circular dep with TriggerService),
			// so the route layer is responsible for calling scheduleFromWorkflow.
			if (workflow.trigger) {
				triggerService.scheduleFromWorkflow(workflow.trigger);
			}

			res.status(201).json({ success: true, data: workflow });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to create workflow';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] workflow create failed');
			res.status(400).json({ success: false, error: message });
		}
	});

	/**
	 * GET /v1/runtime/internal/workflow/list
	 * Sandbox lists enabled workflows belonging to this agent.
	 * The agent can use this to discover what workflows are available to trigger.
	 */
	router.get('/internal/workflow/list', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;

		try {
			// Fetch all workflows for the agent, then map to WorkflowSummary (no steps exposed)
			const workflows = await workflowService.listByAgentInternal(sandboxToken.agentId);
			const summaries: WorkflowSummary[] = workflows
				.filter((w) => w.isEnabled)
				.map((w) => ({
					id: w.id,
					name: w.name,
					description: w.description,
					stepCount: w.nodes.filter((n) => n.type === 'agent').length,
					conditionCount: w.nodes.filter((n) => n.type === 'condition').length,
					loopCount: w.nodes.filter((n) => n.type === 'loop').length,
					triggerKind: w.trigger?.kind,
					isEnabled: w.isEnabled,
				}));
			res.json({ success: true, data: summaries });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to list workflows';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] workflow list failed');
			res.status(500).json({ success: false, error: message });
		}
	});

	/**
	 * GET /v1/runtime/internal/workflow/:workflowId
	 * Sandbox reads the full definition of a single workflow (including all steps).
	 * Only workflows belonging to this agent are accessible.
	 */
	router.get('/internal/workflow/:workflowId', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { workflowId } = req.params as { workflowId: string };

		try {
			const workflow = await workflowService.getByIdInternal(workflowId);
			if (!workflow || workflow.agentId !== sandboxToken.agentId) {
				res.status(404).json({ success: false, error: 'Workflow not found' });
				return;
			}
			res.json({ success: true, data: workflow });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to read workflow';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] workflow read failed');
			res.status(500).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/workflow/:workflowId/trigger
	 * Sandbox triggers a workflow run directly (without needing a pre-created trigger row).
	 * Creates a workflow_run record and spawns a new child process with workflow config.
	 * Returns immediately with { runId } — execution is fire-and-forget.
	 * Only enabled workflows belonging to this agent can be triggered.
	 */
	router.post('/internal/workflow/:workflowId/trigger', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { workflowId } = req.params as { workflowId: string };
		const { payload } = req.body as { payload?: Record<string, unknown> };

		try {
			const workflow = await workflowService.getByIdInternal(workflowId);
			if (!workflow || workflow.agentId !== sandboxToken.agentId) {
				res.status(404).json({ success: false, error: 'Workflow not found' });
				return;
			}
			if (!workflow.isEnabled) {
				res.status(400).json({ success: false, error: 'Workflow is disabled' });
				return;
			}

			const firedAt = new Date().toISOString();
			const triggerPayload: Record<string, unknown> = payload ?? { firedAt };

			// Create a run record
			const run = await workflowRunService.createRun({
				workflowId: workflow.id,
				agentId: sandboxToken.agentId,
				ownerId: sandboxToken.ownerId,
				triggerType: 'manual',
				triggerPayload,
			});

			// Build trigger context
			const triggerContext: WorkflowTriggerContext = {
				type: 'manual',
				triggerName: 'Agent-initiated',
				firedAt,
				payload: triggerPayload,
			};

			// Create a thread to house the sandbox spawn.
			// Marked as a workflow thread so users can filter it out in the chat history.
			const thread = await sessionService.createThread({
				agentId: sandboxToken.agentId,
				ownerId: sandboxToken.ownerId,
				title: `${workflow.name} — ${firedAt}`,
				triggerType: 'manual',
				triggerPayload,
				isWorkflowThread: true,
			});

			// Spawn child process (fire-and-forget) — do not await the response on it,
			// but never drop the outcome: spawnForThread returns false (the specific
			// reason is logged inside it) without throwing, so a bare .catch() would
			// silently leave the run 'running' forever. Log and reconcile both paths.
			runtimeService
				.spawnForThread(
					sandboxToken.agentId,
					thread.id,
					sandboxToken.ownerId,
					'manual',
					triggerPayload,
					undefined,
					{ runId: run.id, definition: workflow, triggerContext },
				)
				.then(async (spawned) => {
					if (!spawned) {
						logger.error(
							{ runId: run.id, workflowId, agentId: sandboxToken.agentId, threadId: thread.id },
							'[runtime] agent-triggered workflow failed to start',
						);
						await workflowRunService
							.completeRun(run.id, 'error', 'Runtime could not be started for workflow run')
							.catch((reconcileErr: Error) =>
								logger.error(
									{ err: reconcileErr, runId: run.id },
									'[runtime] failed to mark agent-triggered workflow run as errored',
								),
							);
					}
				})
				.catch(async (spawnErr: Error) => {
					logger.error(
						{ spawnErr, runId: run.id, agentId: sandboxToken.agentId, workflowId },
						'[runtime] agent-triggered workflow spawn threw',
					);
					await workflowRunService
						.completeRun(
							run.id,
							'error',
							spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
						)
						.catch(() => {});
				});

			res.status(201).json({ success: true, data: { runId: run.id } });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to trigger workflow';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] workflow trigger failed');
			res.status(500).json({ success: false, error: message });
		}
	});

	// ─── Agent-to-agent messaging endpoints (PROXY_TOKEN auth) ────────────────

	/**
	 * GET /v1/runtime/internal/agents
	 * Sandbox lists the agents the current agent is permitted to message (its
	 * collaborator allow-list). Powers the list_agents tool. agentId is derived from
	 * the PROXY_TOKEN — an agent can only see its own collaborators.
	 */
	router.get('/internal/agents', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		try {
			const collaborators = await messagingService.listCollaborators(sandboxToken.agentId);
			res.json({ success: true, data: collaborators });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to list agents';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] list agents failed');
			res.status(500).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/agent/:targetAgentId/message
	 * Async agent-to-agent hand-off. Spawns the target agent in a new thread and
	 * returns immediately with { threadId, threadUrl }. Caller identity (agent +
	 * thread + owner) comes from the PROXY_TOKEN; the allow-list, delegation depth,
	 * and cycle checks are enforced host-side in AgentMessagingService.
	 */
	router.post('/internal/agent/:targetAgentId/message', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { targetAgentId } = req.params as { targetAgentId: string };
		try {
			const { message, context } = (req.body ?? {}) as AgentMessageRequest;
			const result = await messagingService.sendMessage({
				callerAgentId: sandboxToken.agentId,
				callerThreadId: sandboxToken.threadId,
				ownerId: sandboxToken.ownerId,
				targetAgentId,
				message,
				context,
			});
			if (!result.ok) {
				res.status(result.status).json({ success: false, error: result.error });
				return;
			}
			res.status(201).json({
				success: true,
				data: { threadId: result.threadId, threadUrl: result.threadUrl },
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to message agent';
			logger.error({ err, targetAgentId }, '[runtime] a2a message failed');
			res.status(500).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/agent/:targetAgentId/ask
	 * Agent-to-agent delegation with an answer. Spawns the target agent and returns
	 * 202 { threadId } immediately; the sandbox polls GET /internal/agent/ask/:threadId
	 * for the outcome. (No held connection — undici's default 5-min headersTimeout on
	 * the sandbox side would kill longer delegations.) Same host-side guards as /message.
	 */
	router.post('/internal/agent/:targetAgentId/ask', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { targetAgentId } = req.params as { targetAgentId: string };
		try {
			const { message, context } = (req.body ?? {}) as AgentMessageRequest;
			const result = await messagingService.startAsk({
				callerAgentId: sandboxToken.agentId,
				callerThreadId: sandboxToken.threadId,
				ownerId: sandboxToken.ownerId,
				targetAgentId,
				message,
				context,
			});
			if (!result.ok) {
				res.status(result.status).json({ success: false, error: result.error });
				return;
			}
			res.status(202).json({ success: true, data: { threadId: result.threadId } });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to ask agent';
			logger.error({ err, targetAgentId }, '[runtime] a2a ask failed');
			res.status(500).json({ success: false, error: message });
		}
	});

	/**
	 * GET /v1/runtime/internal/agent/ask/:threadId
	 * Poll a pending ask started via the route above. Returns AgentAskPollResult:
	 * { status: 'running' } while the target works, then 'completed' with the final
	 * text or 'error'. Only the initiating agent+thread (from the PROXY_TOKEN) may
	 * read it.
	 */
	router.get('/internal/agent/ask/:threadId', (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { threadId } = req.params as { threadId: string };
		const result = messagingService.getAskResult(
			sandboxToken.agentId,
			sandboxToken.threadId,
			threadId,
		);
		if (!result.ok) {
			res.status(result.status).json({ success: false, error: result.error });
			return;
		}
		res.json({ success: true, data: result.result });
	});

	// ─── Memory internal endpoints (PROXY_TOKEN auth) ─────────────────────────

	/**
	 * POST /v1/runtime/internal/memory/write
	 * Sandbox writes a memory entry for the current agent.
	 * The host embeds the content and persists it to the DB.
	 * agentId is taken from the PROXY_TOKEN — the sandbox cannot write to another agent's memory.
	 */
	router.post('/internal/memory/write', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const body = req.body as MemoryWriteRequest;

		if (!body.content || !body.memoryType) {
			res.status(400).json({ success: false, error: 'content and memoryType are required' });
			return;
		}

		try {
			const entry = await memoryService.writeMemory(
				sandboxToken.agentId,
				sandboxToken.ownerId,
				body,
			);
			res.status(201).json({ success: true, data: entry });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Memory write failed';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] memory write failed');
			res.status(400).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/memory/search
	 * Sandbox searches the current agent's memory by semantic similarity.
	 * The host embeds the query and returns the nearest entries (cosine distance).
	 * agentId is taken from the PROXY_TOKEN — cannot search another agent's memory.
	 */
	router.post('/internal/memory/search', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const body = req.body as MemorySearchRequest;

		if (!body.query) {
			res.status(400).json({ success: false, error: 'query is required' });
			return;
		}

		try {
			const results = await memoryService.searchMemory(
				sandboxToken.agentId,
				sandboxToken.ownerId,
				body,
			);
			res.json({ success: true, data: results });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Memory search failed';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] memory search failed');
			res.status(400).json({ success: false, error: message });
		}
	});

	/**
	 * POST /v1/runtime/internal/memory/delete
	 * Sandbox deletes one or more memory entries by ID for the current agent.
	 * Body: { memoryIds: string[] }
	 * agentId is taken from the PROXY_TOKEN — the sandbox cannot delete another agent's memory.
	 * Returns { deletedCount: number } — may be less than requested if some IDs were not found.
	 */
	router.post('/internal/memory/delete', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const body = req.body as MemoryDeleteRequest;

		if (!Array.isArray(body.memoryIds) || body.memoryIds.length === 0) {
			res.status(400).json({ success: false, error: 'memoryIds (non-empty array) is required' });
			return;
		}

		// Cap the batch size to prevent abuse
		if (body.memoryIds.length > 100) {
			res
				.status(400)
				.json({ success: false, error: 'memoryIds may contain at most 100 entries per request' });
			return;
		}

		try {
			const deletedCount = await memoryService.deleteMemories(sandboxToken.agentId, body);
			res.json({ success: true, data: { deletedCount } });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Memory delete failed';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] memory delete failed');
			res.status(400).json({ success: false, error: message });
		}
	});

	// ─── Skill trace internal endpoint (PROXY_TOKEN auth) ─────────────────────

	/**
	 * POST /v1/runtime/internal/skills/trace
	 * Sandbox records one skill execution trace per activated skill per turn,
	 * mined later by the evolution engine.
	 * agentId is taken from the PROXY_TOKEN — never from the body, so a sandbox
	 * can only write traces for its own agent.
	 *
	 * Like the other /internal/ routes this bypasses the IP rate limiter
	 * (PROXY_TOKEN is the gate). The runner caps writes at one trace per
	 * activated skill per turn and executionLog is capped at 16 KB, so a
	 * compromised runtime can at worst pollute its own agent's evolution data.
	 */
	router.post('/internal/skills/trace', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const body = req.body as SkillTraceRequestBody;

		if (!body.skillName || typeof body.skillName !== 'string') {
			res.status(400).json({ success: false, error: 'skillName is required' });
			return;
		}
		if (typeof body.success !== 'boolean') {
			res.status(400).json({ success: false, error: 'success (boolean) is required' });
			return;
		}
		if (
			!Number.isInteger(body.toolCallCount) ||
			body.toolCallCount < 0 ||
			body.toolCallCount > 1000
		) {
			res
				.status(400)
				.json({ success: false, error: 'toolCallCount must be an integer between 0 and 1000' });
			return;
		}
		if (body.executionLog !== undefined) {
			const logSize = Buffer.byteLength(JSON.stringify(body.executionLog), 'utf-8');
			if (logSize > 16 * 1024) {
				res.status(400).json({ success: false, error: 'executionLog exceeds the 16 KB limit' });
				return;
			}
		}

		try {
			// The skill must actually be assigned to this agent
			const assigned = await skillService.getAgentSkills(sandboxToken.agentId);
			if (!assigned.includes(body.skillName)) {
				res.status(404).json({ success: false, error: 'Skill is not assigned to this agent' });
				return;
			}

			await skillService.recordTrace({
				agentId: sandboxToken.agentId,
				skillName: body.skillName,
				success: body.success,
				toolCallCount: body.toolCallCount,
				executionLog: body.executionLog,
			});
			res.status(201).json({ success: true, data: { recorded: true } });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Skill trace failed';
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] skill trace failed');
			res.status(400).json({ success: false, error: message });
		}
	});

	// ─── Mission internal endpoints (PROXY_TOKEN auth) ────────────────────────

	/**
	 * Resolve and authorize the mission for a sandbox request. The missionId comes
	 * ONLY from the PROXY_TOKEN (set at spawn) — never from the request body — and
	 * the mission must belong to the token's agent. Responds with the failure and
	 * returns null when the request is not authorized.
	 *
	 * `activeOnly` guards state-changing scheduling calls; journal-style writes
	 * (plan/log/report) are also allowed while paused so an owner steering chat on
	 * a paused mission still works.
	 */
	const requireMission = async (
		req: Request,
		res: Response,
		activeOnly: boolean,
	): Promise<AgentMission | null> => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		if (!sandboxToken.missionId) {
			res.status(403).json({ success: false, error: 'This turn is not part of a mission' });
			return null;
		}
		const mission = await missionService.getByIdInternal(sandboxToken.missionId);
		if (!mission || mission.agentId !== sandboxToken.agentId) {
			res.status(404).json({ success: false, error: 'Mission not found' });
			return null;
		}
		if (activeOnly && mission.status !== 'active') {
			res.status(409).json({ success: false, error: `Mission is ${mission.status}` });
			return null;
		}
		if (!activeOnly && mission.status !== 'active' && mission.status !== 'paused') {
			res.status(409).json({ success: false, error: `Mission is ${mission.status}` });
			return null;
		}
		return mission;
	};

	/**
	 * POST /v1/runtime/internal/mission/plan
	 * Agent rewrites its mission plan document (persistent memory across wakes).
	 */
	router.post('/internal/mission/plan', async (req: Request, res: Response) => {
		const body = req.body as MissionPlanUpdateRequest;
		if (typeof body.plan !== 'string' || body.plan.trim().length === 0) {
			res.status(400).json({ success: false, error: 'plan (non-empty string) is required' });
			return;
		}
		if (body.plan.length > MISSION_PLAN_MAX_LENGTH) {
			res.status(400).json({
				success: false,
				error: `plan exceeds the ${MISSION_PLAN_MAX_LENGTH} character limit — keep it a concise working document`,
			});
			return;
		}
		const mission = await requireMission(req, res, false);
		if (!mission) return;
		try {
			await missionService.setPlanDocument(mission.id, body.plan);
			res.json({ success: true, data: { updated: true } });
		} catch (err) {
			logger.error({ err, missionId: mission.id }, '[runtime] mission plan update failed');
			res.status(500).json({ success: false, error: 'Failed to update the plan document' });
		}
	});

	/**
	 * POST /v1/runtime/internal/mission/log
	 * Agent appends an entry to the mission activity journal (owner-facing feed).
	 */
	router.post('/internal/mission/log', async (req: Request, res: Response) => {
		const body = req.body as MissionLogRequest;
		if (typeof body.title !== 'string' || body.title.trim().length === 0) {
			res.status(400).json({ success: false, error: 'title (non-empty string) is required' });
			return;
		}
		if (body.title.length > 500 || (body.body !== undefined && body.body.length > 10_000)) {
			res.status(400).json({
				success: false,
				error: 'title is capped at 500 characters and body at 10000 characters',
			});
			return;
		}
		const mission = await requireMission(req, res, false);
		if (!mission) return;
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		try {
			const event = await missionService.appendEvent(mission.id, mission.ownerId, {
				type: 'log',
				title: body.title,
				body: body.body,
				data: body.data,
				threadId: sandboxToken.threadId,
			});
			res.status(201).json({ success: true, data: event });
		} catch (err) {
			logger.error({ err, missionId: mission.id }, '[runtime] mission log failed');
			res.status(500).json({ success: false, error: 'Failed to append the journal entry' });
		}
	});

	/**
	 * POST /v1/runtime/internal/mission/schedule
	 * Agent schedules its own next wake. Clamped host-side to the mission's
	 * min/max interval; the response carries the ACTUAL scheduled time. For
	 * fixed-cron missions the request is a no-op that returns the cron-driven
	 * wake time, so the agent learns its schedule is not self-directed.
	 */
	router.post('/internal/mission/schedule', async (req: Request, res: Response) => {
		const body = req.body as MissionScheduleWakeRequest;
		let requested: Date | null = null;
		if (typeof body.at === 'string') {
			const parsed = new Date(body.at);
			if (!Number.isNaN(parsed.getTime())) requested = parsed;
		} else if (typeof body.delayMinutes === 'number' && Number.isFinite(body.delayMinutes)) {
			requested = new Date(Date.now() + Math.max(body.delayMinutes, 0) * 60_000);
		}
		if (!requested) {
			res.status(400).json({
				success: false,
				error: 'Provide either at (ISO datetime) or delayMinutes (number)',
			});
			return;
		}
		const mission = await requireMission(req, res, true);
		if (!mission) return;
		try {
			if (mission.scheduleMode === 'fixed') {
				res.json({
					success: true,
					data: { scheduledAt: mission.nextWakeAt?.toISOString() ?? requested.toISOString() },
				});
				return;
			}
			const actual = await missionService.setNextWake(mission.id, requested, 'agent', body.reason);
			res.json({ success: true, data: { scheduledAt: actual.toISOString() } });
		} catch (err) {
			logger.error({ err, missionId: mission.id }, '[runtime] mission schedule failed');
			res.status(500).json({ success: false, error: 'Failed to schedule the next wake' });
		}
	});

	/**
	 * POST /v1/runtime/internal/mission/complete
	 * Agent declares the mission goal achieved (or permanently unachievable).
	 */
	router.post('/internal/mission/complete', async (req: Request, res: Response) => {
		const body = req.body as MissionCompleteRequest;
		if (typeof body.summary !== 'string' || body.summary.trim().length === 0) {
			res.status(400).json({ success: false, error: 'summary (non-empty string) is required' });
			return;
		}
		const mission = await requireMission(req, res, true);
		if (!mission) return;
		try {
			await missionService.completeFromAgent(mission.id, body.summary.slice(0, 10_000));
			void outboundDeliveryService.deliverToOwner({
				ownerId: mission.ownerId,
				agentId: mission.agentId,
				missionId: mission.id,
				type: 'mission_completed',
				title: `Mission "${mission.title}" completed`,
				body: body.summary.slice(0, 2_000),
				linkPath: `/app/agents/${mission.agentId}/missions/${mission.id}`,
				preferredLinkId: mission.reportChannelLinkId,
			});
			res.json({ success: true, data: { completed: true } });
		} catch (err) {
			logger.error({ err, missionId: mission.id }, '[runtime] mission complete failed');
			res.status(500).json({ success: false, error: 'Failed to complete the mission' });
		}
	});

	/**
	 * POST /v1/runtime/internal/mission/report
	 * Agent sends a proactive progress report to the owner: journal event +
	 * in-app notification + best-effort channel push (Telegram/Discord).
	 */
	router.post('/internal/mission/report', async (req: Request, res: Response) => {
		const body = req.body as MissionReportRequest;
		if (
			typeof body.title !== 'string' ||
			body.title.trim().length === 0 ||
			typeof body.message !== 'string' ||
			body.message.trim().length === 0
		) {
			res.status(400).json({ success: false, error: 'title and message are required' });
			return;
		}
		if (body.title.length > 300 || body.message.length > 8_000) {
			res.status(400).json({
				success: false,
				error: 'title is capped at 300 characters and message at 8000 characters',
			});
			return;
		}
		const mission = await requireMission(req, res, false);
		if (!mission) return;
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		try {
			await missionService.appendEvent(mission.id, mission.ownerId, {
				type: 'report',
				title: body.title,
				body: body.message,
				threadId: sandboxToken.threadId,
			});
			const { channels } = await outboundDeliveryService.deliverToOwner({
				ownerId: mission.ownerId,
				agentId: mission.agentId,
				missionId: mission.id,
				type: 'mission_report',
				title: `${mission.title}: ${body.title}`,
				body: body.message,
				linkPath: `/app/agents/${mission.agentId}/missions/${mission.id}`,
				preferredLinkId: mission.reportChannelLinkId,
			});
			res.status(201).json({ success: true, data: { delivered: channels } });
		} catch (err) {
			logger.error({ err, missionId: mission.id }, '[runtime] mission report failed');
			res.status(500).json({ success: false, error: 'Failed to deliver the report' });
		}
	});

	/**
	 * POST /v1/runtime/internal/mission/approval
	 * Agent raises an ASYNC approval request. Unlike ask_human this returns
	 * immediately — the turn continues/ends, the owner decides in the UI, and the
	 * decision is injected into a later wake's prompt.
	 */
	router.post('/internal/mission/approval', async (req: Request, res: Response) => {
		const body = req.body as MissionApprovalCreateRequest;
		if (
			typeof body.action !== 'string' ||
			body.action.trim().length === 0 ||
			typeof body.rationale !== 'string' ||
			body.rationale.trim().length === 0
		) {
			res.status(400).json({ success: false, error: 'action and rationale are required' });
			return;
		}
		if (body.action.length > 500 || body.rationale.length > 4_000) {
			res.status(400).json({
				success: false,
				error: 'action is capped at 500 characters and rationale at 4000 characters',
			});
			return;
		}
		const mission = await requireMission(req, res, false);
		if (!mission) return;
		try {
			// Bound the pending queue so a looping agent cannot flood the owner.
			const approvals = await missionService.listApprovals(mission.id, mission.ownerId);
			const pendingCount = approvals.filter((a) => a.status === 'pending').length;
			if (pendingCount >= 10) {
				res.status(429).json({
					success: false,
					error:
						'Too many approvals are already pending for this mission. Wait for the owner to decide before requesting more.',
				});
				return;
			}
			const approval = await missionService.createApproval(mission.id, mission.ownerId, {
				action: body.action,
				rationale: body.rationale,
			});
			void outboundDeliveryService.deliverToOwner({
				ownerId: mission.ownerId,
				agentId: mission.agentId,
				missionId: mission.id,
				type: 'approval_requested',
				title: `Mission "${mission.title}" needs approval`,
				body: `${body.action}\n\nWhy: ${body.rationale}`,
				linkPath: `/app/agents/${mission.agentId}/missions/${mission.id}`,
				preferredLinkId: mission.reportChannelLinkId,
			});
			res.status(201).json({ success: true, data: { approvalId: approval.id } });
		} catch (err) {
			logger.error({ err, missionId: mission.id }, '[runtime] mission approval failed');
			res.status(500).json({ success: false, error: 'Failed to create the approval request' });
		}
	});

	// ─── Mission MANAGEMENT internal endpoints (PROXY_TOKEN auth) ──────────────
	// These let an agent set up and control its OWN missions from a chat turn
	// (list/read/create/update/control) — the mission equivalent of the workflow
	// tools. Everything is scoped to the token's agentId + ownerId; the sandbox
	// can never touch another agent's missions. Gated agent-side to chat turns.

	/** GET /internal/missions — list this agent's missions */
	router.get('/internal/missions', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		try {
			const missions = await missionService.listByAgent(sandboxToken.agentId, sandboxToken.ownerId);
			res.json({ success: true, data: missions });
		} catch (err) {
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] list missions failed');
			res.status(500).json({ success: false, error: 'Failed to list missions' });
		}
	});

	/**
	 * Load a mission and verify it belongs to the token's agent. Responds with the
	 * failure and returns null when not found / not owned by this agent.
	 */
	const loadOwnedMission = async (req: Request, res: Response): Promise<AgentMission | null> => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const { missionId } = req.params as { missionId: string };
		const mission = await missionService.getById(missionId, sandboxToken.ownerId);
		if (!mission || mission.agentId !== sandboxToken.agentId) {
			res.status(404).json({ success: false, error: 'Mission not found' });
			return null;
		}
		return mission;
	};

	/** GET /internal/missions/:missionId — read one of this agent's missions */
	router.get('/internal/missions/:missionId', async (req: Request, res: Response) => {
		const mission = await loadOwnedMission(req, res);
		if (!mission) return;
		res.json({ success: true, data: mission });
	});

	/** POST /internal/missions — create a mission for this agent */
	router.post('/internal/missions', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const body = req.body as CreateMissionRequest;
		if (!body.title?.trim() || !body.goal?.trim()) {
			res.status(400).json({ success: false, error: 'title and goal are required' });
			return;
		}
		if (typeof body.maxCostTotal !== 'number' || !(body.maxCostTotal > 0)) {
			res.status(400).json({ success: false, error: 'maxCostTotal must be a positive number' });
			return;
		}
		if (body.scheduleMode === 'fixed' && !body.cronExpr?.trim()) {
			res.status(400).json({ success: false, error: 'cronExpr is required for fixed schedules' });
			return;
		}
		try {
			const mission = await missionService.create(sandboxToken.agentId, sandboxToken.ownerId, body);
			if (!mission) {
				res.status(404).json({ success: false, error: 'Agent not found' });
				return;
			}
			res.status(201).json({ success: true, data: mission });
		} catch (err) {
			logger.error({ err, agentId: sandboxToken.agentId }, '[runtime] create mission failed');
			res.status(500).json({ success: false, error: 'Failed to create the mission' });
		}
	});

	/** POST /internal/missions/:missionId/update — edit an existing mission */
	router.post('/internal/missions/:missionId/update', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const existing = await loadOwnedMission(req, res);
		if (!existing) return;
		const body = req.body as UpdateMissionRequest;
		if (body.maxCostTotal !== undefined && !(body.maxCostTotal > 0)) {
			res.status(400).json({ success: false, error: 'maxCostTotal must be a positive number' });
			return;
		}
		try {
			const mission = await missionService.update(existing.id, sandboxToken.ownerId, body);
			res.json({ success: true, data: mission });
		} catch (err) {
			logger.error({ err, missionId: existing.id }, '[runtime] update mission failed');
			res.status(500).json({ success: false, error: 'Failed to update the mission' });
		}
	});

	/**
	 * POST /internal/missions/:missionId/control — activate | pause | complete | wake.
	 * 'pause' also cancels a live wake turn; 'wake' runs the scheduler's manual wake.
	 */
	router.post('/internal/missions/:missionId/control', async (req: Request, res: Response) => {
		const sandboxToken = (req as Request & { sandboxToken: SandboxTokenPayload }).sandboxToken;
		const existing = await loadOwnedMission(req, res);
		if (!existing) return;
		const { action } = req.body as MissionControlRequest;
		try {
			switch (action) {
				case 'activate': {
					const mission = await missionService.activate(existing.id, sandboxToken.ownerId);
					res.json({ success: true, data: mission });
					return;
				}
				case 'pause': {
					const mission = await missionService.pause(
						existing.id,
						sandboxToken.ownerId,
						'paused_by_agent',
					);
					if (mission?.currentThreadId) {
						await runtimeService.cancelTurn(mission.currentThreadId);
					}
					res.json({ success: true, data: mission });
					return;
				}
				case 'complete': {
					const mission = await missionService.complete(existing.id, sandboxToken.ownerId);
					res.json({ success: true, data: mission });
					return;
				}
				case 'wake': {
					const result = await missionSchedulerService.wakeNow(existing.id, sandboxToken.ownerId);
					if (!result) {
						res.status(409).json({
							success: false,
							error: 'Mission is not active, is over budget, or a wake is already running',
						});
						return;
					}
					res.status(201).json({ success: true, data: result });
					return;
				}
				default:
					res.status(400).json({
						success: false,
						error: "action must be 'activate', 'pause', 'complete', or 'wake'",
					});
			}
		} catch (err) {
			logger.error({ err, missionId: existing.id, action }, '[runtime] mission control failed');
			res.status(500).json({ success: false, error: 'Failed to control the mission' });
		}
	});

	return router;
}
