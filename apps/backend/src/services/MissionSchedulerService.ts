import { CronExpressionParser } from 'cron-parser';
import type { AgentMission } from '@repo/types';
import { MissionService } from './MissionService.js';
import { AgentRuntimeService, type MissionSpawnConfig } from './AgentRuntimeService.js';
import { AgentSessionService } from './AgentSessionService.js';
import { AgentLlmProxyService } from './AgentLlmProxyService.js';
import { OutboundDeliveryService } from './OutboundDeliveryService.js';
import { logger } from '../config/logger.js';

/**
 * Missions auto-pause after this many consecutive failed wakes — mirrors
 * MAX_CONSECUTIVE_CRON_FAILURES in TriggerService.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/** First failure-backoff step (doubles per consecutive failure, capped at maxInterval) */
const BACKOFF_BASE_MINUTES = 15;

/** Deferral when the wake was declined by the global concurrency cap */
const CONCURRENCY_DEFER_MINUTES = 2;

/**
 * Fires due missions as autonomous agent turns.
 *
 * Mechanics (single-instance, consistent with TriggerService's in-memory model):
 *   - A setInterval sweep (MISSION_SWEEP_INTERVAL_MS, default 30s) selects active
 *     missions with next_wake_at <= now — the schedule lives entirely in the DB,
 *     so restart recovery is inherent: the first sweep after boot picks up
 *     whatever is due.
 *   - Each wake immediately re-writes next_wake_at to a PROVISIONAL fallback
 *     (now + maxIntervalMinutes, or the next cron occurrence for fixed-mode
 *     missions). This is both the double-fire guard and the crash-safe fallback:
 *     if the turn dies before the agent calls schedule_next_wake, the mission
 *     still wakes at the fallback time.
 *   - Every wake runs in a FRESH thread (triggerType 'mission'); continuity comes
 *     from the mission's plan document + journal + agent memory, injected into
 *     the prompt via MissionRuntimeInfo.
 *   - Budgets gate every wake: over-total pauses the mission; over-daily defers
 *     it to the next local midnight.
 *   - Failures back off exponentially and auto-pause the mission after
 *     MAX_CONSECUTIVE_FAILURES, with an owner notification.
 */
export class MissionSchedulerService {
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	/** Missions with a wake currently in flight (spawn → turn settled) */
	private readonly inFlight = new Set<string>();

	private readonly sweepIntervalMs: number;

	/** How many due missions one sweep will wake at most */
	private readonly wakeBatchSize: number;

	/** Completion-wait ceiling: the runtime's hard timeout plus a grace minute */
	private readonly completionTimeoutMs: number;

	constructor(
		private readonly missionService: MissionService,
		private readonly runtimeService: AgentRuntimeService,
		private readonly sessionService: AgentSessionService,
		private readonly outboundDelivery: OutboundDeliveryService,
		private readonly llmProxyService: AgentLlmProxyService,
	) {
		this.sweepIntervalMs = parseInt(process.env.MISSION_SWEEP_INTERVAL_MS ?? '30000', 10);
		this.wakeBatchSize = parseInt(process.env.MISSION_WAKE_BATCH ?? '5', 10);
		this.completionTimeoutMs =
			parseInt(process.env.AGENT_RUNTIME_TIMEOUT_MS ?? '2400000', 10) + 60_000;
	}

	// ─── Lifecycle ─────────────────────────────────────────────────────────

	/** Recover missions stuck without a wake time (e.g. crash mid-wake). Call once at boot. */
	async recoverOnBoot(): Promise<void> {
		try {
			const recovered = await this.missionService.recoverStalled();
			if (recovered > 0) {
				logger.info({ recovered }, '[missions] recovered active missions with no scheduled wake');
			}
		} catch (err) {
			logger.error({ err }, '[missions] boot recovery failed');
		}
	}

	/** Start the sweep loop. Call once at server startup (after recoverOnBoot). */
	start(): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => {
			void this.sweep();
		}, this.sweepIntervalMs);
		this.sweepTimer.unref();
		logger.info({ sweepIntervalMs: this.sweepIntervalMs }, '[missions] scheduler started');
	}

	/** Stop the sweep loop. Call on graceful shutdown. */
	stop(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
	}

	/**
	 * Wake a mission immediately at the owner's request ("Run now"). Ownership is
	 * verified here; the wake itself follows the exact sweep path. Returns the
	 * wake thread id, or null when the mission is not wakeable right now.
	 */
	async wakeNow(missionId: string, ownerId: string): Promise<{ threadId: string } | null> {
		const mission = await this.missionService.getById(missionId, ownerId);
		if (!mission || mission.status !== 'active') return null;
		if (this.inFlight.has(missionId)) return null;
		const threadId = await this.wakeMission(mission, 'manual');
		return threadId ? { threadId } : null;
	}

	// ─── Sweep ─────────────────────────────────────────────────────────────

	private async sweep(): Promise<void> {
		let due: AgentMission[];
		try {
			due = await this.missionService.listDueMissions(this.wakeBatchSize, [...this.inFlight]);
		} catch (err) {
			logger.error({ err }, '[missions] sweep query failed');
			return;
		}
		for (const mission of due) {
			try {
				await this.wakeMission(mission, 'scheduled');
			} catch (err) {
				logger.error({ err, missionId: mission.id }, '[missions] wake failed unexpectedly');
				this.inFlight.delete(mission.id);
			}
		}
	}

	/**
	 * Run one wake: budget gate → provisional reschedule → fresh thread → spawn →
	 * detached completion handling. Returns the wake thread id, or null when the
	 * wake was declined (budget/deferral/spawn refusal).
	 */
	private async wakeMission(
		mission: AgentMission,
		reason: 'scheduled' | 'manual',
	): Promise<string | null> {
		if (this.inFlight.has(mission.id)) return null;
		this.inFlight.add(mission.id);
		try {
			// ── Budget gate ──────────────────────────────────────────────────────
			const budget = this.missionService.checkBudget(mission);
			if (!budget.ok) {
				await this.handleBudgetRejection(mission, budget.reason ?? 'total');
				return null;
			}

			// ── Provisional claim: fallback wake time (double-fire guard) ────────
			await this.missionService.setNextWake(mission.id, this.fallbackWakeTime(mission), 'fallback');

			// ── Fresh thread per wake ────────────────────────────────────────────
			const wakeNumber = mission.totalTurns + 1;
			const firedAt = new Date().toISOString();
			const wakePayload: Record<string, unknown> = {
				missionId: mission.id,
				wakeNumber,
				firedAt,
				reason,
			};
			const thread = await this.sessionService.createThread({
				agentId: mission.agentId,
				ownerId: mission.ownerId,
				title: `${mission.title} — wake ${wakeNumber}`,
				triggerType: 'mission',
				triggerPayload: wakePayload,
				missionId: mission.id,
			});

			await this.missionService.recordWakeStart(mission.id, thread.id, mission.timezone);
			await this.missionService.appendEvent(mission.id, mission.ownerId, {
				type: 'turn_started',
				title: `Wake ${wakeNumber} started (${reason})`,
				threadId: thread.id,
			});

			// ── Spawn (completion waiter registered FIRST so no exit is missed) ──
			// Re-load the mission AFTER recordWakeStart so the prompt's budget
			// snapshot reflects this wake's turn counters.
			const fresh = (await this.missionService.getByIdInternal(mission.id)) ?? mission;
			const missionConfig: MissionSpawnConfig = {
				missionId: mission.id,
				mission: await this.missionService.buildRuntimeInfo(fresh),
			};

			const completion = this.runtimeService.awaitThreadCompletion(
				thread.id,
				this.completionTimeoutMs,
			);

			const spawned = await this.runtimeService.spawnForThread(
				mission.agentId,
				thread.id,
				mission.ownerId,
				'mission',
				wakePayload,
				undefined,
				undefined,
				undefined,
				missionConfig,
			);

			if (!spawned) {
				// spawnForThread already marked the thread 'error' and settled waiters.
				// Concurrency-cap declines are deferred without a failure count; other
				// declines (missing model, driver failure) go through the failure path.
				this.inFlight.delete(mission.id);
				await this.missionService.setNextWake(
					mission.id,
					new Date(Date.now() + CONCURRENCY_DEFER_MINUTES * 60_000),
					'deferred',
					'Runtime could not start — retrying shortly',
				);
				await this.missionService.recordTurnResult(mission.id, thread.id, false);
				await this.maybeAutoPause(mission.id);
				return null;
			}

			// ── Detached completion handling ─────────────────────────────────────
			void completion
				.then(async (status) => {
					if (status === 'completed') {
						// Per-wake cost (estimate) for the detail-page chart — summed from the
						// wake thread's persisted messages (race-free by completion time).
						let cost: number | undefined;
						try {
							cost = await this.sessionService.sumThreadCost(thread.id);
						} catch (err) {
							logger.warn({ err, missionId: mission.id }, '[missions] failed to sum wake cost');
						}
						await this.missionService.recordTurnResult(mission.id, thread.id, true, cost);
						// Distill what the agent learned this wake into long-term memory so
						// learning compounds across wakes. Fire-and-forget; the distiller
						// no-ops when the agent has no embedding model configured.
						void this.llmProxyService
							.summarizeMissionThreadToMemory(
								mission.agentId,
								mission.ownerId,
								thread.id,
								mission.id,
							)
							.catch((err) => {
								logger.warn(
									{ err, missionId: mission.id },
									'[missions] wake memory distillation failed',
								);
							});
					} else if (status === 'error') {
						const failures = await this.missionService.recordTurnResult(
							mission.id,
							thread.id,
							false,
						);
						await this.applyFailureBackoff(mission, failures);
						await this.maybeAutoPause(mission.id);
					}
					// 'idle' = owner cancelled the turn — neither success nor failure.
				})
				.catch((err) => {
					logger.error({ err, missionId: mission.id }, '[missions] completion handling failed');
				})
				.finally(() => {
					this.inFlight.delete(mission.id);
				});

			return thread.id;
		} catch (err) {
			this.inFlight.delete(mission.id);
			throw err;
		}
	}

	// ─── Budget / failure handling ─────────────────────────────────────────

	private async handleBudgetRejection(
		mission: AgentMission,
		rejection: 'total' | 'daily_cost' | 'daily_turns',
	): Promise<void> {
		this.inFlight.delete(mission.id);
		if (rejection === 'total') {
			// Total budget exhausted — hard stop.
			await this.missionService.setStatus(mission.id, 'paused', 'budget_exhausted');
			await this.missionService.appendEvent(mission.id, mission.ownerId, {
				type: 'budget_exceeded',
				title: 'Total budget exhausted — mission paused',
				body: `Spent ~$${mission.costTotal.toFixed(4)} of the $${mission.maxCostTotal.toFixed(2)} budget.`,
			});
			await this.outboundDelivery.deliverToOwner({
				ownerId: mission.ownerId,
				agentId: mission.agentId,
				missionId: mission.id,
				type: 'mission_paused',
				title: `Mission "${mission.title}" paused — budget exhausted`,
				body: `The mission reached its total budget (~$${mission.maxCostTotal.toFixed(2)}). Raise the budget and resume to continue.`,
				linkPath: `/app/agents/${mission.agentId}/missions/${mission.id}`,
				preferredLinkId: mission.reportChannelLinkId,
			});
			return;
		}
		// Daily limits — defer to the next local midnight, no pause.
		const resumeAt = this.nextLocalMidnight(mission.timezone);
		await this.missionService.setNextWake(
			mission.id,
			resumeAt,
			'deferred',
			rejection === 'daily_cost' ? 'Daily cost limit reached' : 'Daily turn limit reached',
		);
	}

	private async applyFailureBackoff(mission: AgentMission, failures: number): Promise<void> {
		if (failures <= 0) return;
		const backoffMinutes = Math.min(
			BACKOFF_BASE_MINUTES * 2 ** (failures - 1),
			mission.maxIntervalMinutes,
		);
		await this.missionService.setNextWake(
			mission.id,
			new Date(Date.now() + backoffMinutes * 60_000),
			'backoff',
			`Retry after failure ${failures}/${MAX_CONSECUTIVE_FAILURES}`,
		);
	}

	/** Pause the mission (with owner notification) once the failure streak hits the cap */
	private async maybeAutoPause(missionId: string): Promise<void> {
		const mission = await this.missionService.getByIdInternal(missionId);
		if (!mission || mission.status !== 'active') return;
		if (mission.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return;
		await this.missionService.setStatus(missionId, 'paused', 'consecutive_failures');
		await this.outboundDelivery.deliverToOwner({
			ownerId: mission.ownerId,
			agentId: mission.agentId,
			missionId: mission.id,
			type: 'mission_paused',
			title: `Mission "${mission.title}" paused after repeated failures`,
			body: `${mission.consecutiveFailures} consecutive wakes failed. Check the mission activity feed, then resume when the cause is fixed.`,
			linkPath: `/app/agents/${mission.agentId}/missions/${mission.id}`,
			preferredLinkId: mission.reportChannelLinkId,
		});
	}

	// ─── Time helpers ──────────────────────────────────────────────────────

	/** Provisional fallback: next cron occurrence (fixed mode) or now + maxInterval */
	private fallbackWakeTime(mission: AgentMission): Date {
		if (mission.scheduleMode === 'fixed' && mission.cronExpr) {
			try {
				return CronExpressionParser.parse(mission.cronExpr, {
					tz: mission.timezone || 'UTC',
				})
					.next()
					.toDate();
			} catch (err) {
				logger.warn(
					{ err, missionId: mission.id, cronExpr: mission.cronExpr },
					'[missions] invalid cron expression — falling back to max interval',
				);
			}
		}
		return new Date(Date.now() + mission.maxIntervalMinutes * 60_000);
	}

	/**
	 * Approximate next midnight in the mission's timezone (daily budget rollover
	 * point). DST transitions can shift this by an hour — acceptable for a budget
	 * deferral.
	 */
	private nextLocalMidnight(timezone: string | undefined): Date {
		const now = new Date();
		try {
			const parts = new Intl.DateTimeFormat('en-GB', {
				timeZone: timezone || 'UTC',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
				hour12: false,
			}).formatToParts(now);
			const get = (type: string): number =>
				parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
			// en-GB renders midnight as "00" — hours are already 0-23.
			const secondsIntoDay = (get('hour') % 24) * 3600 + get('minute') * 60 + get('second');
			const remaining = 86_400 - secondsIntoDay;
			return new Date(now.getTime() + (remaining + 60) * 1000);
		} catch {
			const remaining = 86_400 - (Math.floor(now.getTime() / 1000) % 86_400);
			return new Date(now.getTime() + (remaining + 60) * 1000);
		}
	}
}
