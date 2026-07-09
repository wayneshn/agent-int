import { eq, and, desc, lt, lte, sql, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
	agentMissions,
	agentMissionEvents,
	agentMissionApprovals,
	agents,
} from '../db/schema/index.js';
import type {
	AgentMission,
	DashboardApprovalItem,
	MissionApproval,
	MissionApprovalPolicy,
	MissionApprovalStatus,
	MissionBudgetSnapshot,
	MissionEvent,
	MissionEventType,
	MissionRuntimeInfo,
	MissionScheduleMode,
	MissionStatus,
	CreateMissionRequest,
	UpdateMissionRequest,
} from '@repo/types';
import { agentStreamBus } from './AgentStreamBus.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard cap on the agent-maintained plan document (bytes of UTF-16 code units) */
export const MISSION_PLAN_MAX_LENGTH = 50_000;

/** How many recent journal entries are injected into the mission prompt */
const PROMPT_RECENT_EVENTS = 10;

/** How many recently decided approvals are injected into the mission prompt */
const PROMPT_RESOLVED_DECISIONS = 5;

// ─── Mappers ──────────────────────────────────────────────────────────────────

function rowToMission(row: typeof agentMissions.$inferSelect): AgentMission {
	return {
		id: row.id,
		agentId: row.agentId,
		ownerId: row.ownerId,
		title: row.title,
		goal: row.goal,
		status: row.status as MissionStatus,
		statusReason: row.statusReason ?? undefined,
		planDocument: row.planDocument ?? undefined,
		scheduleMode: row.scheduleMode as MissionScheduleMode,
		cronExpr: row.cronExpr ?? undefined,
		timezone: row.timezone ?? undefined,
		minIntervalMinutes: row.minIntervalMinutes,
		maxIntervalMinutes: row.maxIntervalMinutes,
		nextWakeAt: row.nextWakeAt ?? undefined,
		lastWakeAt: row.lastWakeAt ?? undefined,
		consecutiveFailures: row.consecutiveFailures,
		maxCostTotal: Number(row.maxCostTotal),
		maxCostPerDay: row.maxCostPerDay !== null ? Number(row.maxCostPerDay) : undefined,
		maxTurnsPerDay: row.maxTurnsPerDay ?? undefined,
		costTotal: Number(row.costTotal),
		costToday: Number(row.costToday),
		costTodayDate: row.costTodayDate ?? undefined,
		turnsToday: row.turnsToday,
		totalTurns: row.totalTurns,
		currentThreadId: row.currentThreadId ?? undefined,
		approvalPolicy: row.approvalPolicy as MissionApprovalPolicy,
		reportChannelLinkId: row.reportChannelLinkId ?? undefined,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function rowToEvent(row: typeof agentMissionEvents.$inferSelect): MissionEvent {
	return {
		id: row.id,
		missionId: row.missionId,
		type: row.type as MissionEventType,
		title: row.title,
		body: row.body ?? undefined,
		data: (row.data as Record<string, unknown> | null) ?? undefined,
		threadId: row.threadId ?? undefined,
		createdAt: row.createdAt,
	};
}

function rowToApproval(row: typeof agentMissionApprovals.$inferSelect): MissionApproval {
	return {
		id: row.id,
		missionId: row.missionId,
		action: row.action,
		rationale: row.rationale,
		status: row.status as MissionApprovalStatus,
		decisionNote: row.decisionNote ?? undefined,
		decidedAt: row.decidedAt ?? undefined,
		createdAt: row.createdAt,
	};
}

/** 'YYYY-MM-DD' for the current instant in the given IANA timezone (UTC fallback) */
function localDateString(timezone: string | undefined, at: Date = new Date()): string {
	try {
		// en-CA formats as YYYY-MM-DD
		return new Intl.DateTimeFormat('en-CA', {
			timeZone: timezone || 'UTC',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(at);
	} catch {
		// Invalid timezone string — fall back to UTC rather than failing the mission
		return at.toISOString().slice(0, 10);
	}
}

/** Reason a mission's budget gate rejected a wake */
export type MissionBudgetRejection = 'total' | 'daily_cost' | 'daily_turns';

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Mission persistence: CRUD, the activity journal, async approvals, budget
 * accounting, and scheduling column updates. Pure DB layer — the wake loop
 * itself lives in MissionSchedulerService, and spawn/prompt integration in
 * AgentRuntimeService.
 *
 * Budget note: cost figures are USD estimates derived from the model catalog
 * pricing (MessageTokenUsage.cost.total), not billing-grade numbers. Daily
 * counters roll over lazily — readers compare `costTodayDate` against the
 * current date in the mission's timezone instead of relying on a midnight job.
 */
export class MissionService {
	// ─── CRUD ──────────────────────────────────────────────────────────────

	/** Create a mission (draft unless input.activate) after verifying agent ownership */
	async create(
		agentId: string,
		ownerId: string,
		input: CreateMissionRequest,
	): Promise<AgentMission | null> {
		const agentRows = await db
			.select({ id: agents.id })
			.from(agents)
			.where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)))
			.limit(1);
		if (!agentRows[0]) return null;

		const now = new Date();
		const activate = input.activate === true;
		const [row] = await db
			.insert(agentMissions)
			.values({
				agentId,
				ownerId,
				title: input.title,
				goal: input.goal,
				status: activate ? 'active' : 'draft',
				scheduleMode: input.scheduleMode ?? 'agent',
				cronExpr: input.cronExpr ?? null,
				timezone: input.timezone ?? null,
				minIntervalMinutes: input.minIntervalMinutes ?? 30,
				maxIntervalMinutes: input.maxIntervalMinutes ?? 1440,
				nextWakeAt: activate ? now : null,
				maxCostTotal: String(input.maxCostTotal),
				maxCostPerDay: input.maxCostPerDay !== undefined ? String(input.maxCostPerDay) : null,
				maxTurnsPerDay: input.maxTurnsPerDay ?? null,
				approvalPolicy: input.approvalPolicy ?? 'risky',
				reportChannelLinkId: input.reportChannelLinkId ?? null,
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		const mission = rowToMission(row);
		if (activate) {
			await this.appendEvent(mission.id, mission.ownerId, {
				type: 'status_changed',
				title: 'Mission activated',
			});
		}
		return mission;
	}

	async listByAgent(agentId: string, ownerId: string): Promise<AgentMission[]> {
		const rows = await db
			.select()
			.from(agentMissions)
			.where(and(eq(agentMissions.agentId, agentId), eq(agentMissions.ownerId, ownerId)))
			.orderBy(desc(agentMissions.updatedAt));
		return rows.map(rowToMission);
	}

	async getById(id: string, ownerId: string): Promise<AgentMission | null> {
		const rows = await db
			.select()
			.from(agentMissions)
			.where(and(eq(agentMissions.id, id), eq(agentMissions.ownerId, ownerId)))
			.limit(1);
		return rows[0] ? rowToMission(rows[0]) : null;
	}

	/** Get without ownership check — for the scheduler and PROXY_TOKEN-scoped routes */
	async getByIdInternal(id: string): Promise<AgentMission | null> {
		const rows = await db.select().from(agentMissions).where(eq(agentMissions.id, id)).limit(1);
		return rows[0] ? rowToMission(rows[0]) : null;
	}

	// ─── Dashboard (owner-wide) ────────────────────────────────────────────

	/** Count active missions across all of the owner's agents (home dashboard tile) */
	async countActiveByOwner(ownerId: string): Promise<number> {
		const rows = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(agentMissions)
			.where(and(eq(agentMissions.ownerId, ownerId), eq(agentMissions.status, 'active')));
		return rows[0]?.count ?? 0;
	}

	/** Pending approvals across all of the owner's missions, newest first (home dashboard) */
	async listPendingApprovalsByOwner(
		ownerId: string,
		limit: number,
	): Promise<DashboardApprovalItem[]> {
		const capped = Math.min(Math.max(limit, 1), 50);
		const rows = await db
			.select({
				approvalId: agentMissionApprovals.id,
				missionId: agentMissionApprovals.missionId,
				missionTitle: agentMissions.title,
				agentId: agentMissions.agentId,
				action: agentMissionApprovals.action,
				createdAt: agentMissionApprovals.createdAt,
			})
			.from(agentMissionApprovals)
			.innerJoin(agentMissions, eq(agentMissionApprovals.missionId, agentMissions.id))
			.where(
				and(
					eq(agentMissionApprovals.ownerId, ownerId),
					eq(agentMissionApprovals.status, 'pending'),
				),
			)
			.orderBy(desc(agentMissionApprovals.createdAt))
			.limit(capped);
		return rows;
	}

	async update(
		id: string,
		ownerId: string,
		input: UpdateMissionRequest,
	): Promise<AgentMission | null> {
		const existing = await this.getById(id, ownerId);
		if (!existing) return null;

		const updates: Partial<typeof agentMissions.$inferInsert> = { updatedAt: new Date() };
		if (input.title !== undefined) updates.title = input.title;
		if (input.goal !== undefined) updates.goal = input.goal;
		if (input.scheduleMode !== undefined) updates.scheduleMode = input.scheduleMode;
		if (input.cronExpr !== undefined) updates.cronExpr = input.cronExpr ?? null;
		if (input.timezone !== undefined) updates.timezone = input.timezone ?? null;
		if (input.minIntervalMinutes !== undefined)
			updates.minIntervalMinutes = input.minIntervalMinutes;
		if (input.maxIntervalMinutes !== undefined)
			updates.maxIntervalMinutes = input.maxIntervalMinutes;
		if (input.maxCostTotal !== undefined) updates.maxCostTotal = String(input.maxCostTotal);
		if (input.maxCostPerDay !== undefined)
			updates.maxCostPerDay = input.maxCostPerDay === null ? null : String(input.maxCostPerDay);
		if (input.maxTurnsPerDay !== undefined) updates.maxTurnsPerDay = input.maxTurnsPerDay;
		if (input.approvalPolicy !== undefined) updates.approvalPolicy = input.approvalPolicy;
		if (input.reportChannelLinkId !== undefined)
			updates.reportChannelLinkId = input.reportChannelLinkId;

		await db
			.update(agentMissions)
			.set(updates)
			.where(and(eq(agentMissions.id, id), eq(agentMissions.ownerId, ownerId)));
		return this.getById(id, ownerId);
	}

	/** Delete a mission — only allowed for terminal/inactive statuses */
	async delete(id: string, ownerId: string): Promise<boolean> {
		const existing = await this.getById(id, ownerId);
		if (!existing) return false;
		if (existing.status === 'active' || existing.status === 'paused') return false;
		const result = await db
			.delete(agentMissions)
			.where(and(eq(agentMissions.id, id), eq(agentMissions.ownerId, ownerId)));
		return (result.rowCount ?? 0) > 0;
	}

	// ─── Status transitions ────────────────────────────────────────────────

	/** Internal status setter + journal event. No ownership check — callers gate. */
	async setStatus(id: string, status: MissionStatus, reason?: string): Promise<void> {
		await db
			.update(agentMissions)
			.set({
				status,
				statusReason: reason ?? null,
				// A mission leaving 'active' must not be picked up by the sweep
				...(status !== 'active' ? { nextWakeAt: null } : {}),
				updatedAt: new Date(),
			})
			.where(eq(agentMissions.id, id));
		const mission = await this.getByIdInternal(id);
		if (mission) {
			await this.appendEvent(id, mission.ownerId, {
				type: 'status_changed',
				title: `Mission ${status}`,
				body: reason,
			});
		}
	}

	/** Activate a draft/paused mission — first wake fires on the next sweep */
	async activate(id: string, ownerId: string): Promise<AgentMission | null> {
		const existing = await this.getById(id, ownerId);
		if (!existing) return null;
		if (existing.status !== 'draft' && existing.status !== 'paused') return existing;
		await db
			.update(agentMissions)
			.set({
				status: 'active',
				statusReason: null,
				nextWakeAt: new Date(),
				consecutiveFailures: 0,
				updatedAt: new Date(),
			})
			.where(and(eq(agentMissions.id, id), eq(agentMissions.ownerId, ownerId)));
		await this.appendEvent(id, ownerId, {
			type: 'status_changed',
			title: existing.status === 'draft' ? 'Mission activated' : 'Mission resumed',
		});
		return this.getById(id, ownerId);
	}

	async pause(id: string, ownerId: string, reason?: string): Promise<AgentMission | null> {
		const existing = await this.getById(id, ownerId);
		if (!existing) return null;
		if (existing.status !== 'active') return existing;
		await this.setStatus(id, 'paused', reason);
		return this.getById(id, ownerId);
	}

	/** Owner-initiated completion */
	async complete(id: string, ownerId: string): Promise<AgentMission | null> {
		const existing = await this.getById(id, ownerId);
		if (!existing) return null;
		await this.setStatus(id, 'completed', 'completed_by_owner');
		return this.getById(id, ownerId);
	}

	/** Agent-initiated completion (mission_complete tool) */
	async completeFromAgent(id: string, summary: string): Promise<void> {
		await db
			.update(agentMissions)
			.set({
				status: 'completed',
				statusReason: 'completed_by_agent',
				nextWakeAt: null,
				updatedAt: new Date(),
			})
			.where(eq(agentMissions.id, id));
		const mission = await this.getByIdInternal(id);
		if (mission) {
			await this.appendEvent(id, mission.ownerId, {
				type: 'status_changed',
				title: 'Mission completed by the agent',
				body: summary,
			});
		}
	}

	// ─── Events (activity journal) ─────────────────────────────────────────

	async appendEvent(
		missionId: string,
		ownerId: string,
		event: {
			type: MissionEventType;
			title: string;
			body?: string;
			data?: Record<string, unknown>;
			threadId?: string;
		},
	): Promise<MissionEvent> {
		const [row] = await db
			.insert(agentMissionEvents)
			.values({
				missionId,
				ownerId,
				type: event.type,
				title: event.title,
				body: event.body ?? null,
				data: event.data ?? null,
				threadId: event.threadId ?? null,
			})
			.returning();
		const mapped = rowToEvent(row);
		// Live-notify the mission detail page. Emitted under the MISSION id (not a
		// thread id) — this is the single funnel every mission event flows through,
		// so one emit covers the whole feed. Never reaches chat/thread subscribers.
		agentStreamBus.emit(missionId, { type: 'mission_event', missionId, event: mapped });
		return mapped;
	}

	/** Paginated feed for the mission detail page (newest first) */
	async listEvents(
		missionId: string,
		ownerId: string,
		opts: { limit?: number; before?: Date } = {},
	): Promise<MissionEvent[]> {
		const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
		const conditions = [
			eq(agentMissionEvents.missionId, missionId),
			eq(agentMissionEvents.ownerId, ownerId),
		];
		if (opts.before) conditions.push(lt(agentMissionEvents.createdAt, opts.before));
		const rows = await db
			.select()
			.from(agentMissionEvents)
			.where(and(...conditions))
			.orderBy(desc(agentMissionEvents.createdAt))
			.limit(limit);
		return rows.map(rowToEvent);
	}

	/** Recent events for prompt injection — no ownership check */
	async listRecentEventsInternal(missionId: string, limit: number): Promise<MissionEvent[]> {
		const rows = await db
			.select()
			.from(agentMissionEvents)
			.where(eq(agentMissionEvents.missionId, missionId))
			.orderBy(desc(agentMissionEvents.createdAt))
			.limit(limit);
		return rows.map(rowToEvent);
	}

	// ─── Approvals ─────────────────────────────────────────────────────────

	/** Raise an async approval request (request_approval tool) */
	async createApproval(
		missionId: string,
		ownerId: string,
		input: { action: string; rationale: string },
	): Promise<MissionApproval> {
		const [row] = await db
			.insert(agentMissionApprovals)
			.values({
				missionId,
				ownerId,
				action: input.action,
				rationale: input.rationale,
				status: 'pending',
			})
			.returning();
		await this.appendEvent(missionId, ownerId, {
			type: 'approval_requested',
			title: `Approval requested: ${input.action}`,
			body: input.rationale,
			data: { approvalId: row.id },
		});
		return rowToApproval(row);
	}

	async listApprovals(missionId: string, ownerId: string): Promise<MissionApproval[]> {
		const rows = await db
			.select()
			.from(agentMissionApprovals)
			.where(
				and(
					eq(agentMissionApprovals.missionId, missionId),
					eq(agentMissionApprovals.ownerId, ownerId),
				),
			)
			.orderBy(desc(agentMissionApprovals.createdAt));
		return rows.map(rowToApproval);
	}

	/** Owner decides a pending approval. Returns null when not found / not pending. */
	async decideApproval(
		approvalId: string,
		missionId: string,
		ownerId: string,
		decision: 'approved' | 'denied',
		note?: string,
	): Promise<MissionApproval | null> {
		const rows = await db
			.update(agentMissionApprovals)
			.set({ status: decision, decisionNote: note ?? null, decidedAt: new Date() })
			.where(
				and(
					eq(agentMissionApprovals.id, approvalId),
					eq(agentMissionApprovals.missionId, missionId),
					eq(agentMissionApprovals.ownerId, ownerId),
					eq(agentMissionApprovals.status, 'pending'),
				),
			)
			.returning();
		if (!rows[0]) return null;
		const approval = rowToApproval(rows[0]);
		await this.appendEvent(missionId, ownerId, {
			type: 'approval_resolved',
			title: `Approval ${decision}: ${approval.action}`,
			body: note,
			data: { approvalId },
		});
		return approval;
	}

	// ─── Budget accounting ─────────────────────────────────────────────────

	/**
	 * Accumulate LLM cost onto the mission — one atomic UPDATE with lazy daily
	 * rollover. Called fire-and-forget from AgentLlmProxyService after each turn.
	 */
	async accumulateCost(missionId: string, costUsd: number): Promise<void> {
		if (!Number.isFinite(costUsd) || costUsd <= 0) return;
		const mission = await this.getByIdInternal(missionId);
		if (!mission) return;
		const today = localDateString(mission.timezone);
		const cost = String(costUsd);
		await db
			.update(agentMissions)
			.set({
				costTotal: sql`${agentMissions.costTotal} + ${cost}`,
				costToday: sql`CASE WHEN ${agentMissions.costTodayDate} = ${today} THEN ${agentMissions.costToday} + ${cost} ELSE ${cost} END`,
				turnsToday: sql`CASE WHEN ${agentMissions.costTodayDate} = ${today} THEN ${agentMissions.turnsToday} ELSE 0 END`,
				costTodayDate: today,
				updatedAt: new Date(),
			})
			.where(eq(agentMissions.id, missionId));
	}

	/**
	 * Pure budget check with rollover awareness — daily counters count as zero
	 * when costTodayDate is not today's local date.
	 */
	checkBudget(mission: AgentMission): { ok: boolean; reason?: MissionBudgetRejection } {
		if (mission.costTotal >= mission.maxCostTotal) return { ok: false, reason: 'total' };
		const today = localDateString(mission.timezone);
		const sameDay = mission.costTodayDate === today;
		const costToday = sameDay ? mission.costToday : 0;
		const turnsToday = sameDay ? mission.turnsToday : 0;
		if (mission.maxCostPerDay !== undefined && costToday >= mission.maxCostPerDay) {
			return { ok: false, reason: 'daily_cost' };
		}
		if (mission.maxTurnsPerDay !== undefined && turnsToday >= mission.maxTurnsPerDay) {
			return { ok: false, reason: 'daily_turns' };
		}
		return { ok: true };
	}

	budgetSnapshot(mission: AgentMission): MissionBudgetSnapshot {
		const today = localDateString(mission.timezone);
		const sameDay = mission.costTodayDate === today;
		return {
			costTotal: mission.costTotal,
			maxCostTotal: mission.maxCostTotal,
			costToday: sameDay ? mission.costToday : 0,
			maxCostPerDay: mission.maxCostPerDay,
			turnsToday: sameDay ? mission.turnsToday : 0,
			maxTurnsPerDay: mission.maxTurnsPerDay,
			totalTurns: mission.totalTurns,
		};
	}

	// ─── Wake bookkeeping ──────────────────────────────────────────────────

	/** Record the start of a wake: counters, lastWakeAt, currentThreadId */
	async recordWakeStart(missionId: string, threadId: string, timezone?: string): Promise<void> {
		const today = localDateString(timezone);
		await db
			.update(agentMissions)
			.set({
				lastWakeAt: new Date(),
				totalTurns: sql`${agentMissions.totalTurns} + 1`,
				turnsToday: sql`CASE WHEN ${agentMissions.costTodayDate} = ${today} THEN ${agentMissions.turnsToday} + 1 ELSE 1 END`,
				costToday: sql`CASE WHEN ${agentMissions.costTodayDate} = ${today} THEN ${agentMissions.costToday} ELSE '0' END`,
				costTodayDate: today,
				currentThreadId: threadId,
				updatedAt: new Date(),
			})
			.where(eq(agentMissions.id, missionId));
	}

	/**
	 * Record a wake's outcome; returns the new consecutive failure count.
	 * `cost` (estimated USD for the wake) is stored on the turn_completed event's
	 * data so the detail page can plot a per-wake cost series.
	 */
	async recordTurnResult(
		missionId: string,
		threadId: string,
		ok: boolean,
		cost?: number,
	): Promise<number> {
		if (ok) {
			await db
				.update(agentMissions)
				.set({ consecutiveFailures: 0, updatedAt: new Date() })
				.where(eq(agentMissions.id, missionId));
			const mission = await this.getByIdInternal(missionId);
			if (mission) {
				await this.appendEvent(missionId, mission.ownerId, {
					type: 'turn_completed',
					title: `Wake ${mission.totalTurns} completed`,
					threadId,
					data: {
						wakeNumber: mission.totalTurns,
						...(cost !== undefined && Number.isFinite(cost) ? { cost } : {}),
					},
				});
			}
			return 0;
		}
		const rows = await db
			.update(agentMissions)
			.set({
				consecutiveFailures: sql`${agentMissions.consecutiveFailures} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(agentMissions.id, missionId))
			.returning({
				consecutiveFailures: agentMissions.consecutiveFailures,
				ownerId: agentMissions.ownerId,
				totalTurns: agentMissions.totalTurns,
			});
		const row = rows[0];
		if (!row) return 0;
		await this.appendEvent(missionId, row.ownerId, {
			type: 'turn_failed',
			title: `Wake ${row.totalTurns} failed`,
			body: `${row.consecutiveFailures} consecutive failure(s)`,
			threadId,
		});
		return row.consecutiveFailures;
	}

	// ─── Scheduling ────────────────────────────────────────────────────────

	/**
	 * Set the next wake time. Agent-requested times ('agent' source) are clamped
	 * to [now + minInterval, now + maxInterval]; host-computed sources pass
	 * through. Returns the actual persisted time.
	 */
	async setNextWake(
		missionId: string,
		at: Date,
		source: 'agent' | 'fallback' | 'backoff' | 'cron' | 'deferred' | 'manual',
		reason?: string,
	): Promise<Date> {
		let target = at;
		if (source === 'agent') {
			const mission = await this.getByIdInternal(missionId);
			if (!mission) return at;
			const now = Date.now();
			const min = now + mission.minIntervalMinutes * 60_000;
			const max = now + mission.maxIntervalMinutes * 60_000;
			target = new Date(Math.min(Math.max(at.getTime(), min), max));
		}
		await db
			.update(agentMissions)
			.set({ nextWakeAt: target, updatedAt: new Date() })
			.where(eq(agentMissions.id, missionId));
		// Only agent-chosen schedules get a journal entry — fallback claims every wake would be noise
		if (source === 'agent' || source === 'deferred' || source === 'backoff') {
			const mission = await this.getByIdInternal(missionId);
			if (mission) {
				await this.appendEvent(missionId, mission.ownerId, {
					type: source === 'agent' ? 'wake_scheduled' : 'wake_deferred',
					title:
						source === 'agent'
							? `Next wake scheduled for ${target.toISOString()}`
							: `Wake deferred to ${target.toISOString()}`,
					body: reason,
					data: { scheduledAt: target.toISOString(), source },
				});
			}
		}
		return target;
	}

	/** Claim due active missions for the sweep (skip ids already in flight) */
	async listDueMissions(limit: number, excludeIds: string[]): Promise<AgentMission[]> {
		// Compare against a drizzle-bound JS Date, NOT SQL now(): the timestamp
		// columns are written by drizzle as naive UTC wall time, while now()
		// evaluates in the server's session timezone — mixing them makes missions
		// come due hours early/late on any non-UTC host (observed live: a +5min
		// fallback wake fired immediately on a UTC+2 server).
		const conditions = [
			eq(agentMissions.status, 'active'),
			isNotNull(agentMissions.nextWakeAt),
			lte(agentMissions.nextWakeAt, new Date()),
		];
		if (excludeIds.length > 0) {
			conditions.push(sql`NOT (${inArray(agentMissions.id, excludeIds)})`);
		}
		const rows = await db
			.select()
			.from(agentMissions)
			.where(and(...conditions))
			.orderBy(agentMissions.nextWakeAt)
			.limit(limit);
		return rows.map(rowToMission);
	}

	/** Active missions with no nextWakeAt (crash recovery) → wake now */
	async recoverStalled(): Promise<number> {
		const result = await db
			.update(agentMissions)
			.set({ nextWakeAt: new Date(), updatedAt: new Date() })
			.where(and(eq(agentMissions.status, 'active'), sql`${agentMissions.nextWakeAt} IS NULL`));
		return result.rowCount ?? 0;
	}

	// ─── Plan document ─────────────────────────────────────────────────────

	async setPlanDocument(missionId: string, plan: string): Promise<void> {
		const trimmed =
			plan.length > MISSION_PLAN_MAX_LENGTH ? plan.slice(0, MISSION_PLAN_MAX_LENGTH) : plan;
		await db
			.update(agentMissions)
			.set({ planDocument: trimmed, updatedAt: new Date() })
			.where(eq(agentMissions.id, missionId));
		const mission = await this.getByIdInternal(missionId);
		if (mission) {
			await this.appendEvent(missionId, mission.ownerId, {
				type: 'plan_updated',
				title: 'Plan document updated',
			});
		}
	}

	// ─── Runtime info builder ──────────────────────────────────────────────

	/**
	 * Assemble the MissionRuntimeInfo payload injected into AgentRuntimeConfig —
	 * everything the runtime needs to render the mission prompt section.
	 */
	async buildRuntimeInfo(mission: AgentMission): Promise<MissionRuntimeInfo> {
		const [events, approvalRows] = await Promise.all([
			this.listRecentEventsInternal(mission.id, PROMPT_RECENT_EVENTS),
			db
				.select()
				.from(agentMissionApprovals)
				.where(eq(agentMissionApprovals.missionId, mission.id))
				.orderBy(desc(agentMissionApprovals.createdAt))
				.limit(25),
		]);
		const approvals = approvalRows.map(rowToApproval);
		const pending = approvals.filter((a) => a.status === 'pending');
		const decided = approvals
			.filter((a) => (a.status === 'approved' || a.status === 'denied') && a.decidedAt)
			.sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0))
			.slice(0, PROMPT_RESOLVED_DECISIONS);

		return {
			missionId: mission.id,
			title: mission.title,
			goal: mission.goal,
			planDocument: mission.planDocument ?? null,
			budget: this.budgetSnapshot(mission),
			wakeNumber: mission.totalTurns + 1,
			lastWakeAt: mission.lastWakeAt?.toISOString(),
			minIntervalMinutes: mission.minIntervalMinutes,
			maxIntervalMinutes: mission.maxIntervalMinutes,
			approvalPolicy: mission.approvalPolicy,
			recentEvents: events.map((e) => ({
				type: e.type,
				title: e.title,
				body: e.body,
				createdAt: e.createdAt.toISOString(),
			})),
			pendingApprovals: pending.map((a) => ({
				id: a.id,
				action: a.action,
				createdAt: a.createdAt.toISOString(),
			})),
			resolvedDecisions: decided.map((a) => ({
				id: a.id,
				action: a.action,
				decision: a.status as 'approved' | 'denied',
				note: a.decisionNote,
				decidedAt: (a.decidedAt as Date).toISOString(),
			})),
		};
	}
}
