import type { ChannelLink } from '@repo/types';
import { NotificationService } from './NotificationService.js';
import { ChannelService } from './ChannelService.js';
import type { TelegramPollerManager } from '../channels/telegram/poller-manager.js';
import type { DiscordGatewayManager } from '../channels/discord/gateway-manager.js';
import { logger } from '../config/logger.js';

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Proactive outbound delivery to a user — the piece the reactive channel
 * pipeline deliberately lacks (adapters only push inside a subscriber that was
 * registered while handling an INBOUND message).
 *
 * Every delivery writes an in-app notification row (the always-on leg, surfaced
 * by the web bell). When the user has a verified Telegram/Discord link, the
 * message is additionally pushed through that bot's running adapter — strictly
 * best-effort: channel failures are logged and never propagate to the caller
 * (a mission report must not fail because a bot token was revoked).
 */
export class OutboundDeliveryService {
	constructor(
		private readonly notificationService: NotificationService,
		private readonly channelService: ChannelService,
		private readonly telegramPollerManager: TelegramPollerManager,
		private readonly discordGatewayManager: DiscordGatewayManager,
	) {}

	/**
	 * Deliver a message to a user. Returns the channels it went out on
	 * ('app' is always present; 'telegram'/'discord' when a push succeeded).
	 */
	async deliverToOwner(input: {
		ownerId: string;
		agentId?: string;
		missionId?: string;
		/** Notification category, e.g. 'mission_report', 'mission_paused', 'approval_requested' */
		type: string;
		title: string;
		body?: string;
		/** Root-relative web deep link (e.g. /app/agents/x/missions/y) */
		linkPath?: string;
		/** Channel link to prefer (e.g. the mission's configured report link) */
		preferredLinkId?: string;
	}): Promise<{ channels: string[] }> {
		const channels: string[] = [];

		// In-app notification — the one leg that must not fail silently.
		try {
			await this.notificationService.create({
				userId: input.ownerId,
				agentId: input.agentId,
				missionId: input.missionId,
				type: input.type,
				title: input.title,
				body: input.body,
				linkPath: input.linkPath,
			});
			channels.push('app');
		} catch (err) {
			logger.error({ err, ownerId: input.ownerId }, '[outbound] failed to write notification');
		}

		// Channel push — best-effort extra.
		try {
			const link = await this.resolveLink(input.ownerId, input.preferredLinkId);
			if (link) {
				const delivered = await this.sendViaLink(link, input.title, input.body);
				if (delivered) channels.push(link.channel);
			}
		} catch (err) {
			logger.warn({ err, ownerId: input.ownerId }, '[outbound] channel push failed');
		}

		return { channels };
	}

	// ─── Private ───────────────────────────────────────────────────────────

	/** Preferred link when given and usable, else the first verified pushable link */
	private async resolveLink(
		ownerId: string,
		preferredLinkId?: string,
	): Promise<ChannelLink | null> {
		const links = await this.channelService.listLinksByUser(ownerId);
		const pushable = (l: ChannelLink): boolean =>
			l.isVerified && !!l.credentialId && (l.channel === 'telegram' || l.channel === 'discord');
		if (preferredLinkId) {
			const preferred = links.find((l) => l.id === preferredLinkId);
			if (preferred && pushable(preferred)) return preferred;
		}
		return links.find(pushable) ?? null;
	}

	/** Push through the link's running bot adapter. Returns true on (apparent) success. */
	private async sendViaLink(link: ChannelLink, title: string, body?: string): Promise<boolean> {
		const credentialId = link.credentialId;
		if (!credentialId) return false;
		const text = body ? `*${title}*\n\n${body}` : title;
		const message = {
			channel: link.channel,
			externalId: link.externalId,
			content: [{ type: 'text' as const, text }],
		};

		if (link.channel === 'telegram') {
			// ensurePolling restarts the adapter after a backend restart if the
			// startup loader missed it (e.g. credential re-created).
			await this.telegramPollerManager.ensurePolling(credentialId);
			const adapter = this.telegramPollerManager.getAdapter(credentialId);
			if (!adapter) return false;
			await adapter.send(message);
			return true;
		}
		if (link.channel === 'discord') {
			await this.discordGatewayManager.ensureGateway(credentialId);
			const adapter = this.discordGatewayManager.getAdapter(credentialId);
			if (!adapter) return false;
			await adapter.send(message);
			return true;
		}
		return false;
	}
}
