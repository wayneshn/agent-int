import { logger } from '../../config/logger.js';
import { TelegramBotApi } from './bot-api.js';
import { TelegramAdapter } from './adapter.js';
import { TelegramPoller } from './poller.js';
import type { CredentialService } from '../../services/CredentialService.js';
import type { ChannelService } from '../../services/ChannelService.js';
import type { AgentService } from '../../services/AgentService.js';
import type { AgentSessionService } from '../../services/AgentSessionService.js';
import type { MessagePipeline } from '../pipeline.js';
import type { ChatFileService } from '../../services/ChatFileService.js';

/**
 * TelegramPollerManager — manages all active Telegram polling loops.
 *
 * One TelegramPoller runs per unique bot credential. The manager:
 *   - Loads all active credentials at server startup (loadActivePollers)
 *   - Starts a new poller on demand when a pairing code is generated (ensurePolling)
 *   - Stops and removes a poller when a credential is deleted (stopPoller)
 *
 * Adapters are keyed by credentialId. Each poller passes its own adapter to
 * MessagePipeline.process(), so responses always go out through the same bot
 * token that received the message — even with multiple bots on the channel.
 */
export class TelegramPollerManager {
	/** Map of credentialId → running poller */
	private pollers: Map<string, TelegramPoller> = new Map();
	/** Map of credentialId → adapter (needed to stop/remove cleanly) */
	private adapters: Map<string, TelegramAdapter> = new Map();

	constructor(
		private readonly credentialService: CredentialService,
		private readonly channelService: ChannelService,
		private readonly agentService: AgentService,
		private readonly sessionService: AgentSessionService,
		private readonly pipeline: MessagePipeline,
		private readonly chatFileService: ChatFileService,
	) {}

	/**
	 * Load all active Telegram pollers at server startup.
	 * Queries channel_links for unique credentialIds, decrypts each,
	 * and starts a poller for each valid bot token.
	 *
	 * Non-fatal: a bad credential just gets logged and skipped.
	 */
	async loadActivePollers(): Promise<void> {
		const credentialIds = await this.channelService.listActiveCredentialIds('telegram');

		if (credentialIds.length === 0) {
			logger.info('[telegram-poller-manager] no active Telegram credentials — skipping startup');
			return;
		}

		logger.info(
			{ count: credentialIds.length },
			'[telegram-poller-manager] loading active pollers',
		);

		await Promise.allSettled(credentialIds.map((credentialId) => this.startPoller(credentialId)));
	}

	/**
	 * Ensure a poller is running for the given credentialId.
	 * If already running, this is a no-op.
	 * Called when a pairing code is generated so the bot is ready to receive
	 * the /pair command before the user sends it.
	 */
	async ensurePolling(credentialId: string): Promise<void> {
		if (this.pollers.has(credentialId)) return;
		await this.startPoller(credentialId);
	}

	/**
	 * The running adapter for a bot credential, for proactive outbound sends
	 * (OutboundDeliveryService). Undefined when no poller is active for it.
	 */
	getAdapter(credentialId: string): TelegramAdapter | undefined {
		return this.adapters.get(credentialId);
	}

	/**
	 * Stop the poller for a given credentialId.
	 * Called when the bot credential is deleted, or when the last channel link
	 * using the credential is removed. No-op if nothing is running for it.
	 */
	stopPoller(credentialId: string): void {
		const poller = this.pollers.get(credentialId);
		if (!poller && !this.adapters.has(credentialId)) return;
		if (poller) {
			poller.stop();
			this.pollers.delete(credentialId);
		}
		this.adapters.delete(credentialId);
		logger.info({ credentialId }, '[telegram-poller-manager] poller stopped');
	}

	/** Stop all pollers (e.g. on graceful shutdown). */
	stopAll(): void {
		for (const [credentialId, poller] of this.pollers) {
			poller.stop();
			logger.info({ credentialId }, '[telegram-poller-manager] stopping poller');
		}
		this.pollers.clear();
		this.adapters.clear();
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	/**
	 * Decrypt the credential, create the adapter + poller, and start polling.
	 * On any error (bad credential, already running, etc.) logs and returns.
	 */
	private async startPoller(credentialId: string): Promise<void> {
		if (this.pollers.has(credentialId)) return;

		try {
			const data = await this.credentialService.getDecryptedDataInternal(credentialId);

			if (!data) {
				logger.warn({ credentialId }, '[telegram-poller-manager] credential not found — skipping');
				return;
			}

			const botToken = data.botToken;
			if (typeof botToken !== 'string' || !botToken) {
				logger.warn(
					{ credentialId },
					'[telegram-poller-manager] credential has no botToken — skipping',
				);
				return;
			}

			const adapter = new TelegramAdapter(
				botToken,
				credentialId,
				this.channelService,
				this.agentService,
				this.sessionService,
				this.chatFileService,
			);

			const botApi = adapter.getBotApi();
			const poller = new TelegramPoller(botApi, adapter, this.pipeline, credentialId);

			this.adapters.set(credentialId, adapter);
			this.pollers.set(credentialId, poller);

			poller.start();

			logger.info({ credentialId }, '[telegram-poller-manager] poller started');
		} catch (err: unknown) {
			logger.error({ err, credentialId }, '[telegram-poller-manager] failed to start poller');
		}
	}
}
