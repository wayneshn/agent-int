import {
	pgTable,
	pgEnum,
	uuid,
	text,
	integer,
	boolean,
	jsonb,
	timestamp,
	index,
} from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/** Lifecycle status of an agent thread */
export const agentThreadStatusEnum = pgEnum('agent_thread_status', [
	'idle',
	'running',
	'completed',
	'error',
]);

/**
 * How this thread was initiated.
 * 'chat' = interactive user conversation
 * 'cron' = scheduled cron trigger
 * 'webhook' = external webhook trigger
 * 'manual' = user clicked "run now"
 * 'app' = an app-trigger provider event fired (Gmail/Notion/Slack/Google Forms/…)
 * 'agent' = another agent messaged this agent (agent-to-agent delegation)
 * 'mission' = the mission scheduler woke the agent for an autonomous mission turn
 */
export const agentTriggerTypeEnum = pgEnum('agent_trigger_type', [
	'chat',
	'cron',
	'webhook',
	'manual',
	'app',
	'agent',
	'mission',
]);

/**
 * Agent threads — each thread is a single execution context for an agent.
 *
 * Threads are created in two ways:
 *   1. Interactive chat: user sends a message → thread is created for that conversation
 *   2. Trigger execution: a cron/webhook/manual trigger fires → thread created for that run
 *
 * Every thread maps to one Docker container spawn. The container exits when the
 * agent finishes its turn; the thread persists in the DB with the full message history.
 */
export const agentThreads = pgTable(
	'agent_threads',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		agentId: uuid('agent_id')
			.notNull()
			.references(() => agents.id, { onDelete: 'cascade' }),
		/** Owner of the agent — denormalized for fast ownership checks without joining agents */
		ownerId: uuid('owner_id').notNull(),
		/** Optional user-visible title for the thread */
		title: text('title'),
		/** Thread lifecycle status */
		status: agentThreadStatusEnum('status').notNull().default('idle'),
		/** How this thread was created */
		triggerType: agentTriggerTypeEnum('trigger_type').notNull().default('chat'),
		/** ID of the agent_trigger that created this thread — null for chat threads */
		triggerId: uuid('trigger_id'),
		/** Payload delivered to the agent when this thread was spawned by a trigger */
		triggerPayload: jsonb('trigger_payload'),
		/**
		 * Current context window size in tokens — updated after every LLM turn.
		 * Tracks the real context occupancy rather than a running sum of all turns.
		 * Set to usage.input from the most recent assistant message.
		 * A future context compaction feature can reduce this value independently of
		 * the total-tokens metric (which always accumulates).
		 * Null for threads created before this column was added.
		 */
		contextTokens: integer('context_tokens'),
		/**
		 * Compaction summary — a distilled, plain-text summary of the earlier part of
		 * this conversation, produced by the "compact context" feature. When present,
		 * the agent runtime is fed [this summary] + [messages after compactedAt] instead
		 * of the full history, so context-token occupancy drops. The user's visible
		 * scrollback in the UI is unaffected (soft compaction). Null when never compacted.
		 */
		contextSummary: text('context_summary'),
		/**
		 * Boundary timestamp for compaction — set to the createdAt of the newest message
		 * folded into contextSummary. The LLM-facing history includes only messages with
		 * createdAt > compactedAt (plus the summary). Null when never compacted.
		 */
		compactedAt: timestamp('compacted_at'),
		/**
		 * True when this thread was automatically created by a workflow execution
		 * (cron, webhook, or manual trigger with workflowId set).
		 * False for user-initiated chat threads.
		 * Used in the frontend to let users toggle visibility of workflow-generated threads.
		 */
		isWorkflowThread: boolean('is_workflow_thread').notNull().default(false),
		/**
		 * True when the user has pinned this thread to the top of the sidebar list.
		 * Pinned threads are sorted above unpinned ones, with time ordering preserved
		 * within each group (pinned and unpinned sorted by updatedAt DESC separately).
		 */
		isPinned: boolean('is_pinned').notNull().default(false),
		/**
		 * Agent-to-agent lineage — set only for threads created by the A2A messaging
		 * tools (triggerType = 'agent'). Null for all human/trigger/workflow threads.
		 */
		/** The agent that sent the message which spawned this thread */
		initiatorAgentId: uuid('initiator_agent_id'),
		/** The thread the initiating agent was running in when it sent the message */
		parentThreadId: uuid('parent_thread_id'),
		/**
		 * Ordered chain of agent IDs from the root human-initiated turn down to (and
		 * including) the initiator of this thread. Used server-side to enforce the
		 * delegation depth cap and detect cycles — it is derived from the parent
		 * thread's chain, never supplied by the sandbox, so it cannot be spoofed.
		 */
		delegationChain: jsonb('delegation_chain'),
		/**
		 * The mission this thread belongs to (triggerType = 'mission' wake threads).
		 * Plain uuid — no FK reference to agent_missions to avoid a circular import
		 * (agent_missions.current_thread_id already references this table). Chat
		 * messages sent to a thread carrying a missionId run with mission context
		 * and tools attached (owner steering). Null for all other threads.
		 */
		missionId: uuid('mission_id'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
	},
	(table) => [
		index('agent_threads_agent_id_idx').on(table.agentId),
		index('agent_threads_owner_id_idx').on(table.ownerId),
		index('agent_threads_trigger_id_idx').on(table.triggerId),
		index('agent_threads_initiator_agent_id_idx').on(table.initiatorAgentId),
		index('agent_threads_mission_id_idx').on(table.missionId),
	],
);
