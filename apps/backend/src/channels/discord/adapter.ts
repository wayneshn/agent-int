import type {
	ChannelAdapter,
	ChannelStreamSubscriber,
	ChannelSubscriberOptions,
	InboundMessage,
	InboundContent,
	OutboundMessage,
	AdapterInboundContext,
} from '@repo/types';
import {
	DiscordBotApi,
	type DiscordMessageCreateEvent,
	type DiscordInteraction,
} from './bot-api.js';
import { handleChannelCommand } from '../commands.js';
import { resolveActiveThread } from '../thread-routing.js';
import { createBatchedSubscriber, type BatchedDelivery } from '../batched-subscriber.js';
import { chunkText } from '../text-chunk.js';
import type { ChannelService } from '../../services/ChannelService.js';
import type { AgentService } from '../../services/AgentService.js';
import type { AgentSessionService } from '../../services/AgentSessionService.js';
import type { AgentLlmProxyService } from '../../services/AgentLlmProxyService.js';
import {
	ChatFileService,
	MAX_CHAT_FILE_BYTES,
	type ChatUploadInput,
} from '../../services/ChatFileService.js';
import { fetchCapped } from '../download.js';
import { logger } from '../../config/logger.js';

/** Attachment shape on a Discord message-create event. */
type DiscordAttachment = NonNullable<DiscordMessageCreateEvent['attachments']>[number];

/** Discord message character limit */
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

/** How often to re-send the typing indicator while the agent is working (ms). Discord expires it after ~10s. */
const TYPING_REFRESH_MS = 8000;

/** Split text into chunks that fit within Discord's 2000 character limit. */
function splitMessage(text: string): string[] {
	return chunkText(text, DISCORD_MAX_MESSAGE_LENGTH);
}

/**
 * DiscordAdapter — batched delivery via Gateway WebSocket.
 *
 * Receives messages via the DiscordGateway WebSocket connection.
 * Delivers responses by accumulating text_delta events and sending the
 * full response as Discord DM message(s) on completion.
 *
 * handleInbound() is called by DiscordGateway for every relevant incoming
 * MESSAGE_CREATE or INTERACTION_CREATE event. It:
 *   1. Detects /commands and routes them to handleChannelCommand()
 *   2. Looks up the channel_link for the sender
 *   3. Checks per_session thread expiry and auto-creates a new thread if needed
 *   4. Returns a fully resolved InboundMessage for the pipeline to process
 *
 * createStreamSubscriber() returns a batched subscriber that:
 *   - Sends typing indicators while the agent works
 *   - Accumulates text_delta into a buffer
 *   - Flushes as Discord DM message(s) on message_end
 *   - Sends HITL prompts with Discord button components
 *
 * Slash command interactions (type 2 APPLICATION_COMMAND):
 *   Discord requires an acknowledgement within 3 seconds. We immediately defer
 *   (type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE), then reply using
 *   editOriginalInteractionResponse via the interaction webhook token.
 */
export class DiscordAdapter implements ChannelAdapter {
	readonly channel = 'discord';
	readonly deliveryMode = 'batched' as const;

	private readonly botApi: DiscordBotApi;

	/**
	 * Cache of userId → DM channelId to avoid repeated createDM calls.
	 * Entries persist for the lifetime of the adapter (per-credential).
	 */
	private readonly dmChannelCache = new Map<string, string>();

	constructor(
		botToken: string,
		private readonly credentialId: string,
		private readonly channelService: ChannelService,
		private readonly agentService: AgentService,
		private readonly sessionService: AgentSessionService,
		private readonly chatFileService: ChatFileService,
		private readonly llmProxyService: AgentLlmProxyService,
		/** Bot application ID — required for editOriginalInteractionResponse on slash commands */
		private readonly applicationId?: string,
	) {
		this.botApi = new DiscordBotApi(botToken);
	}

	/**
	 * Parse a Discord MESSAGE_CREATE or INTERACTION_CREATE event into an InboundMessage.
	 *
	 * The rawBody is either a DiscordMessageCreateEvent or a DiscordInteraction,
	 * supplied by DiscordGateway. Both cases are handled here.
	 * Returns null if the message was handled internally or should be discarded.
	 */
	async handleInbound(context: AdapterInboundContext): Promise<InboundMessage | null> {
		// The gateway calls this with the raw event as rawBody.
		// We differentiate by checking for an 'interaction_type' marker set by the gateway manager.
		const isInteraction = context.params['eventType'] === 'interaction';

		if (isInteraction) {
			return this.handleInteraction(context.rawBody as DiscordInteraction);
		}

		return this.handleMessage(context.rawBody as DiscordMessageCreateEvent);
	}

	/** Handle a regular DM message */
	private async handleMessage(msg: DiscordMessageCreateEvent): Promise<InboundMessage | null> {
		const userId = msg.author.id;
		const displayName = msg.author.global_name ?? msg.author.username;
		const text = msg.content.trim();
		const hasAttachment = !!(msg.attachments && msg.attachments.length > 0);

		// Route /commands through the universal handler
		if (text.startsWith('/')) {
			const dmChannelId = await this.ensureDmChannel(userId);

			const handled = await handleChannelCommand(text, {
				channelService: this.channelService,
				agentService: this.agentService,
				sessionService: this.sessionService,
				llmProxyService: this.llmProxyService,
				channel: 'discord',
				externalId: userId,
				displayName,
				credentialId: this.credentialId,
				sendReply: async (replyText) => {
					await this.sendToChannel(dmChannelId, replyText);
				},
			});

			if (handled) return null;
		}

		if (!text && !hasAttachment) return null;

		return this.buildInboundMessage(userId, text, msg.channel_id, msg.attachments);
	}

	/**
	 * Handle an INTERACTION_CREATE event.
	 *
	 * type 2 = APPLICATION_COMMAND (slash command):
	 *   Must acknowledge within 3 seconds. We send a type 5 deferred response
	 *   immediately, then process the command and edit the original response.
	 *
	 * type 3 = MESSAGE_COMPONENT (button click, for HITL):
	 *   Acknowledge with type 6 silently, then feed the button value as a message.
	 */
	private async handleInteraction(interaction: DiscordInteraction): Promise<InboundMessage | null> {
		if (interaction.type === 2) {
			return this.handleSlashCommand(interaction);
		}
		return this.handleButtonInteraction(interaction);
	}

	/**
	 * Handle a slash command (APPLICATION_COMMAND, type 2).
	 *
	 * Immediately defers with type 5 so Discord shows a "thinking" indicator
	 * and doesn't time out. The command result is sent via editOriginalInteractionResponse.
	 */
	private async handleSlashCommand(
		interaction: DiscordInteraction,
	): Promise<InboundMessage | null> {
		const userId = interaction.user?.id ?? interaction.member?.user.id;
		if (!userId || !interaction.data?.name) return null;

		const commandName = interaction.data.name;
		const displayName =
			interaction.user?.global_name ??
			interaction.user?.username ??
			interaction.member?.user.username ??
			userId;

		// Immediately acknowledge to Discord — must happen within 3 seconds.
		// type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (shows "Bot is thinking...")
		try {
			await this.botApi.createInteractionResponse(interaction.id, interaction.token, { type: 5 });
		} catch (err) {
			logger.warn({ err }, '[discord] failed to defer slash command interaction');
			// Continue anyway — we may still be within the 3s window
		}

		// Build the command text from the interaction data.
		// Options carry typed argument values (e.g. /pair code:ABC123).
		const args =
			interaction.data.options
				?.map((opt) => (opt.value !== undefined ? String(opt.value) : ''))
				.filter(Boolean) ?? [];
		const commandText = args.length > 0 ? `/${commandName} ${args.join(' ')}` : `/${commandName}`;

		// Resolve the DM channel for fallback responses
		const dmChannelId = await this.ensureDmChannel(userId).catch(() => null);

		/**
		 * sendReply for slash commands: edit the original deferred interaction response.
		 * Falls back to a DM if we don't have the applicationId (should not happen in practice).
		 */
		const sendReply = async (replyText: string): Promise<void> => {
			if (this.applicationId) {
				try {
					// Split if needed — interaction follow-ups also have a 2000 char limit
					const chunks = splitMessage(replyText);
					// Edit the original deferred message with the first chunk
					await this.botApi.editOriginalInteractionResponse(
						this.applicationId,
						interaction.token,
						chunks[0],
					);
					// Send remaining chunks as regular DM messages
					if (dmChannelId && chunks.length > 1) {
						for (const chunk of chunks.slice(1)) {
							await this.botApi
								.sendMessage(dmChannelId, { content: chunk })
								.catch((err: unknown) => {
									logger.warn({ err }, '[discord] slash command overflow chunk failed');
								});
						}
					}
					return;
				} catch (err) {
					logger.warn(
						{ err },
						'[discord] editOriginalInteractionResponse failed — falling back to DM',
					);
				}
			}
			// Fallback: send as a regular DM
			if (dmChannelId) {
				await this.sendToChannel(dmChannelId, replyText).catch(() => {});
			}
		};

		const handled = await handleChannelCommand(commandText, {
			channelService: this.channelService,
			agentService: this.agentService,
			sessionService: this.sessionService,
			llmProxyService: this.llmProxyService,
			channel: 'discord',
			externalId: userId,
			displayName,
			credentialId: this.credentialId,
			sendReply,
		});

		// Slash commands are always channel commands — they never go to the pipeline.
		// If somehow not handled, send a fallback.
		if (!handled) {
			await sendReply(
				`Unknown command: /${commandName}. Use /help to see available commands.`,
			).catch(() => {});
		}

		return null;
	}

	/** Handle a button interaction (HITL option selection, MESSAGE_COMPONENT, type 3) */
	private async handleButtonInteraction(
		interaction: DiscordInteraction,
	): Promise<InboundMessage | null> {
		const userId = interaction.user?.id ?? interaction.member?.user.id;
		if (!userId || !interaction.data?.custom_id) return null;

		const buttonValue = interaction.data.custom_id;

		// Acknowledge the interaction to remove the loading state from the button.
		// type 6 = DEFERRED_UPDATE_MESSAGE — silent acknowledgement
		this.botApi
			.createInteractionResponse(interaction.id, interaction.token, { type: 6 })
			.catch((err: unknown) => {
				logger.warn({ err }, '[discord] failed to acknowledge button interaction');
			});

		const dmChannelId = interaction.channel_id ?? (await this.ensureDmChannel(userId));
		return this.buildInboundMessage(userId, buttonValue, dmChannelId);
	}

	/** Build an InboundMessage for a text payload, resolving thread context. */
	private async buildInboundMessage(
		userId: string,
		text: string,
		dmChannelId: string,
		attachments?: DiscordAttachment[],
	): Promise<InboundMessage | null> {
		// Cache the DM channel for this user
		this.dmChannelCache.set(userId, dmChannelId);

		// Look up the channel link
		const link = await this.channelService.getLinkByExternalId('discord', userId);
		if (!link) {
			// Not paired — send guidance and discard
			await this.sendToChannel(
				dmChannelId,
				'Please pair your account first. Visit **Account → Channels** in the web app and generate a code, then send:\n`/pair <CODE>`',
			).catch(() => {});
			return null;
		}

		// Resolve or auto-create the active thread (shared per_session logic)
		const { threadId, sessionExpired } = await resolveActiveThread(
			this.sessionService,
			this.channelService,
			link,
		);
		if (sessionExpired) {
			await this.sendToChannel(
				dmChannelId,
				'🔄 Session expired. Starting a new conversation.',
			).catch(() => {});
		}

		const content: InboundContent[] = [];
		if (text.trim()) content.push({ type: 'text', text });

		// Download + ingest any attachments, then reference them by fileId so the agent
		// receives them exactly like a web upload.
		if (attachments && attachments.length > 0) {
			const { uploads, downloadFailures } = await this.downloadAttachments(attachments);
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
				content.push({ type: 'text', text: `[Couldn't fetch "${f.name}" from Discord: ${f.reason}]` });
			}
		}

		if (content.length === 0) return null;

		return {
			channel: 'discord',
			externalId: userId,
			userId: link.userId,
			agentId: link.agentId,
			threadId,
			content,
			notifyToolUsage: link.notifyToolUsage,
		};
	}

	/**
	 * Download Discord attachments (public CDN urls — no auth) into ChatUploadInput[].
	 * Network failures are collected, not thrown.
	 */
	private async downloadAttachments(
		attachments: DiscordAttachment[],
	): Promise<{ uploads: ChatUploadInput[]; downloadFailures: { name: string; reason: string }[] }> {
		const uploads: ChatUploadInput[] = [];
		const downloadFailures: { name: string; reason: string }[] = [];
		const overLimit = `exceeds the ${Math.floor(MAX_CHAT_FILE_BYTES / (1024 * 1024))}MB limit`;

		for (const att of attachments) {
			// Reject on the size Discord already declared, before fetching a single byte.
			if (att.size > MAX_CHAT_FILE_BYTES) {
				downloadFailures.push({ name: att.filename, reason: overLimit });
				continue;
			}
			try {
				// fetchCapped enforces the cap WHILE streaming, so an understated/absent
				// Content-Length can never force an unbounded allocation.
				const bytes = await fetchCapped(att.url, MAX_CHAT_FILE_BYTES, {
					signal: AbortSignal.timeout(60_000),
				});
				uploads.push({
					name: att.filename,
					mimeType: att.content_type,
					sizeBytes: bytes.length,
					data: bytes,
				});
			} catch (err) {
				logger.warn({ err, url: att.url }, '[discord] attachment download failed');
				const reason = err instanceof Error && err.message.includes('limit') ? overLimit : 'download failed';
				downloadFailures.push({ name: att.filename, reason });
			}
		}

		return { uploads, downloadFailures };
	}

	/**
	 * Create a batched stream subscriber for a Discord DM.
	 *
	 * Accumulates text_delta events into a buffer.
	 * Sends typing indicators while the agent works (refreshes every 8s).
	 * Flushes the buffer as Discord DM message(s) on message_end.
	 * Sends HITL prompts with Discord button components when hitl_request fires.
	 */
	createStreamSubscriber(
		_threadId: string,
		externalId: string,
		options?: ChannelSubscriberOptions,
	): ChannelStreamSubscriber {
		const botApi = this.botApi;
		const dmChannelCache = this.dmChannelCache;

		/** Get or create the DM channel for this user */
		const getDmChannelId = async (): Promise<string | null> => {
			const cached = dmChannelCache.get(externalId);
			if (cached) return cached;
			try {
				const channel = await botApi.createDM(externalId);
				dmChannelCache.set(externalId, channel.id);
				return channel.id;
			} catch (err) {
				logger.error({ err, externalId }, '[discord] failed to create DM channel');
				return null;
			}
		};

		const delivery: BatchedDelivery = {
			channel: 'discord',
			typingRefreshMs: TYPING_REFRESH_MS,

			async sendTyping() {
				const channelId = await getDmChannelId();
				if (!channelId) return;
				await botApi.sendTyping(channelId).catch(() => {});
			},

			async sendText(text) {
				const channelId = await getDmChannelId();
				if (!channelId) return;
				for (const chunk of splitMessage(text)) {
					await botApi.sendMessage(channelId, { content: chunk }).catch((err: unknown) => {
						logger.error({ err, externalId }, '[discord] failed to send message chunk');
					});
				}
			},

			async sendNotice(text) {
				const channelId = await getDmChannelId();
				if (!channelId) return;
				for (const chunk of splitMessage(text)) {
					await botApi.sendMessage(channelId, { content: chunk });
				}
			},

			async sendHitl(prompt, hitlOptions) {
				const channelId = await getDmChannelId();
				if (!channelId) return;
				if (hitlOptions.length > 0) {
					// Discord buttons: max 5 per row
					const buttons = hitlOptions.slice(0, 5).map((o) => ({
						type: 2, // BUTTON
						style: 2, // SECONDARY
						label: o.slice(0, 80), // Discord button label max 80 chars
						custom_id: o.slice(0, 100), // custom_id max 100 chars
					}));
					await botApi.sendMessage(channelId, {
						content: prompt,
						components: [{ type: 1 /* ACTION_ROW */, components: buttons }],
					});
				} else {
					await botApi.sendMessage(channelId, { content: prompt });
				}
			},

			// Discord renders image attachments inline automatically; other files
			// arrive as downloadable attachments. One upload per file.
			async sendFile(file, bytes) {
				const channelId = await getDmChannelId();
				if (!channelId) return;
				await botApi.sendMessage(channelId, {
					files: [{ name: file.name, data: bytes }],
				});
			},
		};

		return createBatchedSubscriber(delivery, {
			notifyToolUsage: options?.notifyToolUsage ?? false,
			loadBytes: (file) => Promise.resolve(this.chatFileService.readBytes(file)),
		});
	}

	/** Send a proactive message to a Discord user (used for error/status notifications). */
	async send(message: OutboundMessage): Promise<void> {
		const userId = message.externalId;
		let channelId = this.dmChannelCache.get(userId);

		if (!channelId) {
			try {
				const channel = await this.botApi.createDM(userId);
				channelId = channel.id;
				this.dmChannelCache.set(userId, channelId);
			} catch (err) {
				logger.error({ err, userId }, '[discord] send: failed to create DM channel');
				return;
			}
		}

		for (const content of message.content) {
			if (content.type === 'text') {
				const chunks = splitMessage(content.text);
				for (const chunk of chunks) {
					await this.botApi.sendMessage(channelId, { content: chunk }).catch((err: unknown) => {
						logger.error({ err, userId }, '[discord] send failed');
					});
				}
			}
		}
	}

	/** Expose the underlying botApi for use by DiscordGatewayManager. */
	getBotApi(): DiscordBotApi {
		return this.botApi;
	}

	// ─── Private helpers ──────────────────────────────────────────────────────

	/** Get or create and cache a DM channel ID for a user. */
	private async ensureDmChannel(userId: string): Promise<string> {
		const cached = this.dmChannelCache.get(userId);
		if (cached) return cached;
		const channel = await this.botApi.createDM(userId);
		this.dmChannelCache.set(userId, channel.id);
		return channel.id;
	}

	/** Send text to a channel, splitting if needed. */
	private async sendToChannel(channelId: string, text: string): Promise<void> {
		const chunks = splitMessage(text);
		for (const chunk of chunks) {
			await this.botApi.sendMessage(channelId, { content: chunk });
		}
	}
}
