import type { InboundMessage, PipelineResult, ChannelAdapter } from '@repo/types';
import { AgentSessionService } from '../services/AgentSessionService.js';
import { AgentRuntimeService } from '../services/AgentRuntimeService.js';
import { AgentProxyService } from '../services/AgentProxyService.js';
import { AgentLlmProxyService } from '../services/AgentLlmProxyService.js';
import { AgentService } from '../services/AgentService.js';
import { ChatFileService } from '../services/ChatFileService.js';
import { agentStreamBus } from '../services/AgentStreamBus.js';
import { ContentProcessor } from './processor.js';
import { logger } from '../config/logger.js';

/**
 * Placeholder title the web frontend persists on brand-new chat threads (the
 * sidebar also shows it as the fallback for a null title). Treated as "untitled"
 * by auto-titling so it still gets replaced — keep in sync with the frontend.
 */
const DEFAULT_THREAD_TITLE = 'New conversation';

/**
 * MessagePipeline — the unified message processing service.
 *
 * Every message from every channel (web, Telegram, Discord, etc.) goes through
 * this service. It centralises:
 *   - HITL pending check (route message to awaiting child process instead of spawning new)
 *   - Thread status / concurrency guard (409 if agent is already running)
 *   - User message persistence
 *   - Auto-title generation after the 2nd user message
 *   - Previous-thread summarization on the 1st message of a new thread
 *   - AgentStreamBus subscriber registration for the channel adapter
 *   - Agent child process spawn
 *
 * The adapter that received the message is passed into process() by the caller.
 * This is what routes the response back through the correct bot: with multiple
 * bot credentials active on the same channel, each poller/gateway owns its own
 * adapter (and bot token), so a registry keyed by channel name would deliver
 * responses through whichever bot happened to register last.
 *
 * The web adapter's subscriber is a no-op because the browser SSE connection
 * already subscribes to AgentStreamBus separately. All other adapters provide a
 * real subscriber that accumulates and dispatches messages to the platform.
 */
export class MessagePipeline {
	constructor(
		private readonly sessionService: AgentSessionService,
		private readonly runtimeService: AgentRuntimeService,
		private readonly proxyService: AgentProxyService,
		private readonly llmProxyService: AgentLlmProxyService,
		private readonly agentService: AgentService,
		private readonly contentProcessor: ContentProcessor,
		private readonly chatFileService: ChatFileService,
	) {}

	/**
	 * Process an inbound message end-to-end.
	 *
	 * Callers (route handlers, pollers, gateway managers) pass a fully resolved
	 * InboundMessage (userId, agentId, threadId already populated) together with
	 * the adapter that received it, and get back a PipelineResult they can use
	 * to build the HTTP/platform response.
	 */
	async process(inbound: InboundMessage, adapter: ChannelAdapter): Promise<PipelineResult> {
		const { userId, agentId, threadId, channel, externalId, userDatetime } = inbound;

		try {
			// 1. Normalize content into the VISIBLE user message (user-typed text only;
			//    file attachments are rendered separately and injected for the agent at
			//    history-load time — see ContentProcessor + the internal messages route).
			const contentBlocks = await this.contentProcessor.normalize(inbound.content);

			// Chat file attachments to link to the persisted user message (web uploads).
			const fileIds = inbound.content
				.filter((c): c is Extract<typeof c, { type: 'file' }> => c.type === 'file')
				.map((c) => c.fileId);

			// A message must carry text and/or at least one attachment.
			if (contentBlocks.length === 0 && fileIds.length === 0) {
				return { ok: false, status: 400, error: 'No processable content in message' };
			}

			// 2. HITL check — if a HITL is pending, resolve it without spawning a new child
			if (this.proxyService.hasPendingHitl(threadId)) {
				logger.info({ threadId, channel }, '[pipeline] resolving pending HITL request');

				const textContent = contentBlocks
					.filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
					.map((b) => b.text)
					.join('\n');

				const userMessage = await this.sessionService.appendMessage({
					threadId,
					role: 'user',
					content: contentBlocks,
				});
				await this.chatFileService.attachToMessage(fileIds, userMessage.id, threadId, userId);

				this.proxyService.resolveHitlRequest(threadId, textContent);

				// A HITL reply is a user message too — make sure an untitled thread still
				// gets a title (this path doesn't run scheduleBackgroundTasks).
				void this.maybeGenerateTitle(threadId, userId, agentId);

				return {
					ok: true,
					status: 201,
					userMessage,
					threadId,
					hitlResolved: true,
				};
			}

			// 3. Concurrency guard — reject if agent is already processing
			const thread = await this.sessionService.getThreadByIdInternal(threadId);
			if (!thread) {
				return { ok: false, status: 404, error: 'Thread not found' };
			}
			if (thread.agentId !== agentId) {
				return { ok: false, status: 404, error: 'Thread not found' };
			}
			if (thread.status === 'running') {
				return {
					ok: false,
					status: 409,
					error: 'Agent is currently processing. Please wait.',
				};
			}

			// 4. Persist user message + link any uploaded files to it for display
			const userMessage = await this.sessionService.appendMessage({
				threadId,
				role: 'user',
				content: contentBlocks,
			});
			await this.chatFileService.attachToMessage(fileIds, userMessage.id, threadId, userId);

			// 5. Fire-and-forget background tasks keyed off the user-message count:
			//    1st message → summarize the previous thread, 2nd message → auto-title.
			this.scheduleBackgroundTasks(threadId, userId, agentId);

			// 6. Register the stream subscriber for the channel adapter.
			//    Web adapter returns a no-op — the SSE endpoint handles delivery.
			//    Batched adapters (telegram, discord) accumulate and dispatch.
			const subscriber = adapter.createStreamSubscriber(threadId, externalId, {
				notifyToolUsage: inbound.notifyToolUsage ?? false,
			});
			let unsubscribe: (() => void) | null = null;
			unsubscribe = agentStreamBus.subscribe(threadId, (event) => {
				subscriber.onEvent(event);
				// Clean up when the turn is complete
				if (event.type === 'done' || event.type === 'error') {
					subscriber.onComplete();
					subscriber.dispose();
					if (unsubscribe) {
						unsubscribe();
						unsubscribe = null;
					}
				}
			});

			// 7. Spawn the agent child process (non-blocking). The channel gates UI
			//    rendering — only web-channel turns register the render_ui tool.
			await this.runtimeService.spawnForThread(
				agentId,
				threadId,
				userId,
				'chat',
				undefined,
				userDatetime,
				undefined,
				channel,
			);

			return { ok: true, status: 201, userMessage, threadId };
		} catch (err) {
			logger.error({ err, agentId, threadId, channel }, '[pipeline] unexpected error');
			return {
				ok: false,
				status: 500,
				error: err instanceof Error ? err.message : 'Internal pipeline error',
			};
		}
	}

	/**
	 * Background tasks driven by the thread's user-message count.
	 * Runs after the message has been persisted, fully non-blocking.
	 *
	 *   - 1st user message  → this is a fresh thread: summarize the previous
	 *     thread into long-term memory. Triggering here (instead of on every
	 *     message, or at thread-creation time) means exactly one summarization
	 *     per thread regardless of which channel created it.
	 *   - 2nd user message  → generate an automatic thread title.
	 */
	private scheduleBackgroundTasks(threadId: string, ownerId: string, agentId: string): void {
		void (async () => {
			try {
				const allMessages = await this.sessionService.listMessages(threadId, ownerId);
				const userMessages = allMessages.filter((m) => m.role === 'user');

				if (userMessages.length === 1) {
					await this.summarizePreviousThread(agentId, ownerId, threadId);
					return;
				}

				await this.maybeGenerateTitle(threadId, ownerId, agentId);
			} catch (err) {
				logger.warn({ err, threadId }, '[pipeline] background task failed (non-fatal)');
			}
		})();
	}

	/**
	 * Ensure an untitled thread gets an auto-generated title once it has at least two
	 * user messages. Idempotent and self-healing: the "still untitled" guard means it
	 * skips already-titled threads (no clobbering of workflow/renamed titles) and
	 * RETRIES on every later message until a title sticks — so a transient LLM error
	 * or a user-message count shifted by a HITL reply can't permanently leave the
	 * thread on "New conversation" (the previous `=== 2` single-shot check did).
	 * Best-effort — never throws.
	 */
	private async maybeGenerateTitle(
		threadId: string,
		ownerId: string,
		agentId: string,
	): Promise<void> {
		try {
			const thread = await this.sessionService.getThreadByIdInternal(threadId);
			if (!thread) return;
			// Skip only if the thread has a REAL title. New chat threads are created
			// with the placeholder 'New conversation' (DEFAULT_THREAD_TITLE) persisted as
			// the title, which must still be replaced by the generated one; whereas
			// workflow titles and user renames must NOT be clobbered.
			const existing = thread.title?.trim();
			if (existing && existing !== DEFAULT_THREAD_TITLE) return;

			const allMessages = await this.sessionService.listMessages(threadId, ownerId);
			const userMessages = allMessages.filter((m) => m.role === 'user');
			if (userMessages.length < 2) return;

			// Text of the first two user messages as title context.
			const textOf = (idx: number): string => {
				const msg = userMessages[idx];
				return msg.content
					.filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
					.map((b) => b.text)
					.join(' ');
			};

			const first = textOf(0);
			const second = textOf(1);
			if (!first && !second) return;

			const title = await this.llmProxyService.generateThreadTitle(
				threadId,
				ownerId,
				agentId,
				first,
				second,
			);

			if (title) {
				agentStreamBus.emit(threadId, {
					type: 'thread_title_updated',
					threadId,
					title,
				});
			}
		} catch (err) {
			logger.warn({ err, threadId }, '[pipeline] title generation failed (non-fatal)');
		}
	}

	/**
	 * Summarize the most recently created previous thread into long-term memory.
	 * Only runs if the agent has both a chat LLM and an embedding model configured.
	 */
	private async summarizePreviousThread(
		agentId: string,
		ownerId: string,
		currentThreadId: string,
	): Promise<void> {
		const agent = await this.agentService.getById(agentId, ownerId);
		if (!agent?.modelConfigId || !agent.embeddingModelConfigId) return;

		const prevThread = await this.sessionService.getLastThreadBeforeId(
			agentId,
			ownerId,
			currentThreadId,
		);
		if (!prevThread) return;

		await this.llmProxyService.summarizeThreadToMemory(agentId, ownerId, prevThread.id);
	}
}
