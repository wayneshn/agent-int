import { pgTable, pgEnum, uuid, text, jsonb, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { workflows } from './workflows.js';
import { agentTriggerTypeEnum } from './agentThreads.js';

/** Lifecycle status of a workflow run */
export const workflowRunStatusEnum = pgEnum('workflow_run_status', [
	'running',
	'completed',
	'error',
]);

/**
 * Workflow runs — each row represents one execution of a workflow.
 *
 * A run is created when a trigger fires and it has a workflowId set.
 * The run tracks the overall status of the execution and links back to the
 * trigger that initiated it. Individual step results are in workflow_step_logs.
 *
 * Note: agentTriggerTypeEnum reused here — 'chat' is not valid for workflows.
 * Valid triggerType values: 'cron' | 'webhook' | 'manual'
 */
export const workflowRuns = pgTable(
	'workflow_runs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		workflowId: uuid('workflow_id')
			.notNull()
			.references(() => workflows.id, { onDelete: 'cascade' }),
		agentId: uuid('agent_id')
			.notNull()
			.references(() => agents.id, { onDelete: 'cascade' }),
		/** Owner — denormalized for fast ownership checks */
		ownerId: uuid('owner_id').notNull(),
		/** Overall status of this run */
		status: workflowRunStatusEnum('status').notNull().default('running'),
		/**
		 * How this run was triggered.
		 * Reuses agentTriggerTypeEnum — valid values: 'cron' | 'webhook' | 'manual'
		 */
		triggerType: agentTriggerTypeEnum('trigger_type').notNull(),
		/** ID of the agent_trigger that fired this run */
		triggerId: uuid('trigger_id'),
		/** Payload delivered to the workflow when it was triggered */
		triggerPayload: jsonb('trigger_payload'),
		/**
		 * True when this run was started from the builder's Test mode (a real run seeded with a
		 * user-supplied/fetched payload). Excluded from the normal runs history so scheduled/
		 * production runs stay clean.
		 */
		isTest: boolean('is_test').notNull().default(false),
		/** Error message if the run failed at the workflow level */
		error: text('error'),
		/** When the run started (= when this row was created) */
		startedAt: timestamp('started_at').defaultNow().notNull(),
		/** When the run finished — null while still running */
		completedAt: timestamp('completed_at'),
	},
	(table) => [
		index('workflow_runs_workflow_id_idx').on(table.workflowId),
		index('workflow_runs_agent_id_idx').on(table.agentId),
		index('workflow_runs_owner_id_idx').on(table.ownerId),
		index('workflow_runs_trigger_id_idx').on(table.triggerId),
	],
);
