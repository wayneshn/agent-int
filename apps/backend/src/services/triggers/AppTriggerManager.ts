import { and, eq, isNull, or } from 'drizzle-orm';
import type { AppTriggerConfig, AppTriggerRegistrationStatus, AppTriggerState } from '@repo/types';
import { db } from '../../db/index.js';
import { agentTriggers, workflows } from '../../db/schema/index.js';
import { logger } from '../../config/logger.js';
import type { CredentialResolverService } from '../CredentialResolverService.js';
import type { CredentialService } from '../CredentialService.js';
import type { TriggerService } from '../TriggerService.js';
import type { AppTriggerProviderRegistry } from './AppTriggerProviderRegistry.js';
import type {
	AppTriggerProvider,
	AppTriggerProviderContext,
	AppWebhookHandleResult,
	AppWebhookRequest,
	NormalizedAppEvent,
} from './AppTriggerProvider.js';
import { buildProviderContext } from './buildProviderContext.js';

/** Default poll cadence when a poll provider declares no minimum and the user sets none. */
const DEFAULT_POLL_INTERVAL_SEC = 60;
/** Consecutive listen failures before an app trigger is auto-disabled (mirrors cron). */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Renew a webhook subscription this long before its stated expiry. */
const RENEW_LEAD_MS = 60 * 60 * 1000; // 1 hour
/** Cap any renewal timer so a far-future expiry still wakes up periodically. */
const MAX_RENEW_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

/** A loaded app-trigger row with parsed config + state. */
interface AppTriggerRow {
	id: string;
	agentId: string;
	ownerId: string;
	name: string;
	config: AppTriggerConfig;
	state: AppTriggerState;
	isEnabled: boolean;
	workflowId: string | null;
}

/**
 * Manages the in-memory half of app triggers — poll timers, webhook subscription
 * registration/renewal, and stream connections — modeled on the channel managers +
 * TriggerService's cron section. The durable half is the `agent_triggers` row.
 *
 * Lifecycle:
 *   - loadActive() on startup activates every enabled app trigger (whose workflow,
 *     if any, is enabled).
 *   - scheduleFromTrigger()/unscheduleFromTrigger() are the public bridge helpers the
 *     route layer calls on create/update/delete (analog of TriggerService.scheduleFromWorkflow).
 *   - handleInboundWebhook() is invoked by the webhook route for kind='app' deliveries.
 *
 * Every external event is normalized by its provider and funneled through
 * TriggerService.fireAppEvent() — one workflow run per event.
 */
export class AppTriggerManager {
	private readonly pollTimers = new Map<string, NodeJS.Timeout>();
	private readonly renewalTimers = new Map<string, NodeJS.Timeout>();
	private readonly streamConns = new Map<string, { stop: () => Promise<void> }>();
	private readonly failureCounts = new Map<string, number>();
	/** Trigger ids with a poll currently in flight — prevents overlap when a poll runs longer than the interval. */
	private readonly pollsInFlight = new Set<string>();

	constructor(
		private readonly registry: AppTriggerProviderRegistry,
		private readonly resolver: CredentialResolverService,
		private readonly credentialService: CredentialService,
		private readonly triggerService: TriggerService,
	) {}

	// ─── Startup ──────────────────────────────────────────────────────────

	/** Load + activate all enabled app triggers (workflow enabled, if attached). */
	async loadActive(): Promise<void> {
		const rows = await db
			.select({ trigger: agentTriggers })
			.from(agentTriggers)
			.leftJoin(workflows, eq(agentTriggers.workflowId, workflows.id))
			.where(
				and(
					eq(agentTriggers.kind, 'app'),
					eq(agentTriggers.isEnabled, true),
					or(isNull(agentTriggers.workflowId), eq(workflows.isEnabled, true)),
				),
			);

		let activated = 0;
		for (const row of rows) {
			try {
				await this.activate(this.mapRow(row.trigger));
				activated++;
			} catch (err) {
				logger.error(
					{ err, triggerId: row.trigger.id },
					'[app-trigger] failed to activate on startup',
				);
			}
		}
		logger.info({ activated }, '[app-trigger] loaded and activated app triggers');
	}

	// ─── Public bridge helpers (called from routes) ───────────────────────

	/** (Re)activate an app trigger after create/update. No-op for non-app or disabled. */
	async scheduleFromTrigger(triggerId: string): Promise<void> {
		// Clear any in-memory timers/streams but do NOT unregister the external subscription —
		// re-activation re-registers it (and the caller pre-unregisters on teardown).
		await this.clearTimers(triggerId);
		const row = await this.loadRow(triggerId);
		if (!row || row.isEnabled !== true || !row.config?.provider) return;
		// Respect a disabled attached workflow.
		if (row.workflowId) {
			const wf = await db
				.select({ isEnabled: workflows.isEnabled })
				.from(workflows)
				.where(eq(workflows.id, row.workflowId))
				.limit(1);
			if (wf[0] && wf[0].isEnabled !== true) return;
		}
		try {
			await this.activate(row);
		} catch (err) {
			logger.error({ err, triggerId }, '[app-trigger] failed to activate');
		}
	}

	/** Tear down an app trigger's listeners (poll/renewal timers, stream, external sub). */
	async unscheduleFromTrigger(triggerId: string): Promise<void> {
		await this.deactivate(triggerId);
	}

	/**
	 * Re-attempt activation/registration for one app trigger and return the resulting status.
	 * Backs the builder's "re-check registration" action. Verifies ownership; returns a
	 * friendly error (rather than throwing) when the trigger/workflow is disabled.
	 */
	async reregister(triggerId: string, ownerId: string): Promise<AppTriggerRegistrationStatus> {
		const row = await this.loadRow(triggerId);
		if (!row || row.ownerId !== ownerId) throw new Error('Trigger not found');
		if (!row.config?.provider) throw new Error('Not an app trigger');
		if (!row.isEnabled) return { error: 'Enable the workflow to register its trigger.' };
		if (row.workflowId) {
			const wf = await db
				.select({ isEnabled: workflows.isEnabled })
				.from(workflows)
				.where(eq(workflows.id, row.workflowId))
				.limit(1);
			if (wf[0] && wf[0].isEnabled !== true) {
				return { error: 'Enable the workflow to register its trigger.' };
			}
		}
		// Re-run activation — clears timers, re-registers, and persists status to state.
		await this.scheduleFromTrigger(triggerId);
		const after = await this.loadRow(triggerId);
		const state = after?.state ?? {};
		return {
			registeredAt: state.registeredAt,
			error: state.lastRegisterError,
			mode: state.registrationMode,
			verificationToken: state.verificationToken,
		};
	}

	/** Stop + best-effort unregister every app trigger using the given credential. */
	async stopByCredential(credentialId: string): Promise<void> {
		const rows = await db
			.select({ trigger: agentTriggers })
			.from(agentTriggers)
			.where(eq(agentTriggers.kind, 'app'));
		for (const row of rows) {
			const config = row.trigger.config as AppTriggerConfig;
			if (config?.credentialId === credentialId) {
				await this.deactivate(row.trigger.id);
			}
		}
	}

	/** Graceful shutdown — clear all timers + stream connections. */
	async stopAll(): Promise<void> {
		for (const timer of this.pollTimers.values()) clearInterval(timer);
		for (const timer of this.renewalTimers.values()) clearTimeout(timer);
		this.pollTimers.clear();
		this.renewalTimers.clear();
		await Promise.allSettled([...this.streamConns.values()].map((c) => c.stop()));
		this.streamConns.clear();
	}

	// ─── Inbound webhook (called from the webhook route) ──────────────────

	/**
	 * Handle an inbound webhook delivery for a kind='app' trigger. Verifies + parses via
	 * the provider, persists any state update, and fires each event through the funnel.
	 * Returns the HTTP result the route should send.
	 */
	async handleInboundWebhook(
		triggerId: string,
		req: AppWebhookRequest,
	): Promise<{ status: number; body?: unknown }> {
		const row = await this.loadRow(triggerId);
		if (!row || !row.isEnabled || row.config.provider === undefined) {
			return { status: 401, body: { success: false, error: 'Unauthorized' } };
		}
		const provider = this.registry.getById(row.config.provider);
		if (!provider || provider.deliveryMode !== 'webhook' || !provider.handleWebhook) {
			return { status: 401, body: { success: false, error: 'Unauthorized' } };
		}

		const ctx = this.buildContext(row.config.credentialId, row.ownerId);
		let result: AppWebhookHandleResult;
		try {
			result = await provider.handleWebhook(
				ctx,
				row.config.event,
				row.config.params,
				row.state,
				req,
			);
		} catch (err) {
			logger.error({ err, triggerId }, '[app-trigger] webhook handler threw');
			return { status: 500, body: { success: false, error: 'Internal error' } };
		}

		if (result.stateUpdate) {
			await this.persistState(triggerId, result.stateUpdate);
		}

		if (!result.ok) {
			logger.warn(
				{ triggerId, provider: provider.id },
				'[app-trigger] webhook verification failed',
			);
			return { status: 401, body: { success: false, error: 'Unauthorized' } };
		}

		await this.fireEvents(row, result.events);

		if (result.response) {
			return { status: result.response.status, body: result.response.body };
		}
		return { status: 202, body: { success: true, data: { received: true } } };
	}

	// ─── Activation ───────────────────────────────────────────────────────

	private async activate(row: AppTriggerRow): Promise<void> {
		const provider = this.registry.getById(row.config.provider);
		if (!provider) {
			logger.warn(
				{ triggerId: row.id, provider: row.config.provider },
				'[app-trigger] unknown provider, skipping',
			);
			return;
		}

		switch (provider.deliveryMode) {
			case 'poll':
				this.activatePoll(row, provider);
				break;
			case 'webhook':
				await this.activateWebhook(row, provider);
				break;
			case 'stream':
				await this.activateStream(row, provider);
				break;
		}
	}

	private activatePoll(row: AppTriggerRow, provider: AppTriggerProvider): void {
		if (!provider.poll) return;
		const minSec = provider.minPollIntervalSec ?? DEFAULT_POLL_INTERVAL_SEC;
		const requested = row.config.pollIntervalSec ?? minSec;
		const intervalMs = Math.max(minSec, requested) * 1000;

		const tick = (): void => {
			void this.runPoll(row.id);
		};
		const timer = setInterval(tick, intervalMs);
		this.pollTimers.set(row.id, timer);
		// Run an immediate first poll to establish the baseline cursor.
		void this.runPoll(row.id);
		logger.info(
			{ triggerId: row.id, provider: provider.id, intervalMs },
			'[app-trigger] poll activated',
		);
	}

	private async activateWebhook(row: AppTriggerRow, provider: AppTriggerProvider): Promise<void> {
		if (!provider.registerWebhook) return;
		const ctx = this.buildContext(row.config.credentialId, row.ownerId);
		const deliveryUrl = this.deliveryUrl(row.id);
		try {
			const reg = await provider.registerWebhook(
				ctx,
				row.config.event,
				row.config.params,
				deliveryUrl,
				row.state,
			);
			await this.persistState(row.id, {
				...(reg.extra ?? {}),
				subscriptionId: reg.subscriptionId,
				expiresAt: reg.expiresAt,
				registeredAt: new Date().toISOString(),
				registrationMode: reg.mode ?? 'auto',
				lastRegisterError: undefined,
			});
			this.scheduleRenewal(row.id, reg.expiresAt);
			this.failureCounts.delete(row.id);
			logger.info(
				{
					triggerId: row.id,
					provider: provider.id,
					mode: reg.mode ?? 'auto',
					expiresAt: reg.expiresAt,
				},
				'[app-trigger] webhook registered',
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Webhook registration failed';
			await this.persistState(row.id, { lastRegisterError: message }).catch(() => {});
			logger.error({ err, triggerId: row.id }, '[app-trigger] webhook registration failed');
		}
	}

	private async activateStream(row: AppTriggerRow, provider: AppTriggerProvider): Promise<void> {
		if (!provider.startListening) return;
		const ctx = this.buildContext(row.config.credentialId, row.ownerId);
		try {
			const conn = await provider.startListening(
				ctx,
				row.config.event,
				row.config.params,
				(event) => {
					void this.fireEvents(row, [event]);
				},
			);
			this.streamConns.set(row.id, conn);
			logger.info({ triggerId: row.id, provider: provider.id }, '[app-trigger] stream connected');
		} catch (err) {
			logger.error({ err, triggerId: row.id }, '[app-trigger] stream connection failed');
		}
	}

	/** Clear in-memory timers + stream connection for a trigger (no external unregister). */
	private async clearTimers(triggerId: string): Promise<void> {
		const pollTimer = this.pollTimers.get(triggerId);
		if (pollTimer) {
			clearInterval(pollTimer);
			this.pollTimers.delete(triggerId);
		}
		const renewalTimer = this.renewalTimers.get(triggerId);
		if (renewalTimer) {
			clearTimeout(renewalTimer);
			this.renewalTimers.delete(triggerId);
		}
		const conn = this.streamConns.get(triggerId);
		if (conn) {
			this.streamConns.delete(triggerId);
			await conn
				.stop()
				.catch((err) => logger.warn({ err, triggerId }, '[app-trigger] stream stop failed'));
		}
	}

	/** Full teardown — clear timers AND best-effort unregister the external subscription. */
	private async deactivate(triggerId: string): Promise<void> {
		await this.clearTimers(triggerId);

		// Best-effort external unsubscribe for webhook providers (row must still exist).
		const row = await this.loadRow(triggerId).catch(() => null);
		if (row?.config?.provider) {
			const provider = this.registry.getById(row.config.provider);
			if (provider?.deliveryMode === 'webhook' && provider.unregisterWebhook) {
				const ctx = this.buildContext(row.config.credentialId, row.ownerId);
				await provider
					.unregisterWebhook(ctx, row.config.event, row.config.params, row.state)
					.catch((err) =>
						logger.warn({ err, triggerId }, '[app-trigger] webhook unregister failed'),
					);
			}
		}
	}

	// ─── Poll + renewal execution ─────────────────────────────────────────

	private async runPoll(triggerId: string): Promise<void> {
		// Single-flight: if the previous tick's poll is still running (slow API, large batch),
		// skip this one rather than overlapping — overlap would double-list and re-fire events.
		if (this.pollsInFlight.has(triggerId)) return;
		this.pollsInFlight.add(triggerId);
		try {
			const row = await this.loadRow(triggerId).catch(() => null);
			if (!row || !row.isEnabled) return;
			const provider = this.registry.getById(row.config.provider);
			if (!provider?.poll) return;

			try {
				const ctx = this.buildContext(row.config.credentialId, row.ownerId);
				const result = await provider.poll(ctx, row.config.event, row.config.params, row.state);
				if (result.stateUpdate) {
					await this.persistState(triggerId, result.stateUpdate);
				}
				await this.fireEvents(row, result.events);
				this.failureCounts.delete(triggerId);
			} catch (err) {
				await this.recordFailure(triggerId, err);
			}
		} finally {
			this.pollsInFlight.delete(triggerId);
		}
	}

	private scheduleRenewal(triggerId: string, expiresAt: string | undefined): void {
		const existing = this.renewalTimers.get(triggerId);
		if (existing) clearTimeout(existing);
		if (!expiresAt) return;

		const expiryMs = new Date(expiresAt).getTime();
		if (Number.isNaN(expiryMs)) return;
		const delay = Math.min(
			Math.max(expiryMs - Date.now() - RENEW_LEAD_MS, 1000),
			MAX_RENEW_DELAY_MS,
		);

		const timer = setTimeout(() => {
			void this.renew(triggerId);
		}, delay);
		this.renewalTimers.set(triggerId, timer);
	}

	private async renew(triggerId: string): Promise<void> {
		const row = await this.loadRow(triggerId).catch(() => null);
		if (!row || !row.isEnabled) return;
		const provider = this.registry.getById(row.config.provider);
		if (!provider?.renewWebhook) return;

		try {
			const ctx = this.buildContext(row.config.credentialId, row.ownerId);
			const reg = await provider.renewWebhook(
				ctx,
				row.config.event,
				row.config.params,
				this.deliveryUrl(triggerId),
				row.state,
			);
			await this.persistState(triggerId, {
				...(reg.extra ?? {}),
				subscriptionId: reg.subscriptionId,
				expiresAt: reg.expiresAt,
				registeredAt: new Date().toISOString(),
				registrationMode: reg.mode ?? 'auto',
				lastRegisterError: undefined,
			});
			this.scheduleRenewal(triggerId, reg.expiresAt);
			this.failureCounts.delete(triggerId);
			logger.info({ triggerId, expiresAt: reg.expiresAt }, '[app-trigger] webhook renewed');
		} catch (err) {
			await this.recordFailure(triggerId, err);
			// Retry the renewal on the normal cap so a transient failure self-heals.
			this.scheduleRenewal(triggerId, new Date(Date.now() + RENEW_LEAD_MS + 60_000).toISOString());
		}
	}

	// ─── Helpers ──────────────────────────────────────────────────────────

	private async fireEvents(row: AppTriggerRow, events: NormalizedAppEvent[]): Promise<void> {
		for (const event of events) {
			try {
				await this.triggerService.fireAppEvent(row.id, event.payload);
			} catch (err) {
				logger.error(
					{ err, triggerId: row.id, eventId: event.id },
					'[app-trigger] failed to fire workflow for event',
				);
			}
		}
	}

	private async recordFailure(triggerId: string, err: unknown): Promise<void> {
		const failures = (this.failureCounts.get(triggerId) ?? 0) + 1;
		this.failureCounts.set(triggerId, failures);
		logger.error({ err, triggerId, consecutiveFailures: failures }, '[app-trigger] listen failed');

		if (failures >= MAX_CONSECUTIVE_FAILURES) {
			logger.error({ triggerId, failures }, '[app-trigger] auto-disabling after repeated failures');
			this.failureCounts.delete(triggerId);
			await this.deactivate(triggerId);
			await db
				.update(agentTriggers)
				.set({ isEnabled: false, updatedAt: new Date() })
				.where(eq(agentTriggers.id, triggerId))
				.catch((dbErr) =>
					logger.error({ dbErr, triggerId }, '[app-trigger] failed to persist auto-disable'),
				);
		}
	}

	private buildContext(credentialId: string, ownerId: string): AppTriggerProviderContext {
		return buildProviderContext(this.resolver, this.credentialService, credentialId, ownerId);
	}

	private deliveryUrl(triggerId: string): string {
		// External services reach the backend through the public app's /api proxy.
		const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
		return `${base}/api/v1/webhooks/${triggerId}`;
	}

	private async persistState(triggerId: string, patch: Partial<AppTriggerState>): Promise<void> {
		const rows = await db
			.select({ state: agentTriggers.state })
			.from(agentTriggers)
			.where(eq(agentTriggers.id, triggerId))
			.limit(1);
		const current = (rows[0]?.state as AppTriggerState | undefined) ?? {};
		const merged = { ...current, ...patch };
		await db
			.update(agentTriggers)
			.set({ state: merged, updatedAt: new Date() })
			.where(eq(agentTriggers.id, triggerId));
	}

	private async loadRow(triggerId: string): Promise<AppTriggerRow | null> {
		const rows = await db
			.select()
			.from(agentTriggers)
			.where(eq(agentTriggers.id, triggerId))
			.limit(1);
		return rows[0] ? this.mapRow(rows[0]) : null;
	}

	private mapRow(row: typeof agentTriggers.$inferSelect): AppTriggerRow {
		return {
			id: row.id,
			agentId: row.agentId,
			ownerId: row.ownerId,
			name: row.name,
			config: row.config as AppTriggerConfig,
			state: (row.state as AppTriggerState) ?? {},
			isEnabled: row.isEnabled,
			workflowId: row.workflowId ?? null,
		};
	}
}
