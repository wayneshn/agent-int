import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { agentThreads, agentMessages, agents } from '../db/schema/index.js';
import type {
	AgentThread,
	AgentMessage,
	AgentMessageRole,
	AgentThreadStatus,
	AgentTriggerType,
	AgentRunSummary,
	ContentBlock,
	MessageTokenUsage,
} from '@repo/types';

// ─── Input Types ──────────────────────────────────────────────────────────────

export interface CreateThreadInput {
	agentId: string;
	ownerId: string;
	title?: string;
	triggerType?: AgentTriggerType;
	triggerId?: string;
	triggerPayload?: Record<string, unknown>;
	/** Mark this thread as created by a workflow execution (non-chat trigger with workflowId) */
	isWorkflowThread?: boolean;
	/** A2A lineage — the agent that sent the message that spawned this thread (triggerType 'agent') */
	initiatorAgentId?: string;
	/** A2A lineage — the initiating agent's thread */
	parentThreadId?: string;
	/** A2A lineage — server-derived delegation chain (root → initiator) for depth/cycle checks */
	delegationChain?: string[];
	/** The mission this thread belongs to (mission wake threads) */
	missionId?: string;
}

export interface AppendMessageInput {
	threadId: string;
	role: AgentMessageRole;
	content: ContentBlock[];
	toolCallId?: string;
	toolName?: string;
	tokenUsage?: MessageTokenUsage;
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function rowToThread(row: typeof agentThreads.$inferSelect): AgentThread {
	return {
		id: row.id,
		agentId: row.agentId,
		ownerId: row.ownerId,
		title: row.title ?? undefined,
		status: row.status as AgentThreadStatus,
		triggerType: row.triggerType as AgentTriggerType,
		triggerId: row.triggerId ?? undefined,
		triggerPayload: (row.triggerPayload as Record<string, unknown>) ?? undefined,
		contextTokens: row.contextTokens ?? undefined,
		isWorkflowThread: row.isWorkflowThread,
		isPinned: row.isPinned,
		initiatorAgentId: row.initiatorAgentId ?? undefined,
		parentThreadId: row.parentThreadId ?? undefined,
		delegationChain: (row.delegationChain as string[] | null) ?? undefined,
		missionId: row.missionId ?? undefined,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function rowToMessage(row: typeof agentMessages.$inferSelect): AgentMessage {
	return {
		id: row.id,
		threadId: row.threadId,
		role: row.role as AgentMessageRole,
		content: row.content as ContentBlock[],
		toolCallId: row.toolCallId ?? undefined,
		toolName: row.toolName ?? undefined,
		tokenUsage: (row.tokenUsage as MessageTokenUsage) ?? undefined,
		createdAt: row.createdAt,
	};
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Service for agent thread and message persistence.
 * Ownership is enforced at the DB layer — all queries include ownerId in WHERE.
 */
export class AgentSessionService {
	// ─── Thread Operations ─────────────────────────────────────────────────

	/** Create a new thread for an agent */
	async createThread(input: CreateThreadInput): Promise<AgentThread> {
		const now = new Date();
		const [row] = await db
			.insert(agentThreads)
			.values({
				agentId: input.agentId,
				ownerId: input.ownerId,
				title: input.title ?? null,
				status: 'idle',
				triggerType: input.triggerType ?? 'chat',
				triggerId: input.triggerId ?? null,
				triggerPayload: input.triggerPayload ?? null,
				isWorkflowThread: input.isWorkflowThread ?? false,
				initiatorAgentId: input.initiatorAgentId ?? null,
				parentThreadId: input.parentThreadId ?? null,
				delegationChain: input.delegationChain ?? null,
				missionId: input.missionId ?? null,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		return rowToThread(row);
	}

	/** Get a single thread by ID with ownership check */
	async getThreadById(id: string, ownerId: string): Promise<AgentThread | null> {
		const rows = await db
			.select()
			.from(agentThreads)
			.where(and(eq(agentThreads.id, id), eq(agentThreads.ownerId, ownerId)))
			.limit(1);
		return rows[0] ? rowToThread(rows[0]) : null;
	}

	/**
	 * Get a thread by ID without ownership check.
	 * Used internally by the runtime (ownership already verified via PROXY_TOKEN).
	 */
	async getThreadByIdInternal(id: string): Promise<AgentThread | null> {
		const rows = await db.select().from(agentThreads).where(eq(agentThreads.id, id)).limit(1);
		return rows[0] ? rowToThread(rows[0]) : null;
	}

	/**
	 * Find the existing agent-to-agent delegation thread for (caller thread → target
	 * agent), newest first. Used so follow-up messages from the same caller turn/thread
	 * continue in the SAME target conversation — the target keeps its context instead
	 * of starting cold each time. No ownership check — internal use only (the A2A
	 * authorization runs in AgentMessagingService before this is called).
	 */
	async findDelegationThread(
		targetAgentId: string,
		callerThreadId: string,
		callerAgentId: string,
	): Promise<AgentThread | null> {
		const rows = await db
			.select()
			.from(agentThreads)
			.where(
				and(
					eq(agentThreads.agentId, targetAgentId),
					eq(agentThreads.parentThreadId, callerThreadId),
					eq(agentThreads.initiatorAgentId, callerAgentId),
				),
			)
			.orderBy(desc(agentThreads.createdAt))
			.limit(1);
		return rows[0] ? rowToThread(rows[0]) : null;
	}

	/** List all threads for an agent, ordered newest first */
	async listThreads(agentId: string, ownerId: string): Promise<AgentThread[]> {
		// Verify agent ownership first
		const agentRows = await db
			.select({ id: agents.id })
			.from(agents)
			.where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)))
			.limit(1);
		if (!agentRows[0]) return [];

		const rows = await db
			.select()
			.from(agentThreads)
			.where(and(eq(agentThreads.agentId, agentId), eq(agentThreads.ownerId, ownerId)))
			.orderBy(desc(agentThreads.createdAt));
		return rows.map(rowToThread);
	}

	/**
	 * List recent interactive chat threads across all of an owner's agents,
	 * newest-updated first, with the agent name joined in. Workflow-generated
	 * threads are excluded (they surface via the workflow run feed instead).
	 * Powers the dashboard activity feed.
	 */
	async listRecentChatThreadsByOwner(
		ownerId: string,
		limit = 8,
	): Promise<
		Array<{
			id: string;
			agentId: string;
			agentName: string;
			title: string | null;
			status: AgentThreadStatus;
			updatedAt: Date;
		}>
	> {
		return db
			.select({
				id: agentThreads.id,
				agentId: agentThreads.agentId,
				agentName: agents.name,
				title: agentThreads.title,
				status: agentThreads.status,
				updatedAt: agentThreads.updatedAt,
			})
			.from(agentThreads)
			.innerJoin(agents, eq(agents.id, agentThreads.agentId))
			.where(and(eq(agentThreads.ownerId, ownerId), eq(agentThreads.isWorkflowThread, false)))
			.orderBy(desc(agentThreads.updatedAt))
			.limit(limit);
	}

	/**
	 * Returns the most recently created thread for an agent, excluding the given threadId.
	 * Used by the auto-summarize feature to find the previous thread when a new one is created.
	 * No ownership check beyond the ownerId filter — internal use only.
	 */
	async getLastThreadBeforeId(
		agentId: string,
		ownerId: string,
		excludeThreadId: string,
	): Promise<AgentThread | null> {
		const rows = await db
			.select()
			.from(agentThreads)
			.where(
				and(
					eq(agentThreads.agentId, agentId),
					eq(agentThreads.ownerId, ownerId),
					sql`${agentThreads.id} != ${excludeThreadId}`,
				),
			)
			.orderBy(desc(agentThreads.createdAt))
			.limit(1);
		return rows[0] ? rowToThread(rows[0]) : null;
	}

	/** Update thread status */
	async updateThreadStatus(id: string, status: AgentThreadStatus): Promise<void> {
		await db
			.update(agentThreads)
			.set({ status, updatedAt: new Date() })
			.where(eq(agentThreads.id, id));
	}

	/** Update thread title */
	async updateThreadTitle(id: string, ownerId: string, title: string): Promise<void> {
		await db
			.update(agentThreads)
			.set({ title, updatedAt: new Date() })
			.where(and(eq(agentThreads.id, id), eq(agentThreads.ownerId, ownerId)));
	}

	/**
	 * Accumulate context window tokens for a thread.
	 * Called after every LLM turn with (usage.input + usage.output).
	 * Both input and output tokens grow the context because output tokens from
	 * this turn become input context on the next turn.
	 * Uses SQL addition so concurrent updates are safe (no read-modify-write race).
	 * A future compaction feature can reset/reduce this value via updateThreadContextTokens().
	 * No ownership check — internal use only (called by AgentLlmProxyService).
	 */
	async accumulateThreadContextTokens(id: string, tokensToAdd: number): Promise<void> {
		await db
			.update(agentThreads)
			.set({
				contextTokens: sql`COALESCE(${agentThreads.contextTokens}, 0) + ${tokensToAdd}`,
				updatedAt: new Date(),
			})
			.where(eq(agentThreads.id, id));
	}

	/**
	 * Sum the estimated USD cost across a thread's assistant messages
	 * (tokenUsage.cost.total). Used to record per-wake cost for a mission after the
	 * wake completes. Race-free: assistant messages are persisted before the wake
	 * process exits. Returns 0 when the thread has no priced messages.
	 */
	async sumThreadCost(threadId: string): Promise<number> {
		const rows = await db
			.select({
				total: sql<number>`COALESCE(SUM((${agentMessages.tokenUsage} -> 'cost' ->> 'total')::numeric), 0)::float8`,
			})
			.from(agentMessages)
			.where(eq(agentMessages.threadId, threadId));
		return Number(rows[0]?.total ?? 0);
	}

	/**
	 * Directly set the context window token count for a thread.
	 * Used by a future compaction feature to reset the context to a smaller value.
	 * No ownership check — internal use only.
	 */
	async updateThreadContextTokens(id: string, contextTokens: number): Promise<void> {
		await db
			.update(agentThreads)
			.set({ contextTokens, updatedAt: new Date() })
			.where(eq(agentThreads.id, id));
	}

	/**
	 * Set or clear the pinned flag for a thread (ownership enforced).
	 * Returns the updated thread, or null if the thread was not found.
	 */
	async pinThread(id: string, ownerId: string, isPinned: boolean): Promise<AgentThread | null> {
		const rows = await db
			.update(agentThreads)
			.set({ isPinned, updatedAt: new Date() })
			.where(and(eq(agentThreads.id, id), eq(agentThreads.ownerId, ownerId)))
			.returning();
		return rows[0] ? rowToThread(rows[0]) : null;
	}

	/** Delete a thread and all its messages (ownership enforced) */
	async deleteThread(id: string, ownerId: string): Promise<boolean> {
		const rows = await db
			.delete(agentThreads)
			.where(and(eq(agentThreads.id, id), eq(agentThreads.ownerId, ownerId)))
			.returning({ id: agentThreads.id });
		return rows.length > 0;
	}

	// ─── Message Operations ────────────────────────────────────────────────

	/** Append a message to a thread */
	async appendMessage(input: AppendMessageInput): Promise<AgentMessage> {
		const [row] = await db
			.insert(agentMessages)
			.values({
				threadId: input.threadId,
				role: input.role,
				content: input.content,
				toolCallId: input.toolCallId ?? null,
				toolName: input.toolName ?? null,
				tokenUsage: input.tokenUsage ?? null,
				createdAt: new Date(),
			})
			.returning();
		return rowToMessage(row);
	}

	/**
	 * Delete a single message by id — no ownership check, internal use only. Used to
	 * roll back an A2A delivery whose target run never started (declined/failed
	 * spawn), so the undelivered message is not re-processed by a later run.
	 */
	async deleteMessageInternal(messageId: string): Promise<void> {
		await db.delete(agentMessages).where(eq(agentMessages.id, messageId));
	}

	/** List all messages for a thread, ordered by creation time (oldest first) */
	async listMessages(threadId: string, ownerId: string): Promise<AgentMessage[]> {
		// Verify thread ownership
		const thread = await this.getThreadById(threadId, ownerId);
		if (!thread) return [];

		const rows = await db
			.select()
			.from(agentMessages)
			.where(eq(agentMessages.threadId, threadId))
			.orderBy(agentMessages.createdAt);
		return rows.map(rowToMessage);
	}

	/**
	 * List messages without ownership check — used internally by the runtime.
	 * Ownership is verified at the PROXY_TOKEN level.
	 */
	async listMessagesInternal(threadId: string): Promise<AgentMessage[]> {
		const rows = await db
			.select()
			.from(agentMessages)
			.where(eq(agentMessages.threadId, threadId))
			.orderBy(agentMessages.createdAt);
		return rows.map(rowToMessage);
	}

	/**
	 * Return the id of the most recently created message in a thread, optionally
	 * filtered by role, or null if none. Used to link an agent-shared file to the
	 * assistant message the agent was producing when it called share_file —
	 * filtering by role avoids linking to a tool_result from an earlier tool in the
	 * same assistant turn (which the chat UI does not render). No ownership check —
	 * callers (the sandbox share endpoint) are already scoped by PROXY_TOKEN.
	 */
	async getLatestMessageId(threadId: string, role?: AgentMessageRole): Promise<string | null> {
		const rows = await db
			.select({ id: agentMessages.id })
			.from(agentMessages)
			.where(
				role
					? and(eq(agentMessages.threadId, threadId), eq(agentMessages.role, role))
					: eq(agentMessages.threadId, threadId),
			)
			.orderBy(desc(agentMessages.createdAt))
			.limit(1);
		return rows[0]?.id ?? null;
	}

	// ─── Observability ────────────────────────────────────────────────────

	/**
	 * List aggregated run summaries for an agent (newest first).
	 *
	 * Aggregates token usage and cost from agent_messages.token_usage JSONB column.
	 * The token_usage shape is { input: number, output: number, cost: { total: number } }.
	 * Uses raw SQL for JSONB numeric extraction since Drizzle doesn't have built-in helpers.
	 *
	 * Ownership is verified by requiring ownerId on agent_threads (denormalized).
	 */
	async listRuns(
		agentId: string,
		ownerId: string,
		limit = 50,
		offset = 0,
	): Promise<AgentRunSummary[]> {
		// First verify agent ownership
		const agentRows = await db
			.select({ id: agents.id })
			.from(agents)
			.where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)))
			.limit(1);
		if (!agentRows[0]) return [];

		// Fetch all threads for this agent owned by this user, ordered newest first
		const threads = await db
			.select()
			.from(agentThreads)
			.where(and(eq(agentThreads.agentId, agentId), eq(agentThreads.ownerId, ownerId)))
			.orderBy(desc(agentThreads.createdAt))
			.limit(limit)
			.offset(offset);

		if (threads.length === 0) return [];

		const threadIds = threads.map((t) => t.id);

		// Aggregate message stats per thread in one query using raw SQL for JSONB extraction.
		// Columns returned:
		//   thread_id, message_count, tool_call_count,
		//   total_input_tokens, total_output_tokens, total_cost, last_input_tokens
		const statsRows = await db.execute(sql`
			SELECT
				m.thread_id,
				COUNT(*)::int                                                            AS message_count,
				COUNT(*) FILTER (WHERE m.role = 'tool_result')::int                    AS tool_call_count,
				COALESCE(SUM(
					CASE WHEN m.role = 'assistant' AND m.token_usage IS NOT NULL
					THEN (m.token_usage->>'input')::numeric ELSE 0 END
				), 0)::float8                                                           AS total_input_tokens,
				COALESCE(SUM(
					CASE WHEN m.role = 'assistant' AND m.token_usage IS NOT NULL
					THEN (m.token_usage->>'output')::numeric ELSE 0 END
				), 0)::float8                                                           AS total_output_tokens,
				COALESCE(SUM(
					CASE WHEN m.role = 'assistant' AND m.token_usage IS NOT NULL
					THEN (m.token_usage->'cost'->>'total')::numeric ELSE 0 END
				), 0)::float8                                                           AS total_cost,
				COALESCE((
					SELECT (sub.token_usage->>'input')::float8
					FROM agent_messages sub
					WHERE sub.thread_id = m.thread_id AND sub.role = 'assistant' AND sub.token_usage IS NOT NULL
					ORDER BY sub.created_at DESC
					LIMIT 1
				), 0)                                                                   AS last_input_tokens
			FROM agent_messages m
			WHERE m.thread_id = ANY(${sql.raw(`ARRAY['${threadIds.join("','")}'::uuid]`)})
			GROUP BY m.thread_id
		`);

		// Build a lookup map from threadId → stats
		type StatsRow = {
			thread_id: string;
			message_count: number;
			tool_call_count: number;
			total_input_tokens: number;
			total_output_tokens: number;
			total_cost: number;
			last_input_tokens: number;
		};
		const statsMap = new Map<string, StatsRow>();
		for (const row of statsRows.rows as StatsRow[]) {
			statsMap.set(row.thread_id, row);
		}

		return threads.map((thread) => {
			const stats = statsMap.get(thread.id);
			return {
				id: thread.id,
				agentId: thread.agentId,
				title: thread.title ?? undefined,
				status: thread.status as AgentRunSummary['status'],
				triggerType: thread.triggerType as AgentRunSummary['triggerType'],
				messageCount: stats?.message_count ?? 0,
				toolCallCount: stats?.tool_call_count ?? 0,
				totalInputTokens: stats?.total_input_tokens ?? 0,
				totalOutputTokens: stats?.total_output_tokens ?? 0,
				totalCost: stats?.total_cost ?? 0,
				lastInputTokens: stats?.last_input_tokens ?? 0,
				createdAt: thread.createdAt,
				updatedAt: thread.updatedAt,
			};
		});
	}
}
