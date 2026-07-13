import { logger } from '../../config/logger.js';
import { CHANNEL_COMMANDS } from '../commands.js';
import { DiscordBotApi } from './bot-api.js';
import { DiscordAdapter } from './adapter.js';
import { DiscordGateway, type DiscordGatewayCallbacks } from './gateway.js';
import type { CredentialService } from '../../services/CredentialService.js';
import type { ChannelService } from '../../services/ChannelService.js';
import type { AgentService } from '../../services/AgentService.js';
import type { AgentSessionService } from '../../services/AgentSessionService.js';
import type { AgentLlmProxyService } from '../../services/AgentLlmProxyService.js';
import type { MessagePipeline } from '../pipeline.js';
import type { ChatFileService } from '../../services/ChatFileService.js';

/**
 * DiscordGatewayManager — manages all active Discord Gateway connections.
 *
 * One DiscordGateway connection runs per unique bot credential. The manager:
 *   - Loads all active credentials at server startup (loadActiveGateways)
 *   - Starts a new gateway on demand when a pairing code is generated (ensureGateway)
 *   - Stops and removes a gateway when a credential is deleted (stopGateway)
 *
 * Adapters are keyed by credentialId. Each gateway callback passes its own
 * adapter to MessagePipeline.process(), so responses always go out through the
 * same bot token that received the message — even with multiple bots active.
 */
export class DiscordGatewayManager {
	/** Map of credentialId → running gateway */
	private gateways: Map<string, DiscordGateway> = new Map();
	/** Map of credentialId → adapter */
	private adapters: Map<string, DiscordAdapter> = new Map();

	constructor(
		private readonly credentialService: CredentialService,
		private readonly channelService: ChannelService,
		private readonly agentService: AgentService,
		private readonly sessionService: AgentSessionService,
		private readonly pipeline: MessagePipeline,
		private readonly chatFileService: ChatFileService,
		private readonly llmProxyService: AgentLlmProxyService,
	) {}

	/**
	 * Load all active Discord gateways at server startup.
	 * Queries channel_links for unique credentialIds (channel='discord'),
	 * decrypts each, and starts a gateway connection for each valid bot token.
	 *
	 * Non-fatal: a bad credential is logged and skipped.
	 */
	async loadActiveGateways(): Promise<void> {
		const credentialIds = await this.channelService.listActiveCredentialIds('discord');

		if (credentialIds.length === 0) {
			logger.info('[discord-gateway-manager] no active Discord credentials — skipping startup');
			return;
		}

		logger.info(
			{ count: credentialIds.length },
			'[discord-gateway-manager] loading active gateways',
		);

		await Promise.allSettled(credentialIds.map((credentialId) => this.startGateway(credentialId)));
	}

	/**
	 * Ensure a gateway is running for the given credentialId.
	 * If already running, this is a no-op.
	 * Called when a Discord pairing code is generated so the bot can immediately
	 * receive the /pair command once the user sends it.
	 */
	async ensureGateway(credentialId: string): Promise<void> {
		if (this.gateways.has(credentialId)) return;
		await this.startGateway(credentialId);
	}

	/**
	 * The running adapter for a bot credential, for proactive outbound sends
	 * (OutboundDeliveryService). Undefined when no gateway is active for it.
	 */
	getAdapter(credentialId: string): DiscordAdapter | undefined {
		return this.adapters.get(credentialId);
	}

	/**
	 * Stop the gateway for a given credentialId.
	 * Called when the bot credential is deleted, or when the last channel link
	 * using the credential is removed. No-op if nothing is running for it.
	 */
	stopGateway(credentialId: string): void {
		const gateway = this.gateways.get(credentialId);
		if (!gateway && !this.adapters.has(credentialId)) return;
		if (gateway) {
			gateway.stop();
			this.gateways.delete(credentialId);
		}
		this.adapters.delete(credentialId);
		logger.info({ credentialId }, '[discord-gateway-manager] gateway stopped');
	}

	/** Stop all gateways (e.g. on graceful shutdown). */
	stopAll(): void {
		for (const [credentialId, gateway] of this.gateways) {
			gateway.stop();
			logger.info({ credentialId }, '[discord-gateway-manager] stopping gateway');
		}
		this.gateways.clear();
		this.adapters.clear();
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	/**
	 * Decrypt the credential, create the adapter + gateway, and start the connection.
	 * On any error (bad credential, network issue) logs and returns.
	 */
	private async startGateway(credentialId: string): Promise<void> {
		if (this.gateways.has(credentialId)) return;

		try {
			const data = await this.credentialService.getDecryptedDataInternal(credentialId);

			if (!data) {
				logger.warn({ credentialId }, '[discord-gateway-manager] credential not found — skipping');
				return;
			}

			const token = data.token;
			if (typeof token !== 'string' || !token) {
				logger.warn(
					{ credentialId },
					'[discord-gateway-manager] credential has no token — skipping',
				);
				return;
			}

			// Get the bot's own user ID (application ID) and Gateway URL
			const botApi = new DiscordBotApi(token);
			const [botUser, gatewayInfo] = await Promise.all([botApi.getMe(), botApi.getGatewayBot()]);
			const { url: gatewayUrl } = gatewayInfo;
			const applicationId = botUser.id;

			// Register slash commands for / autocomplete (non-fatal if it fails)
			await botApi
				.bulkOverwriteGlobalCommands(
					applicationId,
					CHANNEL_COMMANDS.map((cmd) => ({
						name: cmd.command,
						description: cmd.description,
						options: cmd.options,
					})),
				)
				.then(() => {
					logger.info(
						{ credentialId, commandCount: CHANNEL_COMMANDS.length },
						'[discord-gateway-manager] slash commands registered',
					);
				})
				.catch((err: unknown) => {
					logger.warn(
						{ err, credentialId },
						'[discord-gateway-manager] slash command registration failed (non-fatal)',
					);
				});

			const adapter = new DiscordAdapter(
				token,
				credentialId,
				this.channelService,
				this.agentService,
				this.sessionService,
				this.chatFileService,
				this.llmProxyService,
				applicationId,
			);

			// Build gateway callbacks that route events through the adapter → pipeline
			const callbacks: DiscordGatewayCallbacks = {
				onMessage: async (event) => {
					const inbound = await adapter.handleInbound({
						rawBody: event,
						headers: {},
						params: { eventType: 'message' },
						query: {},
					});

					if (!inbound) return;

					// Pass this gateway's own adapter so the response is delivered
					// through the same bot token that received the message.
					const result = await this.pipeline.process(inbound, adapter);

					if (!result.ok) {
						if (result.status === 409) {
							// Agent busy — send a user-friendly notification
							adapter
								.send({
									channel: 'discord',
									externalId: inbound.externalId,
									content: [
										{
											type: 'text',
											text: '⏳ Still working on your previous message. Please wait.',
										},
									],
								})
								.catch(() => {});
							logger.debug(
								{ externalId: inbound.externalId },
								'[discord-gateway-manager] agent busy (409) — notified user',
							);
						} else {
							logger.error(
								{ status: result.status, error: result.error, credentialId },
								'[discord-gateway-manager] pipeline error',
							);
						}
					}
				},

				onInteraction: async (interaction) => {
					const inbound = await adapter.handleInbound({
						rawBody: interaction,
						headers: {},
						params: { eventType: 'interaction' },
						query: {},
					});

					if (!inbound) return;

					const result = await this.pipeline.process(inbound, adapter);

					if (!result.ok) {
						logger.error(
							{ status: result.status, error: result.error, credentialId },
							'[discord-gateway-manager] interaction pipeline error',
						);
					}
				},
			};

			const gateway = new DiscordGateway(token, callbacks, credentialId, gatewayUrl);

			this.adapters.set(credentialId, adapter);
			this.gateways.set(credentialId, gateway);

			gateway.start();

			logger.info({ credentialId }, '[discord-gateway-manager] gateway started');
		} catch (err: unknown) {
			logger.error({ err, credentialId }, '[discord-gateway-manager] failed to start gateway');
		}
	}
}
