import { Router } from 'express';
import type { Request, Response } from 'express';
import { AgentService } from '../services/AgentService.js';
import { AgentSessionService } from '../services/AgentSessionService.js';
import { SkillService } from '../services/SkillService.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../config/logger.js';
import type { AuthService } from '../services/AuthService.js';
import { createAgentSkillsRouter } from './skills.js';
import type {
	AgentsListResponse,
	AgentResponse,
	AgentDeleteResponse,
	AgentMemoryListResponse,
	AgentMemoryDeleteResponse,
	AgentRunsListResponse,
	CreateAgentRequestBody,
	UpdateAgentRequestBody,
} from '@repo/types';

const agentService = new AgentService();
const sessionService = new AgentSessionService();

/** Bounds for the per-agent tool-call cap (matches the frontend input + agent-runner default). */
const MAX_TOOL_CALLS_MIN = 1;
const MAX_TOOL_CALLS_MAX = 200;

/**
 * Validate and clamp the optional maxToolCallsPerTurn field from a request body.
 * Returns undefined when not provided (service applies its default / leaves unchanged),
 * a clamped integer in [1, 100] when valid, or throws when present but not a finite number.
 */
function parseMaxToolCallsPerTurn(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error('maxToolCallsPerTurn must be a number between 1 and 100');
	}
	return Math.min(MAX_TOOL_CALLS_MAX, Math.max(MAX_TOOL_CALLS_MIN, Math.round(value)));
}

/**
 * Factory — creates the agents router with an injected AuthService instance.
 *
 * All routes requireAuth; ownerId comes from the authenticated token
 * (req.user.sub) — never from the client — so users can only act on
 * their own agents.
 *
 * Routes:
 *   GET    /v1/agents                       — list agents for an owner
 *   GET    /v1/agents/:id                   — get a single agent
 *   POST   /v1/agents                       — create a new agent
 *   PUT    /v1/agents/:id                   — update an agent
 *   DELETE /v1/agents/:id                   — delete an agent
 *   GET    /v1/agents/:id/memory            — list memory entries
 *   DELETE /v1/agents/:id/memory/:memoryId  — delete a memory entry
 */
export function createAgentsRouter(authService: AuthService, skillService: SkillService): Router {
	const router = Router();
	const auth = requireAuth(authService);

	/**
	 * GET /v1/agents
	 * List all agents owned by the authenticated user.
	 */
	router.get('/', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			const body: AgentsListResponse = { success: false, error: 'Unauthorized' };
			res.status(401).json(body);
			return;
		}

		const list = await agentService.listByOwner(ownerId);
		const body: AgentsListResponse = { success: true, data: list };
		res.json(body);
	});

	/**
	 * GET /v1/agents/:id
	 * Get a single agent by ID with ownership check.
	 */
	router.get('/:id', auth, async (req: Request, res: Response) => {
		const id = req.params.id as string;
		const ownerId = req.user?.sub;
		if (!ownerId) {
			const body: AgentResponse = { success: false, error: 'Unauthorized' };
			res.status(401).json(body);
			return;
		}

		const agent = await agentService.getById(id, ownerId);
		if (!agent) {
			const body: AgentResponse = { success: false, error: 'Agent not found' };
			res.status(404).json(body);
			return;
		}
		const body: AgentResponse = { success: true, data: agent };
		res.json(body);
	});

	/**
	 * POST /v1/agents
	 * Create a new agent.
	 * Body: { name, description?, systemInstruction?, avatarUrl?, credentialIds? }
	 */
	router.post('/', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			const body: AgentResponse = { success: false, error: 'Unauthorized' };
			res.status(401).json(body);
			return;
		}

		const {
			name,
			description,
			systemInstruction,
			avatarUrl,
			credentialIds,
			collaboratorIds,
			allCredentials,
			modelConfigId,
			embeddingModelConfigId,
			embeddingDim,
			allowInternetAccess,
		} = req.body as CreateAgentRequestBody;

		if (!name) {
			const body: AgentResponse = {
				success: false,
				error: 'name is required',
			};
			res.status(400).json(body);
			return;
		}

		let maxToolCallsPerTurn: number | undefined;
		try {
			maxToolCallsPerTurn = parseMaxToolCallsPerTurn(
				(req.body as CreateAgentRequestBody).maxToolCallsPerTurn,
			);
		} catch (err) {
			const body: AgentResponse = { success: false, error: (err as Error).message };
			res.status(400).json(body);
			return;
		}

		try {
			const agent = await agentService.create({
				ownerId,
				name,
				description,
				systemInstruction,
				avatarUrl,
				credentialIds,
				collaboratorIds,
				allCredentials,
				modelConfigId,
				embeddingModelConfigId,
				embeddingDim,
				allowInternetAccess,
				maxToolCallsPerTurn,
			});
			const body: AgentResponse = { success: true, data: agent };
			res.status(201).json(body);
		} catch (err) {
			logger.error({ err }, 'Failed to create agent');
			const body: AgentResponse = { success: false, error: 'Failed to create agent' };
			res.status(500).json(body);
		}
	});

	/**
	 * PUT /v1/agents/:id
	 * Update an existing agent.
	 * Body: { name?, description?, systemInstruction?, avatarUrl?, credentialIds? }
	 */
	router.put('/:id', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			const body: AgentResponse = { success: false, error: 'Unauthorized' };
			res.status(401).json(body);
			return;
		}

		const {
			name,
			description,
			systemInstruction,
			avatarUrl,
			credentialIds,
			collaboratorIds,
			allCredentials,
			modelConfigId,
			embeddingModelConfigId,
			embeddingDim,
			allowInternetAccess,
			maxToolCallsPerTurn: rawMaxToolCallsPerTurn,
		} = req.body as UpdateAgentRequestBody;

		if (
			name === undefined &&
			description === undefined &&
			systemInstruction === undefined &&
			avatarUrl === undefined &&
			credentialIds === undefined &&
			collaboratorIds === undefined &&
			allCredentials === undefined &&
			modelConfigId === undefined &&
			embeddingModelConfigId === undefined &&
			embeddingDim === undefined &&
			allowInternetAccess === undefined &&
			rawMaxToolCallsPerTurn === undefined
		) {
			const body: AgentResponse = {
				success: false,
				error: 'At least one field to update is required',
			};
			res.status(400).json(body);
			return;
		}

		let maxToolCallsPerTurn: number | undefined;
		try {
			maxToolCallsPerTurn = parseMaxToolCallsPerTurn(rawMaxToolCallsPerTurn);
		} catch (err) {
			const body: AgentResponse = { success: false, error: (err as Error).message };
			res.status(400).json(body);
			return;
		}

		try {
			const updateId = req.params.id as string;
			const updated = await agentService.update(updateId, ownerId, {
				name,
				description,
				systemInstruction,
				avatarUrl,
				credentialIds,
				collaboratorIds,
				allCredentials,
				modelConfigId,
				embeddingModelConfigId,
				embeddingDim,
				allowInternetAccess,
				maxToolCallsPerTurn,
			});

			if (!updated) {
				const body: AgentResponse = { success: false, error: 'Agent not found' };
				res.status(404).json(body);
				return;
			}

			const body: AgentResponse = { success: true, data: updated };
			res.json(body);
		} catch (err) {
			logger.error({ err }, 'Failed to update agent');
			const body: AgentResponse = { success: false, error: 'Failed to update agent' };
			res.status(500).json(body);
		}
	});

	/**
	 * DELETE /v1/agents/:id
	 * Delete an agent.
	 */
	router.delete('/:id', auth, async (req: Request, res: Response) => {
		const deleteId = req.params.id as string;
		const ownerId = req.user?.sub;
		if (!ownerId) {
			const body: AgentDeleteResponse = { success: false, error: 'Unauthorized' };
			res.status(401).json(body);
			return;
		}

		const deleted = await agentService.delete(deleteId, ownerId);
		if (!deleted) {
			const body: AgentDeleteResponse = { success: false, error: 'Agent not found' };
			res.status(404).json(body);
			return;
		}
		const body: AgentDeleteResponse = { success: true, data: { deleted: true } };
		res.json(body);
	});

	// ─── Skills Sub-Router ────────────────────────────────────────────────────
	// Mounted at /:id/skills — mergeParams is set in createAgentSkillsRouter
	router.use('/:id/skills', createAgentSkillsRouter(authService, skillService, agentService));

	// ─── Memory Routes ────────────────────────────────────────────────────────

	/**
	 * GET /v1/agents/:id/memory
	 * List memory entries for an agent (paginated).
	 * Query: limit? (default 50), offset? (default 0)
	 */
	router.get('/:id/memory', auth, async (req: Request, res: Response) => {
		const agentId = req.params.id as string;
		const ownerId = req.user?.sub;
		if (!ownerId) {
			const body: AgentMemoryListResponse = { success: false, error: 'Unauthorized' };
			res.status(401).json(body);
			return;
		}

		// Verify ownership first
		const agent = await agentService.getById(agentId, ownerId);
		if (!agent) {
			const body: AgentMemoryListResponse = { success: false, error: 'Agent not found' };
			res.status(404).json(body);
			return;
		}

		const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 100);
		const offset = parseInt((req.query.offset as string) ?? '0', 10);
		const entries = await agentService.listMemory(agentId, limit, offset);
		const body: AgentMemoryListResponse = { success: true, data: entries };
		res.json(body);
	});

	/**
	 * GET /v1/agents/:id/runs
	 * List aggregated run summaries (threads + token/cost stats) for an agent.
	 * Query: limit? (default 50), offset? (default 0)
	 */
	router.get('/:id/runs', auth, async (req: Request, res: Response) => {
		const agentId = req.params.id as string;
		const ownerId = req.user?.sub;
		if (!ownerId) {
			const body: AgentRunsListResponse = { success: false, error: 'Unauthorized' };
			res.status(401).json(body);
			return;
		}

		const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 100);
		const offset = parseInt((req.query.offset as string) ?? '0', 10);

		try {
			const runs = await sessionService.listRuns(agentId, ownerId, limit, offset);
			const body: AgentRunsListResponse = { success: true, data: runs };
			res.json(body);
		} catch (err) {
			logger.error({ err, agentId }, 'Failed to list agent runs');
			const body: AgentRunsListResponse = {
				success: false,
				error: 'Failed to load run history',
			};
			res.status(500).json(body);
		}
	});

	/**
	 * DELETE /v1/agents/:id/memory/:memoryId
	 * Delete a specific memory entry.
	 */
	router.delete('/:id/memory/:memoryId', auth, async (req: Request, res: Response) => {
		const agentId = req.params.id as string;
		const memoryId = req.params.memoryId as string;
		const ownerId = req.user?.sub;
		if (!ownerId) {
			const body: AgentMemoryDeleteResponse = { success: false, error: 'Unauthorized' };
			res.status(401).json(body);
			return;
		}

		// Verify ownership first
		const agent = await agentService.getById(agentId, ownerId);
		if (!agent) {
			const body: AgentMemoryDeleteResponse = { success: false, error: 'Agent not found' };
			res.status(404).json(body);
			return;
		}

		const deleted = await agentService.deleteMemory(memoryId, agentId);
		if (!deleted) {
			const body: AgentMemoryDeleteResponse = {
				success: false,
				error: 'Memory entry not found',
			};
			res.status(404).json(body);
			return;
		}

		const body: AgentMemoryDeleteResponse = { success: true, data: { deleted: true } };
		res.json(body);
	});

	return router;
}
