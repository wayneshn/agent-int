import { stream, complete, type UserMessage, type TextContent } from '@earendil-works/pi-ai';
import type { LlmProxyRequest, AgentStreamEvent, SandboxTokenPayload } from '@repo/types';
import { AgentProxyService } from './AgentProxyService.js';
import { LlmProviderService } from './LlmProviderService.js';
import { EncryptionService } from './EncryptionService.js';
import { AgentService } from './AgentService.js';
import { AgentStreamBus } from './AgentStreamBus.js';
import { AgentSessionService } from './AgentSessionService.js';
import { AgentMemoryService } from './AgentMemoryService.js';
import { resolveAgentModel, type ResolvedAgentModel } from './llm/resolveAgentModel.js';
import { logger } from '../config/logger.js';
import { v4 as uuidv4 } from 'uuid';
import type { ContentBlock, MessageTokenUsage } from '@repo/types';

/**
 * Minimum interval between render_ui_partial snapshots per tool call. The
 * snapshots are cumulative, so throttling only affects update smoothness —
 * the final tool_call_delta always carries the complete arguments.
 */
const UI_PARTIAL_THROTTLE_MS = 120;

/**
 * Handles LLM proxy requests from agent child processes.
 *
 * Security model:
 *   - The child process sends LLM requests to this service (via PROXY_TOKEN auth).
 *   - This service resolves the agent's LLM config, decrypts the API key on the host,
 *     calls the LLM provider, and streams the response back.
 *   - The raw API key never enters the child process.
 *
 * Streaming model:
 *   - pi-ai stream() is called with the decrypted key passed as options.apiKey.
 *   - Each streaming event is emitted on AgentStreamBus (→ SSE to browser).
 *   - The completed assistant message is persisted to agent_messages via AgentSessionService.
 */
export class AgentLlmProxyService {
	constructor(
		private readonly agentProxyService: AgentProxyService,
		private readonly agentService: AgentService,
		private readonly llmProviderService: LlmProviderService,
		private readonly encryptionService: EncryptionService,
		private readonly streamBus: AgentStreamBus,
		private readonly sessionService: AgentSessionService,
		private readonly memoryService: AgentMemoryService,
	) {}

	/**
	 * Execute an LLM completion on behalf of a child process.
	 * Streams events to the AgentStreamBus and persists the final message.
	 *
	 * Returns the full assistant message content for the child to continue its tool loop.
	 */
	async executeStream(proxyToken: string, request: LlmProxyRequest): Promise<unknown[]> {
		// Validate token
		const tokenPayload = await this.agentProxyService.verifyProxyToken(proxyToken);

		logger.debug(
			{ agentId: tokenPayload.agentId, threadId: tokenPayload.threadId },
			'[llm-proxy] received LLM stream request',
		);

		// Resolve agent config and LLM key — apiKey stays on the host
		const { model, apiKey } = await this.resolveModel(tokenPayload);

		const messageId = uuidv4();

		logger.info(
			{
				agentId: tokenPayload.agentId,
				threadId: tokenPayload.threadId,
				messageId,
				provider: model.provider,
				modelId: model.id,
			},
			'[llm-proxy] starting LLM stream',
		);

		// Emit stream_start to browser
		this.streamBus.emit(tokenPayload.threadId, {
			type: 'message_start',
			messageId,
			role: 'assistant',
		});

		// Build pi-ai context. Defensive sanitize: pi-ai only understands text /
		// thinking / toolCall / image content blocks. We never persist any other
		// block type, but strip unknown ones here so a future display-only block
		// can never reach a provider and break the request.
		const ALLOWED_BLOCK_TYPES = new Set(['text', 'thinking', 'toolCall', 'image']);
		const sanitizedMessages = (request.messages as Array<{ content?: unknown }>).map((m) => {
			if (!Array.isArray(m.content)) return m;
			const filtered = (m.content as Array<{ type?: string }>).filter(
				(b) => b && ALLOWED_BLOCK_TYPES.has(b.type as string),
			);
			// Keep the original content if filtering would empty an otherwise-valid message.
			return filtered.length > 0 ? { ...m, content: filtered } : m;
		});

		const context = {
			systemPrompt: request.systemPrompt,
			messages: sanitizedMessages as Parameters<typeof stream>[1]['messages'],
			tools: (request.tools as Parameters<typeof stream>[1]['tools']) ?? [],
		};

		logger.debug(
			{
				agentId: tokenPayload.agentId,
				threadId: tokenPayload.threadId,
				messageCount: context.messages.length,
				toolCount: context.tools.length,
			},
			'[llm-proxy] calling pi-ai stream()',
		);

		// Build stream options. apiKey is required so pi-ai doesn't look in env vars.
		const streamOptions: Record<string, unknown> = { apiKey };

		const isGoogle = model.provider.toLowerCase() === 'google';

		// Google Gemini 3.x models require `thoughtSignature` to be echoed back verbatim on
		// every functionCall part when replaying history. pi-ai strips thought_signatures from
		// its event types — they never survive our DB serialisation roundtrip.
		//
		// Fix: use pi-ai's `onPayload` callback to intercept the raw Google API payload before
		// it is sent. Any `functionCall` part in model-role history entries that lacks a
		// `thoughtSignature` gets the bypass sentinel value that Google officially documents:
		//   "skip_thought_signature_validator"
		// This tells the Google API to skip signature validation for that part.
		// Reference: https://ai.google.dev/gemini-api/docs/thought-signatures (FAQ section)
		if (isGoogle) {
			streamOptions.onPayload = (payload: unknown) => {
				const p = payload as { contents?: unknown[] };
				if (!Array.isArray(p.contents)) return;

				for (const contentEntry of p.contents) {
					const entry = contentEntry as { role?: string; parts?: unknown[] };
					// Only patch model-role entries (assistant messages in replay history)
					if (entry.role !== 'model') continue;
					if (!Array.isArray(entry.parts)) continue;

					for (const part of entry.parts) {
						const partObj = part as {
							functionCall?: unknown;
							thoughtSignature?: string;
						};
						// Inject bypass sentinel on functionCall parts that have no signature
						if (partObj.functionCall !== undefined && !partObj.thoughtSignature) {
							partObj.thoughtSignature = 'skip_thought_signature_validator';
						}
					}
				}
			};
		}

		logger.debug(
			{
				agentId: tokenPayload.agentId,
				isGoogle,
				modelReasoning: model.reasoning,
				toolCount: context.tools.length,
				streamOptionsKeys: Object.keys(streamOptions),
				// Log role + content-block types for every message sent to the LLM
				messagesSummary: context.messages.map((m, i) => {
					const msg = m as { role: string; content?: unknown[] };
					const contentTypes = Array.isArray(msg.content)
						? msg.content.map((b) => (b as { type: string }).type)
						: [];
					return { index: i, role: msg.role, contentTypes };
				}),
			},
			'[llm-proxy] stream options + message summary',
		);

		const piStream = stream(model, context, streamOptions);

		// Collect content blocks for persistence and return
		const contentBlocks: ContentBlock[] = [];
		let currentTextBlock: { type: 'text'; text: string } | null = null;
		// Per-contentIndex throttle for render_ui_partial snapshots (progressive UI).
		const uiPartialLastEmit = new Map<number, number>();

		for await (const event of piStream) {
			switch (event.type) {
				case 'text_start':
					currentTextBlock = { type: 'text', text: '' };
					break;

				case 'text_delta':
					if (currentTextBlock) {
						currentTextBlock.text += event.delta;
					}
					logger.debug(
						{ agentId: tokenPayload.agentId, messageId, delta: event.delta },
						'[llm-proxy] text_delta',
					);
					this.streamBus.emit(tokenPayload.threadId, {
						type: 'text_delta',
						messageId,
						delta: event.delta,
					});
					break;

				case 'text_end':
					if (currentTextBlock) {
						contentBlocks.push(currentTextBlock);
						currentTextBlock = null;
					}
					break;

				case 'thinking_delta':
					this.streamBus.emit(tokenPayload.threadId, {
						type: 'thinking_delta',
						messageId,
						delta: event.delta,
					});
					break;

				case 'toolcall_start': {
					// Emit a placeholder start event using the content index as a temporary ID.
					// The real toolCallId arrives at toolcall_end; the tool NAME is usually
					// already known here (providers announce it up front) — forward it so the
					// frontend can branch immediately (e.g. render_ui streaming layout).
					const startBlock = event.partial.content[event.contentIndex];
					this.streamBus.emit(tokenPayload.threadId, {
						type: 'tool_call_start',
						messageId,
						toolCallId: String(event.contentIndex),
						toolName: startBlock?.type === 'toolCall' ? startBlock.name : '',
					});
					break;
				}

				case 'toolcall_delta': {
					// Progressive UI: pi-ai keeps a best-effort parsed args object on the
					// partial message (parseStreamingJson) — for render_ui, forward the
					// code-so-far as a throttled, cumulative snapshot so the web UI can
					// render the interface while the LLM is still writing it.
					const deltaBlock = event.partial.content[event.contentIndex];
					if (deltaBlock?.type === 'toolCall' && deltaBlock.name === 'render_ui') {
						const code = (deltaBlock.arguments as { code?: unknown } | undefined)?.code;
						const last = uiPartialLastEmit.get(event.contentIndex) ?? 0;
						if (
							typeof code === 'string' &&
							code.length > 0 &&
							Date.now() - last >= UI_PARTIAL_THROTTLE_MS
						) {
							uiPartialLastEmit.set(event.contentIndex, Date.now());
							this.streamBus.emit(tokenPayload.threadId, {
								type: 'render_ui_partial',
								messageId,
								toolCallId: String(event.contentIndex),
								code,
							});
						}
					}
					break;
				}

				case 'toolcall_end': {
					uiPartialLastEmit.delete(event.contentIndex);
					const toolCall = event.toolCall;
					contentBlocks.push({
						type: 'toolCall',
						id: toolCall.id,
						name: toolCall.name,
						arguments: toolCall.arguments as Record<string, unknown>,
					});
					logger.debug(
						{ agentId: tokenPayload.agentId, toolName: toolCall.name, toolCallId: toolCall.id },
						'[llm-proxy] tool call emitted',
					);
					// Emit tool_call_delta to update the placeholder with real id, name, and args.
					// The frontend uses placeholderId to replace the earlier tool_call_start entry.
					this.streamBus.emit(tokenPayload.threadId, {
						type: 'tool_call_delta',
						messageId,
						placeholderId: String(event.contentIndex),
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						argsJson: JSON.stringify(toolCall.arguments, null, 2),
					});
					break;
				}

				case 'done': {
					const finalMsg = event.message;
					const usage: MessageTokenUsage | undefined = finalMsg.usage
						? {
								input: finalMsg.usage.input,
								output: finalMsg.usage.output,
								cost: { total: finalMsg.usage.cost?.total ?? 0 },
							}
						: undefined;

					// Persist the completed assistant message.
					// Wrapped in try/catch so a DB failure doesn't leave the browser in a
					// permanently-locked state — we still emit message_end so the UI unlocks,
					// then re-throw so the child process receives a 500 and exits with code 1.
					try {
						await this.sessionService.appendMessage({
							threadId: tokenPayload.threadId,
							role: 'assistant',
							content: contentBlocks,
							tokenUsage: usage,
						});

						// Accumulate context window tokens (input + output) for this turn.
						// Both input and output tokens count toward context size because output
						// from this turn becomes input context on the next turn.
						// When a compaction feature is added, this value can be reset/reduced
						// independently of the total token/cost metrics.
						if (usage) {
							await this.sessionService.accumulateThreadContextTokens(
								tokenPayload.threadId,
								usage.input + usage.output,
							);
						}

						logger.info(
							{
								agentId: tokenPayload.agentId,
								threadId: tokenPayload.threadId,
								messageId,
								contentBlocks: contentBlocks.length,
								usage,
							},
							'[llm-proxy] LLM stream done, assistant message persisted',
						);
					} catch (persistErr) {
						logger.error(
							{ persistErr, threadId: tokenPayload.threadId, messageId },
							'[llm-proxy] failed to persist assistant message — emitting message_end anyway',
						);
						// Emit message_end before re-throwing so the browser SSE handler can
						// unlock the input (avoids the UI freezing on a transient DB error).
						this.streamBus.emit(tokenPayload.threadId, {
							type: 'message_end',
							messageId,
							usage,
						});
						throw persistErr;
					}

					this.streamBus.emit(tokenPayload.threadId, {
						type: 'message_end',
						messageId,
						usage,
					});
					break;
				}

				case 'error':
					logger.error(
						{ agentId: tokenPayload.agentId, error: event.error.errorMessage },
						'[llm-proxy] LLM stream error',
					);
					this.streamBus.emit(tokenPayload.threadId, {
						type: 'error',
						message: event.error.errorMessage ?? 'LLM stream error',
					});
					break;
			}
		}

		// Return the collected content blocks so the child process can continue its tool loop
		return contentBlocks;
	}

	/**
	 * Generate a short title (≤10 words) for a thread based on the first two messages.
	 * Uses the same model configured for the agent. Runs non-blocking — failure is silently
	 * logged and does not affect the ongoing agent turn.
	 *
	 * @param threadId   - The thread to update
	 * @param ownerId    - Owner, required for session service auth check
	 * @param agentId    - Agent whose LLM config to use
	 * @param firstUserMsg  - The first user message text
	 * @param secondUserMsg - The second user message text
	 */
	async generateThreadTitle(
		threadId: string,
		ownerId: string,
		agentId: string,
		firstUserMsg: string,
		secondUserMsg: string,
	): Promise<string | null> {
		try {
			// Build a minimal sandbox token payload for resolveModel
			const fakePayload: import('@repo/types').SandboxTokenPayload = {
				agentId,
				ownerId,
				threadId,
				credentialIds: [],
				iat: Math.floor(Date.now() / 1000),
				exp: Math.floor(Date.now() / 1000) + 60,
			};

			const { model, apiKey } = await this.resolveModel(fakePayload);

			const prompt =
				`Based on these two messages from a conversation, generate a concise title of at most 10 words.\n` +
				`Reply with ONLY the title — no punctuation at the end, no quotes.\n\n` +
				`Message 1: ${firstUserMsg}\n` +
				`Message 2: ${secondUserMsg}`;

			const titleUserMsg: UserMessage = {
				role: 'user',
				content: [{ type: 'text', text: prompt } as TextContent],
				timestamp: Date.now(),
			};

			const titleStream = stream(
				model,
				{
					systemPrompt: 'You generate short conversation titles.',
					messages: [titleUserMsg],
					tools: [],
				},
				{ apiKey },
			);

			let title = '';
			let titleUsage: MessageTokenUsage | undefined;
			for await (const event of titleStream) {
				if (event.type === 'text_delta') {
					title += event.delta;
				}
				if (event.type === 'done' && event.message.usage) {
					titleUsage = {
						input: event.message.usage.input,
						output: event.message.usage.output,
						cost: { total: event.message.usage.cost?.total ?? 0 },
					};
				}
			}

			// Trim whitespace and cap at 10 words as a safety measure
			title = title
				.trim()
				.replace(/[.!?]+$/, '')
				.split(/\s+/)
				.slice(0, 10)
				.join(' ');

			if (!title) return null;

			// Persist title generation usage to the thread so it counts toward cost.
			// Stored as an assistant message with no visible content (empty text block).
			// This ensures the run page and chat bar both account for this LLM call.
			if (titleUsage) {
				await this.sessionService.appendMessage({
					threadId,
					role: 'assistant',
					content: [{ type: 'text', text: '' }],
					tokenUsage: titleUsage,
				});
			}

			await this.sessionService.updateThreadTitle(threadId, ownerId, title);

			logger.info({ threadId, title, titleUsage }, '[llm-proxy] generated thread title');
			return title;
		} catch (err) {
			// Non-fatal — title generation is best-effort
			logger.warn({ err, threadId }, '[llm-proxy] thread title generation failed');
			return null;
		}
	}

	/**
	 * Extract important information from user messages in a previous thread and write them
	 * as typed memory entries. Called fire-and-forget when a new thread is created.
	 *
	 * Replaces the old flat-summary approach with a dedup-aware JSON extraction:
	 *   1. Build a transcript of user messages from the previous thread.
	 *   2. Search existing memory for similar entries (provides context for dedup).
	 *   3. Ask the LLM (using complete(), non-streaming) to decide what — if anything —
	 *      is new and worth storing. The LLM must respond with JSON:
	 *        { "hasNewMemory": false }
	 *        { "hasNewMemory": true, "memories": [{ "content": "...", "memoryType": "..." }] }
	 *   4. Only writes if hasNewMemory is true. Each entry is written individually so a
	 *      failure on one does not prevent the others from being written.
	 *
	 * Silently no-ops if:
	 *   - The previous thread has no user messages
	 *   - The agent has no LLM model configured
	 *   - The agent has no embedding model configured (needed for dedup search + write)
	 *
	 * @param agentId      - Agent whose memory to write to
	 * @param ownerId      - Owner required for DB queries and auth
	 * @param prevThreadId - The thread to extract from
	 */
	async summarizeThreadToMemory(
		agentId: string,
		ownerId: string,
		prevThreadId: string,
	): Promise<void> {
		try {
			// Check that the agent has both an LLM and an embedding model
			const agent = await this.agentService.getById(agentId, ownerId);
			if (!agent?.modelConfigId || !agent.embeddingModelConfigId) return;

			// Load user messages from the previous thread only
			const messages = await this.sessionService.listMessagesInternal(prevThreadId);
			const userMessages = messages.filter((m) => m.role === 'user');

			if (userMessages.length === 0) {
				logger.debug(
					{ agentId, prevThreadId },
					'[llm-proxy] summarize: no user messages in previous thread — skipping',
				);
				return;
			}

			// Build a readable transcript from user message text blocks only
			const transcript = userMessages
				.map((m, idx) => {
					const textBlocks = m.content.filter(
						(b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
					);
					const text = textBlocks
						.map((b) => b.text)
						.join(' ')
						.trim();
					return text ? `User message ${idx + 1}: ${text}` : null;
				})
				.filter((line): line is string => line !== null)
				.join('\n');

			if (!transcript) {
				logger.debug(
					{ agentId, prevThreadId },
					'[llm-proxy] summarize: all user messages were empty — skipping',
				);
				return;
			}

			// Search existing memory to provide dedup context.
			// We use the full transcript as a query so the most relevant existing entries appear.
			// Non-fatal if search fails (embedding model missing, etc.) — we continue with empty context.
			let existingMemoryContext = '(none)';
			try {
				const existingResults = await this.memoryService.searchMemory(agentId, ownerId, {
					query: transcript.slice(0, 500), // cap to avoid overly large embedding inputs
					topK: 8,
				});
				if (existingResults.length > 0) {
					existingMemoryContext = existingResults
						.map((r) => `- [${r.memoryType}] ${r.content}`)
						.join('\n');
				}
			} catch (searchErr) {
				logger.debug(
					{ searchErr, agentId },
					'[llm-proxy] summarize: memory search failed — proceeding without dedup context',
				);
			}

			// Build a minimal fake token payload so resolveModel can fetch agent config
			const fakePayload: import('@repo/types').SandboxTokenPayload = {
				agentId,
				ownerId,
				threadId: prevThreadId,
				credentialIds: [],
				iat: Math.floor(Date.now() / 1000),
				exp: Math.floor(Date.now() / 1000) + 120,
			};

			const { model, apiKey } = await this.resolveModel(fakePayload);

			// Ask the LLM to decide what is new and worth storing.
			// The response MUST be valid JSON — no markdown fencing.
			const extractionPrompt =
				`You are a memory extraction assistant. Extract important facts from the user messages below.\n\n` +
				`Existing stored memories (for dedup — do not repeat these):\n${existingMemoryContext}\n\n` +
				`User messages from the conversation:\n${transcript}\n\n` +
				`Rules:\n` +
				`- Extract IMPORTANT facts only: preferences, personal details, corrections, domain knowledge, goals, constraints.\n` +
				`- Skip greetings, small talk, one-off questions, or anything ephemeral.\n` +
				`- Skip anything already covered by the existing memories above.\n` +
				`- If nothing new is worth remembering, return hasNewMemory: false.\n\n` +
				`You MUST respond with valid JSON only (no markdown, no explanation):\n` +
				`{"hasNewMemory":false}\n` +
				`or\n` +
				`{"hasNewMemory":true,"memories":[{"content":"<self-contained factual statement>","memoryType":"semantic|procedural|episodic"}]}`;

			const extractUserMsg: UserMessage = {
				role: 'user',
				content: [{ type: 'text', text: extractionPrompt } as TextContent],
				timestamp: Date.now(),
			};

			// complete() is a single non-streaming call — appropriate for a background task
			const response = await complete(
				model,
				{
					systemPrompt:
						'You are a memory extraction assistant. Always respond with valid JSON only, no markdown fencing, no explanation.',
					messages: [extractUserMsg],
					tools: [],
				},
				{ apiKey },
			);

			const rawText = response.content
				.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
				.map((b) => b.text)
				.join('')
				.trim();

			if (!rawText) {
				logger.debug(
					{ agentId, prevThreadId },
					'[llm-proxy] summarize: empty LLM response — skipping',
				);
				return;
			}

			// Strip markdown code fences in case the model added them despite instructions
			const cleaned = rawText
				.replace(/^```(?:json)?\s*/i, '')
				.replace(/\s*```$/, '')
				.trim();

			let parsed: {
				hasNewMemory: boolean;
				memories?: Array<{ content: string; memoryType: string }>;
			};
			try {
				parsed = JSON.parse(cleaned) as typeof parsed;
			} catch {
				logger.debug(
					{ agentId, rawText: cleaned.slice(0, 200) },
					'[llm-proxy] summarize: LLM returned non-JSON — skipping',
				);
				return;
			}

			if (!parsed.hasNewMemory || !Array.isArray(parsed.memories) || parsed.memories.length === 0) {
				logger.debug({ agentId, prevThreadId }, '[llm-proxy] summarize: no new memories to store');
				return;
			}

			const validTypes = new Set(['episodic', 'semantic', 'procedural', 'working']);
			let writtenCount = 0;

			for (const mem of parsed.memories) {
				if (!mem.content || typeof mem.content !== 'string') continue;
				const memoryType = validTypes.has(mem.memoryType) ? mem.memoryType : 'semantic';

				try {
					await this.memoryService.writeMemory(agentId, ownerId, {
						content: mem.content,
						memoryType: memoryType as 'episodic' | 'semantic' | 'procedural' | 'working',
						metadata: { source: 'thread_summary', threadId: prevThreadId },
					});
					writtenCount++;
				} catch (writeErr) {
					logger.warn(
						{ writeErr, agentId, memoryType },
						'[llm-proxy] summarize: failed to write one memory entry (non-fatal)',
					);
				}
			}

			logger.info(
				{ agentId, prevThreadId, writtenCount },
				'[llm-proxy] thread summarized — memory entries written',
			);
		} catch (err) {
			// Non-fatal — extraction is best-effort and must not block thread creation
			logger.warn(
				{ err, agentId, prevThreadId },
				'[llm-proxy] thread summarization failed (non-fatal)',
			);
		}
	}

	/**
	 * Resolve the pi-ai Model and decrypted API key for an agent.
	 * Delegates to the shared resolveAgentModel helper (also used by the skill
	 * evolution engine) so provider/API mapping stays consistent.
	 */
	private async resolveModel(tokenPayload: SandboxTokenPayload): Promise<ResolvedAgentModel> {
		return resolveAgentModel(
			this.agentService,
			this.llmProviderService,
			tokenPayload.agentId,
			tokenPayload.ownerId,
		);
	}
}
