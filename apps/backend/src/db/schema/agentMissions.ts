import {
	pgTable,
	pgEnum,
	uuid,
	varchar,
	text,
	integer,
	numeric,
	jsonb,
	timestamp,
	index,
} from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { agentThreads } from './agentThreads.js';
import { channelLinks } from './channelLinks.js';

/** Lifecycle status of a mission */
export const agentMissionStatusEnum = pgEnum('agent_mission_status', [
	'draft',
	'active',
	'paused',
	'completed',
	'failed',
]);

/**
 * How the mission's wakes are scheduled.
 * 'agent' — the agent picks its own next wake via schedule_next_wake (clamped to
 *           min/max interval); maxIntervalMinutes doubles as the fallback cadence.
 * 'fixed' — wakes follow cronExpr; agent-requested wakes are ignored.
 */
export const missionScheduleModeEnum = pgEnum('mission_schedule_mode', ['agent', 'fixed']);

/**
 * Agent missions — persistent long-term goals an agent pursues autonomously.
 *
 * The mission scheduler (MissionSchedulerService) sweeps `next_wake_at` and fires
 * each due mission as one ordinary sandboxed agent turn (triggerType 'mission')
 * in a FRESH thread per wake. Continuity across wakes lives in `plan_document`
 * (agent-rewritten via the mission_update_plan tool), the mission event journal,
 * and agent memory — never in an ever-growing thread.
 *
 * Budgets are hard and host-enforced: cost accumulates from LLM usage in
 * AgentLlmProxyService; the scheduler pauses (total) or defers (daily) at the
 * limits, and the LLM proxy rejects mid-turn at >105% of the total budget.
 */
export const agentMissions = pgTable(
	'agent_missions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		agentId: uuid('agent_id')
			.notNull()
			.references(() => agents.id, { onDelete: 'cascade' }),
		/** Owner of the agent — denormalized for fast ownership checks */
		ownerId: uuid('owner_id').notNull(),
		title: varchar('title', { length: 255 }).notNull(),
		/** Long-form mission statement — what the agent is ultimately trying to achieve */
		goal: text('goal').notNull(),
		status: agentMissionStatusEnum('status').notNull().default('draft'),
		/** Why the mission entered its current status (e.g. 'budget_exhausted') */
		statusReason: text('status_reason'),
		/**
		 * Agent-maintained plan/state document — the mission's persistent working
		 * memory across wakes. Rewritten wholesale by the mission_update_plan tool
		 * (capped at 50KB in the internal route).
		 */
		planDocument: text('plan_document'),
		// ── Scheduling ────────────────────────────────────────────────────────────
		scheduleMode: missionScheduleModeEnum('schedule_mode').notNull().default('agent'),
		/** Cron expression — only used when scheduleMode = 'fixed' */
		cronExpr: text('cron_expr'),
		/** IANA timezone for cron evaluation and daily budget rollover (null = UTC) */
		timezone: text('timezone'),
		/** Floor for agent-requested wake intervals (minutes) */
		minIntervalMinutes: integer('min_interval_minutes').notNull().default(30),
		/** Ceiling for agent-requested intervals AND the fallback cadence (minutes) */
		maxIntervalMinutes: integer('max_interval_minutes').notNull().default(1440),
		/**
		 * The scheduler's work queue: the sweep fires active missions whose
		 * next_wake_at is due. Updated provisionally to now+maxInterval at wake
		 * start (double-fire guard + crash-safe fallback), then overwritten when
		 * the agent calls schedule_next_wake.
		 */
		nextWakeAt: timestamp('next_wake_at'),
		lastWakeAt: timestamp('last_wake_at'),
		consecutiveFailures: integer('consecutive_failures').notNull().default(0),
		// ── Budgets (hard, host-enforced; USD estimates from the model catalog) ───
		maxCostTotal: numeric('max_cost_total', { precision: 12, scale: 6 }).notNull(),
		maxCostPerDay: numeric('max_cost_per_day', { precision: 12, scale: 6 }),
		maxTurnsPerDay: integer('max_turns_per_day'),
		// ── Accumulators (AgentLlmProxyService + scheduler) ───────────────────────
		costTotal: numeric('cost_total', { precision: 12, scale: 6 }).notNull().default('0'),
		costToday: numeric('cost_today', { precision: 12, scale: 6 }).notNull().default('0'),
		/**
		 * 'YYYY-MM-DD' in the mission timezone for which costToday/turnsToday are
		 * counted. Lazy rollover: readers/writers reset the daily counters when the
		 * current local date differs.
		 */
		costTodayDate: text('cost_today_date'),
		turnsToday: integer('turns_today').notNull().default(0),
		totalTurns: integer('total_turns').notNull().default(0),
		// ── Threads ───────────────────────────────────────────────────────────────
		/** The thread the most recent wake ran in — also the owner's steering chat target */
		currentThreadId: uuid('current_thread_id').references(() => agentThreads.id, {
			onDelete: 'set null',
		}),
		// ── Reporting / approvals ─────────────────────────────────────────────────
		/** Prompt-level approval eagerness: 'never' | 'risky' | 'always' */
		approvalPolicy: text('approval_policy').notNull().default('risky'),
		/** Preferred channel link for proactive report delivery (null = any verified link) */
		reportChannelLinkId: uuid('report_channel_link_id').references(() => channelLinks.id, {
			onDelete: 'set null',
		}),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
	},
	(table) => [
		index('agent_missions_agent_id_idx').on(table.agentId),
		index('agent_missions_owner_id_idx').on(table.ownerId),
		index('agent_missions_status_next_wake_idx').on(table.status, table.nextWakeAt),
	],
);

/**
 * Mission activity journal — the owner-facing feed of what the mission did and
 * why (turn outcomes, plan updates, logs, reports, budget/approval events).
 * `type` is plain text (not a pgEnum) so new event types need no migration.
 */
export const agentMissionEvents = pgTable(
	'agent_mission_events',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		missionId: uuid('mission_id')
			.notNull()
			.references(() => agentMissions.id, { onDelete: 'cascade' }),
		/** Denormalized for ownership checks without joining missions */
		ownerId: uuid('owner_id').notNull(),
		/** MissionEventType — plain text, see @repo/types */
		type: text('type').notNull(),
		title: text('title').notNull(),
		body: text('body'),
		/** Structured extras (e.g. scheduled wake time, cost figures) */
		data: jsonb('data'),
		/** The wake thread this event belongs to, when applicable */
		threadId: uuid('thread_id'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		index('agent_mission_events_mission_created_idx').on(table.missionId, table.createdAt),
	],
);

/**
 * Async approval requests raised by the agent (request_approval tool). Unlike
 * the blocking ask_human HITL, the mission turn ends after raising one; the
 * owner decides in the UI and the decision is injected into a later wake's
 * prompt. `status` is plain text: 'pending' | 'approved' | 'denied' | 'expired'.
 */
export const agentMissionApprovals = pgTable(
	'agent_mission_approvals',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		missionId: uuid('mission_id')
			.notNull()
			.references(() => agentMissions.id, { onDelete: 'cascade' }),
		/** Denormalized for ownership checks */
		ownerId: uuid('owner_id').notNull(),
		/** What the agent wants to do (short imperative description) */
		action: text('action').notNull(),
		/** Why the agent believes the action serves the mission */
		rationale: text('rationale').notNull(),
		status: text('status').notNull().default('pending'),
		/** Optional note the owner attached to the decision */
		decisionNote: text('decision_note'),
		decidedAt: timestamp('decided_at'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		index('agent_mission_approvals_mission_status_idx').on(table.missionId, table.status),
	],
);
