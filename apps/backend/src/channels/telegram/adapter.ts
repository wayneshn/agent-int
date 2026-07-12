import type {
	ChannelAdapter,
	ChannelStreamSubscriber,
	ChannelSubscriberOptions,
	InboundMessage,
	InboundContent,
	OutboundMessage,
	AdapterInboundContext,
} from '@repo/types';
import { TelegramBotApi, type TgMessage, type TgUpdate } from './bot-api.js';
import { toTelegramHtml, splitForTelegram } from './formatter.js';
import { handleChannelCommand } from '../commands.js';
import { resolveActiveThread } from '../thread-routing.js';
import { createBatchedSubscriber, type BatchedDelivery } from '../batched-subscriber.js';
import type { ChannelService } from '../../services/ChannelService.js';
import type { AgentService } from '../../services/AgentService.js';
import type { AgentSessionService } from '../../services/AgentSessionService.js';
import type { AgentLlmProxyService } from '../../services/AgentLlmProxyService.js';
import {
	ChatFileService,
	MAX_CHAT_FILE_BYTES,
	type ChatUploadInput,
} from '../../services/ChatFileService.js';
import { logger } from '../../config/logger.js';

/** How often to re-send the typing indicator while the agent is working (ms) */
const TYPING_REFRESH_MS = 4000;

/**
 * TelegramAdapter — batched delivery model.
 *
 * Receives messages via long polling (TelegramPoller).
 * Delivers responses by accumulating text_delta events and sending the
 * full response as a single Telegram message on completion.
 *
 * The handleInbound() method is called by TelegramPoller for every incoming
 * Telegram Update. It:
 *   1. Detects /commands and routes them to handleChannelCommand()
 *   2. Looks up the channel_link for the sender
 *   3. Checks per_session thread expiry and auto-creates a new thread if needed
 *   4. Returns a fully resolved InboundMessage for the pipeline to process
 */
export class TelegramAdapter implements ChannelAdapter {
	readonly channel = 'telegram';
	readonly deliveryMode = 'batched' as const;

	private readonly botApi: TelegramBotApi;

	constructor(
		botToken: string,
		private readonly credentialId: string,
		private readonly channelService: ChannelService,
		private readonly agentService: AgentService,
		private readonly sessionService: AgentSessionService,
		private readonly chatFileService: ChatFileService,
		private readonly llmProxyService: AgentLlmProxyService,
	) {
		this.botApi = new TelegramBotApi(botToken);
	}

	/**
	 * Parse a Telegram message into an InboundMessage.
	 *
	 * The `rawBody` is a parsed TgUpdate object supplied by TelegramPoller.
	 * For callback_query (inline keyboard button press), we also handle it here.
	 * Returns null if the message was handled internally (command or unpaired user
	 * with no valid message content).
	 */
	async handleInbound(context: AdapterInboundContext): Promise<InboundMessage | null> {
		const update = context.rawBody as TgUpdate;

		// Handle inline keyboard callback queries (HITL option buttons)
		if (update.callback_query) {
			const cq = update.callback_query;
			const chatId = cq.message?.chat.id;
			if (chatId && cq.data) {
				// Answer the callback to remove the loading spinner
				this.botApi.answerCallbackQuery(cq.id).catch(() => {});
				// Treat the callback data as a regular text message through the pipeline
				return this.buildInboundMessage(chatId, cq.data);
			}
			return null;
		}

		if (!update.message) return null;

		const { message } = update;
		const chatId = message.chat.id;
		// Photo/document messages carry their text in `caption`, not `text`.
		const text = message.text ?? message.caption ?? '';
		const hasAttachment = !!(message.photo?.length || message.document);
		const displayName = message.from?.username
			? `@${message.from.username}`
			: (message.from?.first_name ?? String(chatId));

		// Route /commands through the universal handler
		if (text.startsWith('/')) {
			const handled = await handleChannelCommand(text, {
				channelService: this.channelService,
				agentService: this.agentService,
				sessionService: this.sessionService,
				llmProxyService: this.llmProxyService,
				channel: 'telegram',
				externalId: String(chatId),
				displayName,
				credentialId: this.credentialId,
				sendReply: async (replyText) => {
					await this.botApi.sendMessage(chatId, replyText).catch((err) => {
						logger.warn({ err, chatId }, '[telegram] sendReply failed');
					});
				},
			});

			if (handled) return null;
		}

		if (!text.trim() && !hasAttachment) return null;

		return this.buildInboundMessage(chatId, text, message);
	}

	/**
	 * Build an InboundMessage, resolving thread context. When the source message
	 * carries a photo/document, it is downloaded and ingested as a chat file so the
	 * agent receives it exactly like a web upload (via { type: 'file', fileId }).
	 */
	private async buildInboundMessage(
		chatId: number,
		text: string,
		message?: TgMessage,
	): Promise<InboundMessage | null> {
		const externalId = String(chatId);

		// Look up the channel link
		const link = await this.channelService.getLinkByExternalId('telegram', externalId);
		if (!link) {
			// Not paired — send guidance and discard
			await this.botApi
				.sendMessage(
					chatId,
					'Please pair your account first. Visit Account → Channels in the web app and generate a code, then send:\n/pair <CODE>',
				)
				.catch(() => {});
			return null;
		}

		// Resolve or auto-create the active thread (shared per_session logic)
		const { threadId, sessionExpired } = await resolveActiveThread(
			this.sessionService,
			this.channelService,
			link,
		);
		if (sessionExpired) {
			await this.botApi
				.sendMessage(chatId, '🔄 Session expired. Starting a new conversation.')
				.catch(() => {});
		}

		const content: InboundContent[] = [];
		if (text.trim()) content.push({ type: 'text', text });

		// Download + ingest any attachment, then reference it by fileId.
		if (message) {
			const { uploads, downloadFailures } = await this.downloadAttachments(message);
			if (uploads.length > 0) {
				const { created, skipped } = await this.chatFileService.ingestFiles(
					link.agentId,
					link.userId,
					threadId,
					uploads,
				);
				for (const file of created) content.push({ type: 'file', fileId: file.id });
				for (const s of skipped) {
					content.push({ type: 'text', text: `[Couldn't process "${s.name}": ${s.reason}]` });
				}
			}
			for (const f of downloadFailures) {
				content.push({ type: 'text', text: `[Couldn't fetch "${f.name}" from Telegram: ${f.reason}]` });
			}
		}

		if (content.length === 0) return null;

		return {
			channel: 'telegram',
			externalId,
			userId: link.userId,
			agentId: link.agentId,
			threadId,
			content,
			notifyToolUsage: link.notifyToolUsage,
		};
	}

	/**
	 * Download a Telegram message's photo (largest size) and/or document into
	 * ChatUploadInput[]. Network failures are collected, not thrown, so the rest of
	 * the message still processes.
	 */
	private async downloadAttachments(
		message: TgMessage,
	): Promise<{ uploads: ChatUploadInput[]; downloadFailures: { name: string; reason: string }[] }> {
		const uploads: ChatUploadInput[] = [];
		const downloadFailures: { name: string; reason: string }[] = [];
		const overLimit = `exceeds the ${Math.floor(MAX_CHAT_FILE_BYTES / (1024 * 1024))}MB limit`;

		const fetchOne = async (
			fileId: string,
			name: string,
			mimeType?: string,
			knownSize?: number,
		): Promise<void> => {
			try {
				// Reject on the size Telegram already told us about, before any download.
				if (knownSize !== undefined && knownSize > MAX_CHAT_FILE_BYTES) {
					downloadFailures.push({ name, reason: overLimit });
					return;
				}
				const { file_path, file_size } = await this.botApi.getFile(fileId);
				if (!file_path) throw new Error('no file_path');
				if (file_size !== undefined && file_size > MAX_CHAT_FILE_BYTES) {
					downloadFailures.push({ name, reason: overLimit });
					return;
				}
				// downloadFile still enforces the cap while streaming (defends against an
				// absent/understated declared size).
				const bytes = await this.botApi.downloadFile(file_path, MAX_CHAT_FILE_BYTES);
				uploads.push({ name, mimeType, sizeBytes: bytes.length, data: bytes });
			} catch (err) {
				logger.warn({ err, fileId }, '[telegram] attachment download failed');
				const reason = err instanceof Error && err.message.includes('limit') ? overLimit : 'download failed';
				downloadFailures.push({ name, reason });
			}
		};

		if (message.photo?.length) {
			// Telegram sends an array of sizes ascending — the last is the largest.
			const largest = message.photo[message.photo.length - 1];
			await fetchOne(
				largest.file_id,
				`photo_${message.message_id}.jpg`,
				'image/jpeg',
				largest.file_size,
			);
		}
		if (message.document) {
			await fetchOne(
				message.document.file_id,
				message.document.file_name ?? `document_${message.message_id}`,
				message.document.mime_type,
				message.document.file_size,
			);
		}

		return { uploads, downloadFailures };
	}

	/**
	 * Create a batched stream subscriber for a Telegram chat.
	 * The shared subscriber owns buffering/typing/tool-notice/flush; this adapter
	 * only supplies the Telegram send primitives.
	 */
	createStreamSubscriber(
		_threadId: string,
		externalId: string,
		options?: ChannelSubscriberOptions,
	): ChannelStreamSubscriber {
		const chatId = parseInt(externalId, 10);
		const botApi = this.botApi;

		const delivery: BatchedDelivery = {
			channel: 'telegram',
			typingRefreshMs: TYPING_REFRESH_MS,

			async sendTyping() {
				await botApi.sendChatAction(chatId, 'typing').catch(() => {});
			},

			// Long messages are split on the source text first so each chunk renders
			// as self-contained, balanced HTML (a chunk can't end mid-tag).
			async sendText(text) {
				for (const chunk of splitForTelegram(text)) {
					try {
						await botApi.sendMessage(chatId, toTelegramHtml(chunk), {
							parse_mode: 'HTML',
							disable_web_page_preview: true,
						});
					} catch (err) {
						// HTML parsing failed — fall back to plain, unformatted text
						logger.warn(
							{ err, chatId },
							'[telegram] HTML send failed — falling back to plain text',
						);
						await botApi.sendMessage(chatId, chunk).catch((fallbackErr: unknown) => {
							logger.error({ err: fallbackErr, chatId }, '[telegram] flush fallback failed');
						});
					}
				}
			},

			async sendNotice(text) {
				await botApi.sendMessage(chatId, text);
			},

			async sendHitl(prompt, hitlOptions) {
				if (hitlOptions.length > 0) {
					await botApi.sendMessage(chatId, prompt, {
						reply_markup: {
							inline_keyboard: [hitlOptions.map((o) => ({ text: o, callback_data: o }))],
						},
					});
				} else {
					await botApi.sendMessage(chatId, prompt);
				}
			},

			// Images render inline via sendPhoto; everything else as a downloadable document.
			async sendFile(file, bytes) {
				if (file.kind === 'image') {
					await botApi.sendPhoto(chatId, bytes, file.name);
				} else {
					await botApi.sendDocument(chatId, bytes, file.name, undefined, file.mimeType);
				}
			},
		};

		return createBatchedSubscriber(delivery, {
			notifyToolUsage: options?.notifyToolUsage ?? false,
			loadBytes: (file) => Promise.resolve(this.chatFileService.readBytes(file)),
		});
	}

	/** Send a message to a Telegram chat (used for proactive messages). */
	async send(message: OutboundMessage): Promise<void> {
		const chatId = parseInt(message.externalId, 10);
		for (const content of message.content) {
			if (content.type === 'text') {
				await this.botApi.sendMessage(chatId, content.text).catch((err) => {
					logger.error({ err, chatId }, '[telegram] send failed');
				});
			}
		}
	}

	/** Expose the underlying botApi for use by TelegramPoller. */
	getBotApi(): TelegramBotApi {
		return this.botApi;
	}
}
