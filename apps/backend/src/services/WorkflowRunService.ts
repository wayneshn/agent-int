import { eq, and, desc, count } from 'drizzle-orm';
import { db } from '../db/index.js';
import { workflowRuns, workflowStepLogs, workflows, agents } from '../db/schema/index.js';
import type {
	WorkflowRun,
	WorkflowStepLog,
	WorkflowRunStatus,
	WorkflowStepLogStatus,
} from '@repo/types';

// ─── Mappers ──────────────────────────────────────────────────────────────────

function rowToRun(row: typeof workflowRuns.$inferSelect): WorkflowRun {
	return {
		id: row.id,
		workflowId: row.workflowId,
		agentId: row.agentId,
		ownerId: row.ownerId,
		status: row.status as WorkflowRunStatus,
		triggerType: row.triggerType as WorkflowRun['triggerType'],
		triggerId: row.triggerId ?? undefined,
		triggerPayload: (row.triggerPayload as Record<string, unknown>) ?? undefined,
		error: row.error ?? undefined,
		isTest: row.isTest,
		startedAt: row.startedAt,
		completedAt: row.completedAt ?? undefined,
	};
}

function rowToStepLog(row: typeof workflowStepLogs.$inferSelect): WorkflowStepLog {
	return {
		id: row.id,
		runId: row.runId,
		stepId: row.stepId,
		stepIndex: row.stepIndex,
		stepName: row.stepName,
		status: row.status as WorkflowStepLogStatus,
		inputContext: (row.inputContext as Record<string, unknown>) ?? {},
		outputData: (row.outputData as Record<string, unknown>) ?? undefined,
		error: row.error ?? undefined,
		attemptNumber: row.attemptNumber,
		startedAt: row.startedAt,
		completedAt: row.completedAt ?? undefined,
	};
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Manages workflow run and step log lifecycle.
 *
 * Called from:
 *   - TriggerService: create a run when a trigger fires
 *   - Runtime internal sandbox endpoints: append step logs and complete runs
 *   - Public API routes: list runs + step logs for the UI
 */
export class WorkflowRunService {
	/**
	 * Create a new workflow run record when a trigger fires.
	 */
	async createRun(input: {
		workflowId: string;
		agentId: string;
		ownerId: string;
		triggerType: WorkflowRun['triggerType'];
		triggerId?: string;
		triggerPayload?: Record<string, unknown>;
		/** True for builder Test-mode runs — excluded from the normal runs history. */
		isTest?: boolean;
	}): Promise<WorkflowRun> {
		const now = new Date();
		const [row] = await db
			.insert(workflowRuns)
			.values({
				workflowId: input.workflowId,
				agentId: input.agentId,
				ownerId: input.ownerId,
				status: 'running',
				triggerType: input.triggerType,
				triggerId: input.triggerId ?? null,
				triggerPayload: input.triggerPayload ?? null,
				isTest: input.isTest ?? false,
				startedAt: now,
			})
			.returning();

		return rowToRun(row);
	}

	/**
	 * Create a step log row marking the start of a step attempt.
	 * Called by the sandbox via the internal endpoint before the LLM call.
	 */
	async startStepLog(input: {
		runId: string;
		stepId: string;
		stepIndex: number;
		stepName: string;
		inputContext: Record<string, unknown>;
		attemptNumber?: number;
	}): Promise<WorkflowStepLog> {
		const now = new Date();
		const [row] = await db
			.insert(workflowStepLogs)
			.values({
				runId: input.runId,
				stepId: input.stepId,
				stepIndex: input.stepIndex,
				stepName: input.stepName,
				status: 'running',
				inputContext: input.inputContext,
				attemptNumber: input.attemptNumber ?? 1,
				startedAt: now,
			})
			.returning();

		return rowToStepLog(row);
	}

	/**
	 * Update a step log on completion.
	 * Called by the sandbox after the step's LLM loop finishes.
	 */
	async completeStepLog(
		stepLogId: string,
		input: {
			status: WorkflowStepLogStatus;
			outputData?: Record<string, unknown>;
			error?: string;
		},
	): Promise<void> {
		await db
			.update(workflowStepLogs)
			.set({
				status: input.status,
				outputData: input.outputData ?? null,
				error: input.error ?? null,
				completedAt: new Date(),
			})
			.where(eq(workflowStepLogs.id, stepLogId));
	}

	/**
	 * Mark a workflow run as completed or errored.
	 * Called by the sandbox after all steps finish (or on fatal error).
	 */
	async completeRun(runId: string, status: WorkflowRunStatus, error?: string): Promise<void> {
		await db
			.update(workflowRuns)
			.set({
				status,
				error: error ?? null,
				completedAt: new Date(),
			})
			.where(eq(workflowRuns.id, runId));
	}

	/**
	 * Get a run by ID, enforcing ownership.
	 */
	async getRunById(id: string, ownerId: string): Promise<WorkflowRun | null> {
		const rows = await db
			.select()
			.from(workflowRuns)
			.where(and(eq(workflowRuns.id, id), eq(workflowRuns.ownerId, ownerId)))
			.limit(1);
		return rows[0] ? rowToRun(rows[0]) : null;
	}

	/**
	 * Get a run by ID without ownership check — for internal sandbox use.
	 * The PROXY_TOKEN already enforces agent scope.
	 */
	async getRunByIdInternal(id: string): Promise<WorkflowRun | null> {
		const rows = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
		return rows[0] ? rowToRun(rows[0]) : null;
	}

	/**
	 * List runs for a workflow with pagination.
	 */
	async listRuns(
		workflowId: string,
		ownerId: string,
		limit = 20,
		offset = 0,
	): Promise<{ runs: WorkflowRun[]; total: number }> {
		// Exclude Test-mode runs so scheduled/production history stays clean.
		const where = and(
			eq(workflowRuns.workflowId, workflowId),
			eq(workflowRuns.ownerId, ownerId),
			eq(workflowRuns.isTest, false),
		);
		const [rows, countResult] = await Promise.all([
			db
				.select()
				.from(workflowRuns)
				.where(where)
				.orderBy(desc(workflowRuns.startedAt))
				.limit(limit)
				.offset(offset),
			db.select({ total: count() }).from(workflowRuns).where(where),
		]);

		return {
			runs: rows.map(rowToRun),
			total: Number(countResult[0]?.total ?? 0),
		};
	}

	/**
	 * Get all step logs for a run, ordered by step index + attempt number.
	 */
	async getStepLogs(runId: string, ownerId: string): Promise<WorkflowStepLog[]> {
		// Verify ownership via the run record
		const run = await this.getRunById(runId, ownerId);
		if (!run) return [];

		const rows = await db
			.select()
			.from(workflowStepLogs)
			.where(eq(workflowStepLogs.runId, runId))
			.orderBy(workflowStepLogs.stepIndex, workflowStepLogs.attemptNumber);

		return rows.map(rowToStepLog);
	}

	/**
	 * Get step logs without ownership check — for internal sandbox use.
	 */
	async getStepLogsInternal(runId: string): Promise<WorkflowStepLog[]> {
		const rows = await db
			.select()
			.from(workflowStepLogs)
			.where(eq(workflowStepLogs.runId, runId))
			.orderBy(workflowStepLogs.stepIndex, workflowStepLogs.attemptNumber);

		return rows.map(rowToStepLog);
	}

	/**
	 * List recent workflow runs across all of an owner's workflows, newest-started
	 * first, with the workflow + agent names joined in. Powers the dashboard
	 * activity feed.
	 */
	async listRecentByOwner(
		ownerId: string,
		limit = 8,
	): Promise<
		Array<{
			id: string;
			workflowId: string;
			workflowName: string;
			agentId: string;
			agentName: string;
			status: WorkflowRunStatus;
			error: string | null;
			startedAt: Date;
		}>
	> {
		return (
			db
				.select({
					id: workflowRuns.id,
					workflowId: workflowRuns.workflowId,
					workflowName: workflows.name,
					agentId: workflowRuns.agentId,
					agentName: agents.name,
					status: workflowRuns.status,
					error: workflowRuns.error,
					startedAt: workflowRuns.startedAt,
				})
				.from(workflowRuns)
				.innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
				.innerJoin(agents, eq(agents.id, workflowRuns.agentId))
				// Exclude Test-mode runs from the dashboard activity feed.
				.where(and(eq(workflowRuns.ownerId, ownerId), eq(workflowRuns.isTest, false)))
				.orderBy(desc(workflowRuns.startedAt))
				.limit(limit)
		);
	}
}
