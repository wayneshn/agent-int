import type { ApiResponse } from './api.js';

// ─── Enum mirrors (TypeScript unions matching the pgEnum / text values) ───────

export type MissionStatus = 'draft' | 'active' | 'paused' | 'completed' | 'failed';
export type MissionScheduleMode = 'agent' | 'fixed';
/**
 * How eagerly the agent should request owner approval before external actions.
 * Prompt-level policy — rendered into the mission system prompt, not server-enforced.
 */
export type MissionApprovalPolicy = 'never' | 'risky' | 'always';
export type MissionApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

/**
 * Mission activity journal entry types. Stored as plain text (not a pgEnum) so
 * new event types need no migration.
 */
export type MissionEventType =
	| 'turn_started'
	| 'turn_completed'
	| 'turn_failed'
	| 'wake_deferred'
	| 'wake_scheduled'
	| 'plan_updated'
	| 'log'
	| 'report'
	| 'budget_exceeded'
	| 'approval_requested'
	| 'approval_resolved'
	| 'status_changed';

// ─── Mission ──────────────────────────────────────────────────────────────────

/**
 * A Mission — a persistent long-term goal an agent pursues autonomously.
 * The scheduler wakes the mission on a DB-persisted schedule; each wake is one
 * ordinary sandboxed agent turn (triggerType 'mission') in a fresh thread.
 * Continuity across wakes lives in `planDocument` + mission events + agent memory.
 */
export interface AgentMission {
	id: string;
	agentId: string;
	ownerId: string;
	title: string;
	/** Long-form mission statement — what the agent is ultimately trying to achieve */
	goal: string;
	status: MissionStatus;
	/** Why the mission entered its current status (e.g. 'budget_exhausted', 'consecutive_failures') */
	statusReason?: string;
	/**
	 * Agent-maintained plan/state document — the mission's persistent working memory
	 * across wakes. Rewritten wholesale by the mission_update_plan tool.
	 */
	planDocument?: string;
	// Scheduling
	scheduleMode: MissionScheduleMode;
	/** Cron expression — only used when scheduleMode is 'fixed' */
	cronExpr?: string;
	/** IANA timezone for cron evaluation and daily budget rollover. Defaults to UTC. */
	timezone?: string;
	/** Floor for agent-requested wake intervals (minutes) */
	minIntervalMinutes: number;
	/** Ceiling for agent-requested wake intervals AND the fallback cadence (minutes) */
	maxIntervalMinutes: number;
	nextWakeAt?: Date;
	lastWakeAt?: Date;
	consecutiveFailures: number;
	// Budgets (host-enforced, hard). USD estimates derived from the model catalog.
	maxCostTotal: number;
	maxCostPerDay?: number;
	maxTurnsPerDay?: number;
	// Accumulators
	costTotal: number;
	costToday: number;
	/**
	 * 'YYYY-MM-DD' (mission timezone) the daily counters belong to. Daily
	 * counters are only meaningful when this equals today's local date — the
	 * rollover is lazy, there is no midnight job.
	 */
	costTodayDate?: string;
	turnsToday: number;
	totalTurns: number;
	/** The thread the most recent wake ran in — also the owner's steering chat target */
	currentThreadId?: string;
	approvalPolicy: MissionApprovalPolicy;
	/** Channel link used for proactive report delivery (falls back to any verified link) */
	reportChannelLinkId?: string;
	createdAt: Date;
	updatedAt: Date;
}

/** One entry in a mission's activity journal (powers the mission detail feed) */
export interface MissionEvent {
	id: string;
	missionId: string;
	type: MissionEventType;
	title: string;
	body?: string;
	data?: Record<string, unknown>;
	/** The wake thread this event belongs to, when applicable */
	threadId?: string;
	createdAt: Date;
}

/** An async approval request raised by the agent via the request_approval tool */
export interface MissionApproval {
	id: string;
	missionId: string;
	/** What the agent wants to do (short imperative description) */
	action: string;
	/** Why the agent believes the action serves the mission */
	rationale: string;
	status: MissionApprovalStatus;
	/** Optional note the owner attached to the decision */
	decisionNote?: string;
	decidedAt?: Date;
	createdAt: Date;
}

/** Point-in-time budget usage vs limits — rendered in the UI and the mission prompt */
export interface MissionBudgetSnapshot {
	costTotal: number;
	maxCostTotal: number;
	costToday: number;
	maxCostPerDay?: number;
	turnsToday: number;
	maxTurnsPerDay?: number;
	totalTurns: number;
}

// ─── Owner-facing request bodies ──────────────────────────────────────────────

/** POST /v1/agents/:agentId/missions */
export interface CreateMissionRequest {
	title: string;
	goal: string;
	scheduleMode?: MissionScheduleMode;
	cronExpr?: string;
	timezone?: string;
	minIntervalMinutes?: number;
	maxIntervalMinutes?: number;
	maxCostTotal: number;
	maxCostPerDay?: number;
	maxTurnsPerDay?: number;
	approvalPolicy?: MissionApprovalPolicy;
	reportChannelLinkId?: string;
	/** When true the mission starts active (first wake ~immediately) instead of draft */
	activate?: boolean;
}

/** PUT /v1/agents/:agentId/missions/:missionId */
export interface UpdateMissionRequest {
	title?: string;
	goal?: string;
	scheduleMode?: MissionScheduleMode;
	cronExpr?: string;
	timezone?: string;
	minIntervalMinutes?: number;
	maxIntervalMinutes?: number;
	maxCostTotal?: number;
	maxCostPerDay?: number | null;
	maxTurnsPerDay?: number | null;
	approvalPolicy?: MissionApprovalPolicy;
	reportChannelLinkId?: string | null;
}

/** POST /v1/agents/:agentId/missions/:missionId/approvals/:approvalId */
export interface DecideMissionApprovalRequest {
	decision: 'approved' | 'denied';
	note?: string;
}

// ─── Mission management (agent-facing, chat turns) ────────────────────────────

/**
 * Control actions an agent can take on one of its missions from a chat turn
 * (via the control_mission tool). 'activate' covers draft→active and paused→active.
 */
export type MissionControlAction = 'activate' | 'pause' | 'complete' | 'wake';

/** POST /v1/runtime/internal/missions/:missionId/control */
export interface MissionControlRequest {
	action: MissionControlAction;
}

// ─── Runtime config payload (injected into AgentRuntimeConfig.mission) ────────

/**
 * Everything the agent-runtime needs to render the mission prompt section and
 * gate the mission tools. Built host-side by the scheduler (wakes) or the spawn
 * path (owner steering chat on a mission thread). No secrets.
 */
export interface MissionRuntimeInfo {
	missionId: string;
	title: string;
	goal: string;
	planDocument: string | null;
	budget: MissionBudgetSnapshot;
	/** 1-based wake counter (totalTurns at spawn time) */
	wakeNumber: number;
	/** ISO datetime of the previous wake, when there was one */
	lastWakeAt?: string;
	minIntervalMinutes: number;
	maxIntervalMinutes: number;
	approvalPolicy: MissionApprovalPolicy;
	/** Most recent journal entries (newest first, capped) for prompt context */
	recentEvents: Array<{ type: MissionEventType; title: string; body?: string; createdAt: string }>;
	/** Approvals still awaiting the owner's decision */
	pendingApprovals: Array<{ id: string; action: string; createdAt: string }>;
	/** Recently decided approvals the agent should act on */
	resolvedDecisions: Array<{
		id: string;
		action: string;
		decision: 'approved' | 'denied';
		note?: string;
		decidedAt: string;
	}>;
}

// ─── Internal (sandbox → host) request/response bodies ────────────────────────

/** POST /v1/runtime/internal/mission/plan */
export interface MissionPlanUpdateRequest {
	plan: string;
}

/** POST /v1/runtime/internal/mission/log */
export interface MissionLogRequest {
	title: string;
	body?: string;
	data?: Record<string, unknown>;
}

/** POST /v1/runtime/internal/mission/schedule */
export interface MissionScheduleWakeRequest {
	/** ISO 8601 datetime for the next wake — mutually exclusive with delayMinutes */
	at?: string;
	/** Delay from now in minutes — mutually exclusive with at */
	delayMinutes?: number;
	/** Short reason shown in the activity feed */
	reason?: string;
}

/** Result of the schedule call — the host-clamped actual wake time */
export interface MissionScheduleWakeResult {
	scheduledAt: string;
}

/** POST /v1/runtime/internal/mission/complete */
export interface MissionCompleteRequest {
	summary: string;
}

/** POST /v1/runtime/internal/mission/report */
export interface MissionReportRequest {
	title: string;
	message: string;
}

/** POST /v1/runtime/internal/mission/approval */
export interface MissionApprovalCreateRequest {
	action: string;
	rationale: string;
}

/** Result of raising an approval request */
export interface MissionApprovalCreateResult {
	approvalId: string;
}

// ─── Dashboard (owner-wide mission aggregation) ───────────────────────────────

/** One pending approval surfaced on the home dashboard, with enough context to deep-link */
export interface DashboardApprovalItem {
	approvalId: string;
	missionId: string;
	missionTitle: string;
	agentId: string;
	action: string;
	createdAt: Date;
}

/** Owner-wide mission summary for the home dashboard */
export interface DashboardMissionsSummary {
	activeCount: number;
	pendingApprovals: DashboardApprovalItem[];
}

// ─── API Response Envelopes ───────────────────────────────────────────────────

export type MissionResponse = ApiResponse<AgentMission>;
export type MissionsListResponse = ApiResponse<AgentMission[]>;
export type MissionDeleteResponse = ApiResponse<{ deleted: boolean }>;
export type MissionEventsResponse = ApiResponse<MissionEvent[]>;
export type MissionApprovalsResponse = ApiResponse<MissionApproval[]>;
export type MissionWakeResponse = ApiResponse<{ threadId: string }>;
export type DashboardMissionsResponse = ApiResponse<DashboardMissionsSummary>;
