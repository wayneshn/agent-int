import { eq, and, inArray, sql } from 'drizzle-orm';
import { rmSync } from 'fs';
import { resolve } from 'path';
import { db } from '../db/index.js';
import { agents, agentCredentials, agentCollaborators, agentMemory } from '../db/schema/index.js';
import type { Agent, AgentCollaboratorSummary, AgentMemoryEntry, MemoryType } from '@repo/types';
import { logger } from '../config/logger.js';

// ─── Input Types ──────────────────────────────────────────────────────────────

export interface CreateAgentInput {
	ownerId: string;
	name: string;
	description?: string;
	systemInstruction?: string;
	avatarUrl?: string;
	credentialIds?: string[];
	/** IDs of other agents this agent may message (agent-to-agent allow-list). */
	collaboratorIds?: string[];
	allCredentials?: boolean;
	modelConfigId?: string;
	embeddingModelConfigId?: string;
	embeddingDim?: number;
	allowInternetAccess?: boolean;
	maxToolCallsPerTurn?: number;
}

export interface UpdateAgentInput {
	name?: string;
	description?: string;
	systemInstruction?: string;
	avatarUrl?: string;
	credentialIds?: string[];
	/** IDs of other agents this agent may message (agent-to-agent allow-list). */
	collaboratorIds?: string[];
	allCredentials?: boolean;
	modelConfigId?: string | null;
	embeddingModelConfigId?: string | null;
	embeddingDim?: number | null;
	allowInternetAccess?: boolean;
	maxToolCallsPerTurn?: number;
}

export interface AddMemoryInput {
	agentId: string;
	content: string;
	embedding: number[];
	memoryType: MemoryType;
	/** Optional thread scope — for 'working' memory entries */
	threadId?: string;
	metadata?: Record<string, unknown>;
	/** True for chunks generated from a knowledge-base file */
	isKnowledgeBase?: boolean;
	/** Owning knowledge assignment (agent_knowledge_files row) — chunks cascade with it */
	agentKnowledgeFileId?: string;
}

export interface SearchMemoryInput {
	agentId: string;
	queryEmbedding: number[];
	/** Optional filter by memory type */
	memoryType?: MemoryType;
	/** Optional thread scope filter */
	threadId?: string;
	limit?: number;
}

export interface AgentMemorySearchRow extends AgentMemoryEntry {
	/** Raw pgvector cosine distance (0 = identical, up to 2 = opposite). */
	distance: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map a DB row + credentialIds/collaboratorIds arrays to the Agent API type */
function rowToAgent(
	row: typeof agents.$inferSelect,
	credentialIds: string[],
	collaboratorIds: string[],
): Agent {
	return {
		id: row.id,
		ownerId: row.ownerId,
		name: row.name,
		description: row.description ?? undefined,
		systemInstruction: row.systemInstruction ?? undefined,
		avatarUrl: row.avatarUrl ?? undefined,
		credentialIds,
		collaboratorIds,
		allCredentials: row.allCredentials,
		modelConfigId: row.modelConfigId ?? undefined,
		embeddingModelConfigId: row.embeddingModelConfigId ?? undefined,
		embeddingDim: row.embeddingDim ?? undefined,
		allowInternetAccess: row.allowInternetAccess,
		maxToolCallsPerTurn: row.maxToolCallsPerTurn,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function rowToMemoryEntry(row: typeof agentMemory.$inferSelect): AgentMemoryEntry {
	return {
		id: row.id,
		agentId: row.agentId,
		threadId: row.threadId ?? undefined,
		memoryType: row.memoryType as MemoryType,
		content: row.content,
		metadata: (row.metadata as Record<string, unknown>) ?? undefined,
		isKnowledgeBase: row.isKnowledgeBase,
		agentKnowledgeFileId: row.agentKnowledgeFileId ?? undefined,
		createdAt: row.createdAt,
	};
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Service for agent CRUD operations and memory management.
 * Ownership is enforced at the DB layer — all queries include ownerId in WHERE.
 */
export class AgentService {
	/**
	 * Sanitize a collaborator allow-list before writing it: dedup, drop the agent's
	 * own id, and keep ONLY agents that exist and belong to ownerId. This is the
	 * write-time enforcement of the same-owner invariant that listCollaborators and
	 * the A2A messaging path rely on — without it a caller could link (and leak
	 * metadata about) another tenant's agent by submitting its UUID.
	 */
	private async sanitizeCollaboratorIds(
		ids: string[],
		ownerId: string,
		selfId?: string,
	): Promise<string[]> {
		const unique = [...new Set(ids)].filter((targetId) => targetId !== selfId);
		if (unique.length === 0) return [];
		const rows = await db
			.select({ id: agents.id })
			.from(agents)
			.where(and(inArray(agents.id, unique), eq(agents.ownerId, ownerId)));
		return rows.map((r) => r.id);
	}

	/** Create a new agent and link credential access */
	async create(input: CreateAgentInput): Promise<Agent> {
		const now = new Date();

		const [row] = await db
			.insert(agents)
			.values({
				ownerId: input.ownerId,
				name: input.name,
				description: input.description ?? null,
				systemInstruction: input.systemInstruction ?? null,
				avatarUrl: input.avatarUrl ?? '🤖',
				modelConfigId: input.modelConfigId ?? null,
				embeddingModelConfigId: input.embeddingModelConfigId ?? null,
				embeddingDim: input.embeddingDim ?? null,
				allowInternetAccess: input.allowInternetAccess ?? true,
				allCredentials: input.allCredentials ?? false,
				maxToolCallsPerTurn: input.maxToolCallsPerTurn ?? 20,
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		// Insert credential junction rows
		if (input.credentialIds && input.credentialIds.length > 0) {
			await db.insert(agentCredentials).values(
				input.credentialIds.map((credentialId) => ({
					agentId: row.id,
					credentialId,
				})),
			);
		}

		// Insert collaborator (agent-to-agent allow-list) junction rows — sanitized to
		// the owner's own agents (dedup + same-owner check).
		let collaboratorIds: string[] = [];
		if (input.collaboratorIds && input.collaboratorIds.length > 0) {
			collaboratorIds = await this.sanitizeCollaboratorIds(
				input.collaboratorIds,
				input.ownerId,
				row.id,
			);
			if (collaboratorIds.length > 0) {
				await db.insert(agentCollaborators).values(
					collaboratorIds.map((targetAgentId) => ({
						agentId: row.id,
						targetAgentId,
					})),
				);
			}
		}

		return rowToAgent(row, input.credentialIds ?? [], collaboratorIds);
	}

	/** List all agents for an owner with their linked credential IDs */
	async listByOwner(ownerId: string): Promise<Agent[]> {
		const rows = await db
			.select()
			.from(agents)
			.where(eq(agents.ownerId, ownerId))
			.orderBy(agents.createdAt);

		if (rows.length === 0) return [];

		// Fetch all credential links for these agents in one query
		const agentIds = rows.map((r) => r.id);
		const credLinks = await db
			.select()
			.from(agentCredentials)
			.where(inArray(agentCredentials.agentId, agentIds));

		// Group credential IDs by agent
		const credMap = new Map<string, string[]>();
		for (const link of credLinks) {
			const existing = credMap.get(link.agentId) ?? [];
			existing.push(link.credentialId);
			credMap.set(link.agentId, existing);
		}

		// Fetch and group collaborator links the same way
		const collabLinks = await db
			.select()
			.from(agentCollaborators)
			.where(inArray(agentCollaborators.agentId, agentIds));
		const collabMap = new Map<string, string[]>();
		for (const link of collabLinks) {
			const existing = collabMap.get(link.agentId) ?? [];
			existing.push(link.targetAgentId);
			collabMap.set(link.agentId, existing);
		}

		return rows.map((row) => rowToAgent(row, credMap.get(row.id) ?? [], collabMap.get(row.id) ?? []));
	}

	/**
	 * Get a single agent by ID WITHOUT ownership check.
	 * Internal-only — used by background workers (e.g. the skill evolution
	 * engine) that have no request context. Never expose to HTTP handlers.
	 */
	async getByIdInternal(id: string): Promise<Agent | null> {
		const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
		if (!rows[0]) return null;

		const credLinks = await db
			.select({ credentialId: agentCredentials.credentialId })
			.from(agentCredentials)
			.where(eq(agentCredentials.agentId, id));

		const collabLinks = await db
			.select({ targetAgentId: agentCollaborators.targetAgentId })
			.from(agentCollaborators)
			.where(eq(agentCollaborators.agentId, id));

		return rowToAgent(
			rows[0],
			credLinks.map((l) => l.credentialId),
			collabLinks.map((l) => l.targetAgentId),
		);
	}

	/** Get a single agent by ID with ownership check */
	async getById(id: string, ownerId: string): Promise<Agent | null> {
		const rows = await db
			.select()
			.from(agents)
			.where(and(eq(agents.id, id), eq(agents.ownerId, ownerId)))
			.limit(1);

		if (!rows[0]) return null;

		const row = rows[0];
		const credLinks = await db
			.select({ credentialId: agentCredentials.credentialId })
			.from(agentCredentials)
			.where(eq(agentCredentials.agentId, id));

		const collabLinks = await db
			.select({ targetAgentId: agentCollaborators.targetAgentId })
			.from(agentCollaborators)
			.where(eq(agentCollaborators.agentId, id));

		return rowToAgent(
			row,
			credLinks.map((l) => l.credentialId),
			collabLinks.map((l) => l.targetAgentId),
		);
	}

	/**
	 * List the collaborator agents this agent is allowed to message, with display
	 * metadata (id, name, description). Joined to agents so the caller gets names
	 * for the list_agents tool. No ownership check here — same-owner is enforced at
	 * write time (create/update run collaboratorIds through sanitizeCollaboratorIds).
	 */
	async listCollaborators(agentId: string): Promise<AgentCollaboratorSummary[]> {
		const rows = await db
			.select({
				id: agents.id,
				name: agents.name,
				description: agents.description,
			})
			.from(agentCollaborators)
			.innerJoin(agents, eq(agents.id, agentCollaborators.targetAgentId))
			.where(eq(agentCollaborators.agentId, agentId))
			.orderBy(agents.name);
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			description: r.description ?? undefined,
		}));
	}

	/** Update an agent's configuration. Replaces credential links entirely. */
	async update(id: string, ownerId: string, input: UpdateAgentInput): Promise<Agent | null> {
		const existing = await this.getById(id, ownerId);
		if (!existing) return null;

		const updates: Partial<{
			name: string;
			description: string | null;
			systemInstruction: string | null;
			avatarUrl: string | null;
			modelConfigId: string | null;
			embeddingModelConfigId: string | null;
			embeddingDim: number | null;
			allowInternetAccess: boolean;
			allCredentials: boolean;
			maxToolCallsPerTurn: number;
			updatedAt: Date;
		}> = { updatedAt: new Date() };

		if (input.name !== undefined) updates.name = input.name;
		if (input.description !== undefined) updates.description = input.description || null;
		if (input.systemInstruction !== undefined)
			updates.systemInstruction = input.systemInstruction || null;
		if (input.avatarUrl !== undefined) updates.avatarUrl = input.avatarUrl || null;
		if (input.modelConfigId !== undefined) updates.modelConfigId = input.modelConfigId;
		if (input.embeddingModelConfigId !== undefined)
			updates.embeddingModelConfigId = input.embeddingModelConfigId;
		if (input.embeddingDim !== undefined) updates.embeddingDim = input.embeddingDim;
		if (input.allowInternetAccess !== undefined)
			updates.allowInternetAccess = input.allowInternetAccess;
		if (input.allCredentials !== undefined) updates.allCredentials = input.allCredentials;
		if (input.maxToolCallsPerTurn !== undefined)
			updates.maxToolCallsPerTurn = input.maxToolCallsPerTurn;

		await db
			.update(agents)
			.set(updates)
			.where(and(eq(agents.id, id), eq(agents.ownerId, ownerId)));

		// Replace credential links if provided
		if (input.credentialIds !== undefined) {
			await db.delete(agentCredentials).where(eq(agentCredentials.agentId, id));
			if (input.credentialIds.length > 0) {
				await db.insert(agentCredentials).values(
					input.credentialIds.map((credentialId) => ({
						agentId: id,
						credentialId,
					})),
				);
			}
		}

		// Replace collaborator (agent-to-agent) links if provided. The list is
		// sanitized BEFORE the delete so a bad input (duplicate ids, foreign-tenant
		// or deleted agent ids, self-link) can neither wipe the existing allow-list
		// via a failed insert nor store a cross-owner link.
		if (input.collaboratorIds !== undefined) {
			const targets = await this.sanitizeCollaboratorIds(input.collaboratorIds, ownerId, id);
			await db.delete(agentCollaborators).where(eq(agentCollaborators.agentId, id));
			if (targets.length > 0) {
				await db.insert(agentCollaborators).values(
					targets.map((targetAgentId) => ({
						agentId: id,
						targetAgentId,
					})),
				);
			}
		}

		return this.getById(id, ownerId);
	}

	/** Delete an agent (cascades to credentials junction and memory) and removes the workspace */
	async delete(id: string, ownerId: string): Promise<boolean> {
		const result = await db
			.delete(agents)
			.where(and(eq(agents.id, id), eq(agents.ownerId, ownerId)));

		const deleted = (result.rowCount ?? 0) > 0;

		if (deleted) {
			// Clean up the per-agent persistent workspace directory.
			// Non-fatal — the workspace may not exist yet if the agent never ran.
			const workspacesBasePath =
				process.env.AGENT_WORKSPACES_PATH ?? resolve(process.cwd(), '.agent-workspaces');
			const workspacePath = `${workspacesBasePath}/${id}`;
			try {
				rmSync(workspacePath, { recursive: true, force: true });
			} catch (err) {
				logger.warn({ err, agentId: id }, '[agent] failed to remove workspace directory');
			}
		}

		return deleted;
	}

	// ─── Memory Operations ────────────────────────────────────────────────────

	/**
	 * Add a memory entry with its embedding vector.
	 * The embedding must already be computed by the caller (AgentMemoryService).
	 */
	async addMemory(input: AddMemoryInput): Promise<AgentMemoryEntry> {
		const [row] = await db
			.insert(agentMemory)
			.values({
				agentId: input.agentId,
				threadId: input.threadId ?? null,
				memoryType: input.memoryType,
				content: input.content,
				embedding: input.embedding,
				metadata: input.metadata ?? null,
				isKnowledgeBase: input.isKnowledgeBase ?? false,
				agentKnowledgeFileId: input.agentKnowledgeFileId ?? null,
			})
			.returning();

		return rowToMemoryEntry(row);
	}

	/**
	 * Add multiple memory entries in a single insert. Used by the knowledge-base
	 * ingestion pipeline where one file produces many chunks.
	 */
	async addMemoryBatch(inputs: AddMemoryInput[]): Promise<number> {
		if (inputs.length === 0) return 0;
		const rows = await db
			.insert(agentMemory)
			.values(
				inputs.map((input) => ({
					agentId: input.agentId,
					threadId: input.threadId ?? null,
					memoryType: input.memoryType,
					content: input.content,
					embedding: input.embedding,
					metadata: input.metadata ?? null,
					isKnowledgeBase: input.isKnowledgeBase ?? false,
					agentKnowledgeFileId: input.agentKnowledgeFileId ?? null,
				})),
			)
			.returning({ id: agentMemory.id });
		return rows.length;
	}

	/**
	 * List memory entries for an agent (most recent first).
	 * Knowledge-base chunks are excluded by default — they are managed through
	 * the knowledge pages, not the memory UI.
	 */
	async listMemory(
		agentId: string,
		limit = 50,
		offset = 0,
		includeKnowledgeBase = false,
	): Promise<AgentMemoryEntry[]> {
		const conditions = [eq(agentMemory.agentId, agentId)];
		if (!includeKnowledgeBase) {
			conditions.push(eq(agentMemory.isKnowledgeBase, false));
		}

		const rows = await db
			.select({
				id: agentMemory.id,
				agentId: agentMemory.agentId,
				threadId: agentMemory.threadId,
				memoryType: agentMemory.memoryType,
				content: agentMemory.content,
				metadata: agentMemory.metadata,
				isKnowledgeBase: agentMemory.isKnowledgeBase,
				agentKnowledgeFileId: agentMemory.agentKnowledgeFileId,
				createdAt: agentMemory.createdAt,
			})
			.from(agentMemory)
			.where(and(...conditions))
			.orderBy(sql`${agentMemory.createdAt} DESC`)
			.limit(limit)
			.offset(offset);

		return rows.map((row) => ({
			id: row.id,
			agentId: row.agentId,
			threadId: row.threadId ?? undefined,
			memoryType: row.memoryType as MemoryType,
			content: row.content,
			metadata: (row.metadata as Record<string, unknown>) ?? undefined,
			isKnowledgeBase: row.isKnowledgeBase,
			agentKnowledgeFileId: row.agentKnowledgeFileId ?? undefined,
			createdAt: row.createdAt,
		}));
	}

	/**
	 * Search memory by vector similarity (cosine distance).
	 * Returns the closest entries to the query embedding.
	 * Optional filters: memoryType, threadId.
	 */
	async searchMemory(input: SearchMemoryInput): Promise<AgentMemorySearchRow[]> {
		const { agentId, queryEmbedding, memoryType, threadId, limit = 10 } = input;
		const vectorStr = `[${queryEmbedding.join(',')}]`;

		// Build WHERE conditions — agentId is always required, type and thread are optional
		const conditions = [eq(agentMemory.agentId, agentId)];
		if (memoryType) {
			conditions.push(eq(agentMemory.memoryType, memoryType));
		}
		if (threadId) {
			conditions.push(eq(agentMemory.threadId, threadId));
		}

		const rows = await db
			.select({
				id: agentMemory.id,
				agentId: agentMemory.agentId,
				threadId: agentMemory.threadId,
				memoryType: agentMemory.memoryType,
				content: agentMemory.content,
				metadata: agentMemory.metadata,
				isKnowledgeBase: agentMemory.isKnowledgeBase,
				agentKnowledgeFileId: agentMemory.agentKnowledgeFileId,
				createdAt: agentMemory.createdAt,
				distance: sql<number>`${agentMemory.embedding} <=> ${vectorStr}::vector`,
			})
			.from(agentMemory)
			.where(and(...conditions))
			.orderBy(sql`${agentMemory.embedding} <=> ${vectorStr}::vector`)
			.limit(limit);

		return rows.map((row) => ({
			id: row.id,
			agentId: row.agentId,
			threadId: row.threadId ?? undefined,
			memoryType: row.memoryType as MemoryType,
			content: row.content,
			metadata: (row.metadata as Record<string, unknown>) ?? undefined,
			isKnowledgeBase: row.isKnowledgeBase,
			agentKnowledgeFileId: row.agentKnowledgeFileId ?? undefined,
			createdAt: row.createdAt,
			distance: row.distance,
		}));
	}

	/** Delete a specific memory entry */
	async deleteMemory(memoryId: string, agentId: string): Promise<boolean> {
		const result = await db
			.delete(agentMemory)
			.where(and(eq(agentMemory.id, memoryId), eq(agentMemory.agentId, agentId)));
		return (result.rowCount ?? 0) > 0;
	}

	/**
	 * Delete multiple memory entries by ID in one query.
	 * The agentId guard ensures an agent can only delete its own memory.
	 * Returns the number of rows actually deleted (may be less than requested
	 * if some IDs did not exist or belonged to a different agent).
	 */
	async deleteMemoryBatch(memoryIds: string[], agentId: string): Promise<number> {
		if (memoryIds.length === 0) return 0;
		const result = await db
			.delete(agentMemory)
			.where(and(inArray(agentMemory.id, memoryIds), eq(agentMemory.agentId, agentId)));
		return result.rowCount ?? 0;
	}

	/**
	 * Delete all memory chunks belonging to one knowledge assignment.
	 * Used by re-ingestion (the FK cascade only fires when the assignment row
	 * itself is deleted). The agentId guard prevents cross-agent deletion.
	 */
	async deleteMemoryByAssignment(agentKnowledgeFileId: string, agentId: string): Promise<number> {
		const result = await db
			.delete(agentMemory)
			.where(
				and(
					eq(agentMemory.agentKnowledgeFileId, agentKnowledgeFileId),
					eq(agentMemory.agentId, agentId),
				),
			);
		return result.rowCount ?? 0;
	}
}
