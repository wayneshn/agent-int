import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Deterministic fake OpenAI-compatible LLM server for tests.
 *
 * The backend's LLM providers accept a custom baseUrl (resolveAgentModel.ts),
 * so tests point an agent's provider config here and get reproducible,
 * offline, zero-cost completions — including streaming and tool calls.
 *
 * Scripting model: a FIFO queue of responses. Each chat request shifts the
 * queue; when empty, a deterministic fallback echo is returned. Every request
 * is recorded for assertions.
 */

export interface FakeToolCall {
	/** Tool name as the agent runtime expects it, e.g. "run_terminal". */
	name: string;
	/** Arguments object — serialized to a JSON string on the wire. */
	arguments: Record<string, unknown>;
	/** Optional explicit tool-call id (defaults to a deterministic one). */
	id?: string;
}

export interface FakeChatReply {
	/** Assistant text content (streamed in fixed-size chunks when stream=true). */
	content?: string;
	/** Tool calls to emit; sets finish_reason to "tool_calls". */
	toolCalls?: FakeToolCall[];
}

export interface FakeErrorReply {
	error: { status: number; body?: unknown };
}

export type FakeReply = FakeChatReply | FakeErrorReply;

/** A queued reply, optionally gated on a matcher applied to the request. */
interface QueuedReply {
	reply: FakeReply;
	/** When set, the reply is only used for requests whose system prompt or
	 *  messages contain this string (or match this RegExp). */
	match?: string | RegExp;
}

export interface RecordedLlmRequest {
	path: string;
	/** Parsed JSON body (model, messages, stream flag, ...). */
	body: Record<string, unknown>;
	receivedAt: number;
}

const DEFAULT_REPLY: FakeChatReply = { content: 'This is a deterministic fake LLM response.' };
const EMBEDDING_DIM = 8;

function isErrorReply(reply: FakeReply): reply is FakeErrorReply {
	return 'error' in reply;
}

function sseChunk(obj: Record<string, unknown>): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

export class FakeLlmServer {
	private server: http.Server | null = null;
	private queue: QueuedReply[] = [];
	private readonly requestsLog: RecordedLlmRequest[] = [];
	private replyCounter = 0;

	/** Base URL including /v1, e.g. http://127.0.0.1:51234/v1 */
	get url(): string {
		if (!this.server) throw new Error('FakeLlmServer not started');
		const { port } = this.server.address() as AddressInfo;
		return `http://127.0.0.1:${port}/v1`;
	}

	/** All requests received so far, in order. */
	get requests(): readonly RecordedLlmRequest[] {
		return this.requestsLog;
	}

	/** Queue a scripted chat reply for any request (consumed FIFO). */
	pushChat(reply: FakeChatReply): void {
		this.queue.push({ reply });
	}

	/**
	 * Queue a scripted chat reply used only for requests whose system prompt or
	 * message payload contains/matches `match`. Matched entries take precedence
	 * over unconditional ones — this makes multi-call flows deterministic (e.g.
	 * the backend's thread-title generation, whose prompt contains "concise
	 * title", can be scripted separately from the main turn reply).
	 */
	pushChatMatching(match: string | RegExp, reply: FakeChatReply): void {
		this.queue.push({ reply, match });
	}

	/** Queue an error response (consumed FIFO) — e.g. { error: { status: 500 } }. */
	pushError(status: number, body?: unknown): void {
		this.queue.push({ reply: { error: { status, body } } });
	}

	/** Clear queued replies and the request log (test isolation within a file). */
	reset(): void {
		this.queue = [];
		this.requestsLog.length = 0;
	}

	async start(port = 0): Promise<void> {
		if (this.server) return;
		this.server = http.createServer((req, res) => void this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			this.server!.once('error', reject);
			this.server!.listen(port, '127.0.0.1', () => resolve());
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = null;
		await new Promise<void>((resolve) => {
			server.closeAllConnections?.();
			server.close(() => resolve());
		});
	}

	private nextReply(body: Record<string, unknown>): FakeReply {
		const haystack = `${String(body.systemPrompt ?? '')}\n${JSON.stringify(body.messages ?? '')}`;
		const matches = (entry: QueuedReply): boolean => {
			if (!entry.match) return false;
			return typeof entry.match === 'string'
				? haystack.includes(entry.match)
				: entry.match.test(haystack);
		};
		// 1 — first matching-gated entry that matches this request
		const gated = this.queue.findIndex(matches);
		if (gated >= 0) return this.queue.splice(gated, 1)[0].reply;
		// 2 — first unconditional entry
		const open = this.queue.findIndex((e) => !e.match);
		if (open >= 0) return this.queue.splice(open, 1)[0].reply;
		// 3 — deterministic fallback
		return DEFAULT_REPLY;
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const rawBody = await readBody(req);
		let body: Record<string, unknown> = {};
		if (rawBody.length > 0) {
			try {
				body = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
			} catch {
				res.writeHead(400, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }));
				return;
			}
		}
		this.requestsLog.push({ path: url.pathname, body, receivedAt: Date.now() });

		if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
			return this.handleChatCompletions(body, res);
		}
		if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
			return this.handleEmbeddings(body, res);
		}
		if (req.method === 'GET' && url.pathname === '/v1/models') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
			return;
		}
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: { message: `unknown route ${req.method} ${url.pathname}`, type: 'invalid_request_error' } }));
	}

	private handleChatCompletions(body: Record<string, unknown>, res: http.ServerResponse): void {
		const reply = this.nextReply(body);
		if (isErrorReply(reply)) {
			res.writeHead(reply.error.status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(reply.error.body ?? { error: { message: 'fake LLM error' } }));
			return;
		}

		const model = typeof body.model === 'string' ? body.model : 'fake-model';
		const id = `chatcmpl-fake-${++this.replyCounter}`;
		const created = Math.floor(Date.now() / 1000);
		const toolCalls = reply.toolCalls ?? [];
		const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
		const content = reply.content ?? (toolCalls.length > 0 ? null : '');

		if (body.stream === true) {
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'keep-alive',
			});
			const base = { id, object: 'chat.completion.chunk', created, model };
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
			if (content) {
				// Fixed-size chunks keep streaming deterministic for UI assertions.
				for (let i = 0; i < content.length; i += 16) {
					res.write(
						sseChunk({
							...base,
							choices: [{ index: 0, delta: { content: content.slice(i, i + 16) }, finish_reason: null }],
						}),
					);
				}
			}
			toolCalls.forEach((tc, index) => {
				const callId = tc.id ?? `call_fake_${index}`;
				res.write(
					sseChunk({
						...base,
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index,
											id: callId,
											type: 'function',
											function: { name: tc.name, arguments: '' },
										},
									],
								},
								finish_reason: null,
							},
						],
					}),
				);
				res.write(
					sseChunk({
						...base,
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{ index, function: { arguments: JSON.stringify(tc.arguments) } },
									],
								},
								finish_reason: null,
							},
						],
					}),
				);
			});
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }));
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		const message: Record<string, unknown> = { role: 'assistant', content };
		if (toolCalls.length > 0) {
			message.tool_calls = toolCalls.map((tc, index) => ({
				id: tc.id ?? `call_fake_${index}`,
				type: 'function',
				function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
			}));
		}
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify({
				id,
				object: 'chat.completion',
				created,
				model,
				choices: [{ index: 0, message, finish_reason: finishReason }],
				usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
			}),
		);
	}

	private handleEmbeddings(body: Record<string, unknown>, res: http.ServerResponse): void {
		const input = body.input;
		const items = Array.isArray(input) ? input : [input];
		// Deterministic unit-ish vectors — the embedding column is dimensionless,
		// so any consistent dimension works.
		const data = items.map((_, index) => ({
			object: 'embedding',
			index,
			embedding: Array.from({ length: EMBEDDING_DIM }, (_v, d) => (index + 1) * (d + 1) * 0.01),
		}));
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify({
				object: 'list',
				data,
				model: typeof body.model === 'string' ? body.model : 'fake-embedding',
				usage: { prompt_tokens: 5, total_tokens: 5 },
			}),
		);
	}
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}
