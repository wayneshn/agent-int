import { Router } from 'express';
import type { Request, Response } from 'express';
import { AuthService } from '../services/AuthService.js';
import { MissionService } from '../services/MissionService.js';
import { MissionSchedulerService } from '../services/MissionSchedulerService.js';
import { AgentRuntimeService } from '../services/AgentRuntimeService.js';
import { agentStreamBus } from '../services/AgentStreamBus.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../config/logger.js';
import type {
	CreateMissionRequest,
	UpdateMissionRequest,
	DecideMissionApprovalRequest,
	MissionResponse,
	MissionsListResponse,
	MissionDeleteResponse,
	MissionEventsResponse,
	MissionApprovalsResponse,
	MissionWakeResponse,
} from '@repo/types';

/**
 * Mission routes — owner-facing CRUD and control surface for autonomous missions.
 *
 * All routes are scoped to an agent (mounted at /v1/agents/:agentId/missions via
 * mergeParams, same as workflows):
 *   POST   /                                — create a mission (draft, or active with activate:true)
 *   GET    /                                — list missions for the agent
 *   GET    /:missionId                      — mission detail (includes budget accumulators)
 *   PUT    /:missionId                      — update goal/schedule/budgets/policy
 *   DELETE /:missionId                      — delete (draft/completed/failed only)
 *   POST   /:missionId/pause                — pause + cancel a live wake turn (kill switch)
 *   POST   /:missionId/resume               — reactivate a paused mission
 *   POST   /:missionId/complete             — mark completed
 *   POST   /:missionId/wake                 — wake now (manual run)
 *   GET    /:missionId/events               — activity journal (paginated, newest first)
 *   GET    /:missionId/approvals            — approval requests
 *   POST   /:missionId/approvals/:approvalId — decide a pending approval
 */
export function createMissionsRouter(
	authService: AuthService,
	missionService: MissionService,
	missionSchedulerService: MissionSchedulerService,
	runtimeService: AgentRuntimeService,
): Router {
	const router = Router({ mergeParams: true });
	const auth = requireAuth(authService);

	/** Validate numeric budget/interval fields shared by create and update */
	const validateNumbers = (body: Partial<CreateMissionRequest>): string | null => {
		if (
			body.maxCostTotal !== undefined &&
			(!Number.isFinite(body.maxCostTotal) || body.maxCostTotal <= 0)
		) {
			return 'maxCostTotal must be a positive number';
		}
		if (
			body.maxCostPerDay !== undefined &&
			body.maxCostPerDay !== null &&
			(!Number.isFinite(body.maxCostPerDay) || body.maxCostPerDay <= 0)
		) {
			return 'maxCostPerDay must be a positive number';
		}
		if (
			body.maxTurnsPerDay !== undefined &&
			body.maxTurnsPerDay !== null &&
			(!Number.isInteger(body.maxTurnsPerDay) || body.maxTurnsPerDay <= 0)
		) {
			return 'maxTurnsPerDay must be a positive integer';
		}
		const min = body.minIntervalMinutes;
		const max = body.maxIntervalMinutes;
		if (min !== undefined && (!Number.isInteger(min) || min < 1)) {
			return 'minIntervalMinutes must be a positive integer';
		}
		if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
			return 'maxIntervalMinutes must be a positive integer';
		}
		if (min !== undefined && max !== undefined && min > max) {
			return 'minIntervalMinutes cannot exceed maxIntervalMinutes';
		}
		return null;
	};

	/** POST / — create a mission */
	router.post('/', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { agentId } = req.params as { agentId: string };
		const body = req.body as CreateMissionRequest;

		if (!body.title?.trim() || !body.goal?.trim()) {
			res.status(400).json({ success: false, error: 'title and goal are required' });
			return;
		}
		if (body.maxCostTotal === undefined) {
			res.status(400).json({ success: false, error: 'maxCostTotal (total budget) is required' });
			return;
		}
		const numberError = validateNumbers(body);
		if (numberError) {
			res.status(400).json({ success: false, error: numberError });
			return;
		}
		if (body.scheduleMode === 'fixed' && !body.cronExpr?.trim()) {
			res.status(400).json({ success: false, error: 'cronExpr is required for fixed schedules' });
			return;
		}

		try {
			const mission = await missionService.create(agentId, ownerId, body);
			if (!mission) {
				res.status(404).json({ success: false, error: 'Agent not found' });
				return;
			}
			const response: MissionResponse = { success: true, data: mission };
			res.status(201).json(response);
		} catch (err) {
			logger.error({ err, agentId }, '[missions] create failed');
			res.status(500).json({ success: false, error: 'Failed to create the mission' });
		}
	});

	/** GET / — list missions for the agent */
	router.get('/', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { agentId } = req.params as { agentId: string };
		try {
			const missions = await missionService.listByAgent(agentId, ownerId);
			const response: MissionsListResponse = { success: true, data: missions };
			res.json(response);
		} catch (err) {
			logger.error({ err, agentId }, '[missions] list failed');
			res.status(500).json({ success: false, error: 'Failed to list missions' });
		}
	});

	/** GET /:missionId — mission detail */
	router.get('/:missionId', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { missionId } = req.params as { missionId: string };
		const mission = await missionService.getById(missionId, ownerId);
		if (!mission) {
			res.status(404).json({ success: false, error: 'Mission not found' });
			return;
		}
		const response: MissionResponse = { success: true, data: mission };
		res.json(response);
	});

	/** PUT /:missionId — update mission settings */
	router.put('/:missionId', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { missionId } = req.params as { missionId: string };
		const body = req.body as UpdateMissionRequest;
		const numberError = validateNumbers(body as Partial<CreateMissionRequest>);
		if (numberError) {
			res.status(400).json({ success: false, error: numberError });
			return;
		}
		try {
			const mission = await missionService.update(missionId, ownerId, body);
			if (!mission) {
				res.status(404).json({ success: false, error: 'Mission not found' });
				return;
			}
			const response: MissionResponse = { success: true, data: mission };
			res.json(response);
		} catch (err) {
			logger.error({ err, missionId }, '[missions] update failed');
			res.status(500).json({ success: false, error: 'Failed to update the mission' });
		}
	});

	/** DELETE /:missionId — delete (inactive statuses only) */
	router.delete('/:missionId', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { missionId } = req.params as { missionId: string };
		const existing = await missionService.getById(missionId, ownerId);
		if (!existing) {
			res.status(404).json({ success: false, error: 'Mission not found' });
			return;
		}
		if (existing.status === 'active' || existing.status === 'paused') {
			res.status(409).json({
				success: false,
				error: 'Pause and complete the mission before deleting it',
			});
			return;
		}
		const deleted = await missionService.delete(missionId, ownerId);
		const response: MissionDeleteResponse = { success: true, data: { deleted } };
		res.json(response);
	});

	/** POST /:missionId/pause — pause + kill any live wake turn */
	router.post('/:missionId/pause', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { missionId } = req.params as { missionId: string };
		try {
			const mission = await missionService.pause(missionId, ownerId, 'paused_by_owner');
			if (!mission) {
				res.status(404).json({ success: false, error: 'Mission not found' });
				return;
			}
			// Kill switch: stop a live wake turn immediately (idempotent, safe when idle).
			if (mission.currentThreadId) {
				await runtimeService.cancelTurn(mission.currentThreadId);
			}
			const response: MissionResponse = { success: true, data: mission };
			res.json(response);
		} catch (err) {
			logger.error({ err, missionId }, '[missions] pause failed');
			res.status(500).json({ success: false, error: 'Failed to pause the mission' });
		}
	});

	/** POST /:missionId/resume — reactivate a paused/draft mission */
	router.post('/:missionId/resume', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { missionId } = req.params as { missionId: string };
		try {
			const mission = await missionService.activate(missionId, ownerId);
			if (!mission) {
				res.status(404).json({ success: false, error: 'Mission not found' });
				return;
			}
			const response: MissionResponse = { success: true, data: mission };
			res.json(response);
		} catch (err) {
			logger.error({ err, missionId }, '[missions] resume failed');
			res.status(500).json({ success: false, error: 'Failed to resume the mission' });
		}
	});

	/** POST /:missionId/complete — owner marks the mission done */
	router.post('/:missionId/complete', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { missionId } = req.params as { missionId: string };
		try {
			const existing = await missionService.getById(missionId, ownerId);
			if (!existing) {
				res.status(404).json({ success: false, error: 'Mission not found' });
				return;
			}
			// Stop a live wake before completing.
			if (existing.status === 'active' && existing.currentThreadId) {
				await runtimeService.cancelTurn(existing.currentThreadId);
			}
			const mission = await missionService.complete(missionId, ownerId);
			const response: MissionResponse = { success: true, data: mission! };
			res.json(response);
		} catch (err) {
			logger.error({ err, missionId }, '[missions] complete failed');
			res.status(500).json({ success: false, error: 'Failed to complete the mission' });
		}
	});

	/** POST /:missionId/wake — fire a wake immediately */
	router.post('/:missionId/wake', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { missionId } = req.params as { missionId: string };
		try {
			const result = await missionSchedulerService.wakeNow(missionId, ownerId);
			if (!result) {
				res.status(409).json({
					success: false,
					error: 'Mission is not active, is over budget, or a wake is already running',
				});
				return;
			}
			const response: MissionWakeResponse = { success: true, data: result };
			res.status(201).json(response);
		} catch (err) {
			logger.error({ err, missionId }, '[missions] manual wake failed');
			res.status(500).json({ success: false, error: 'Failed to wake the mission' });
		}
	});

	/** GET /:missionId/events — activity journal (paginated) */
	router.get('/:missionId/events', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { missionId } = req.params as { missionId: string };
		const mission = await missionService.getById(missionId, ownerId);
		if (!mission) {
			res.status(404).json({ success: false, error: 'Mission not found' });
			return;
		}
		const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
		const beforeRaw = req.query.before ? new Date(String(req.query.before)) : undefined;
		const before = beforeRaw && !Number.isNaN(beforeRaw.getTime()) ? beforeRaw : undefined;
		const events = await missionService.listEvents(missionId, ownerId, { limit, before });
		const response: MissionEventsResponse = { success: true, data: events };
		res.json(response);
	});

	/**
	 * GET /:missionId/stream — SSE feed of mission events for the detail page.
	 * Subscribes to the AgentStreamBus keyed by MISSION id (see MissionService.appendEvent).
	 * Mirrors the chat SSE handler (headers, 3s retry hint, 15s named `ping` heartbeat,
	 * unsubscribe on close). Stays open across wakes — no immediate `done`.
	 */
	router.get('/:missionId/stream', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { missionId } = req.params as { missionId: string };
		try {
			const mission = await missionService.getById(missionId, ownerId);
			if (!mission) {
				res.status(404).json({ success: false, error: 'Mission not found' });
				return;
			}

			res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache');
			res.setHeader('Connection', 'keep-alive');
			res.setHeader('X-Accel-Buffering', 'no');
			res.flushHeaders();
			res.write('retry: 3000\n\n');

			const heartbeat = setInterval(() => {
				res.write('event: ping\ndata: {}\n\n');
			}, 15_000);

			const unsubscribe = agentStreamBus.subscribe(missionId, (event) => {
				res.write(`data: ${JSON.stringify(event)}\n\n`);
			});

			req.on('close', () => {
				clearInterval(heartbeat);
				unsubscribe();
			});
		} catch (err) {
			logger.error({ err, missionId }, '[missions] failed to setup stream');
			res.status(500).json({ success: false, error: 'Failed to setup stream' });
		}
	});

	/** GET /:missionId/approvals — approval requests (all statuses, newest first) */
	router.get('/:missionId/approvals', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { missionId } = req.params as { missionId: string };
		const mission = await missionService.getById(missionId, ownerId);
		if (!mission) {
			res.status(404).json({ success: false, error: 'Mission not found' });
			return;
		}
		const approvals = await missionService.listApprovals(missionId, ownerId);
		const response: MissionApprovalsResponse = { success: true, data: approvals };
		res.json(response);
	});

	/** POST /:missionId/approvals/:approvalId — decide a pending approval */
	router.post('/:missionId/approvals/:approvalId', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { missionId, approvalId } = req.params as { missionId: string; approvalId: string };
		const body = req.body as DecideMissionApprovalRequest;
		if (body.decision !== 'approved' && body.decision !== 'denied') {
			res.status(400).json({ success: false, error: "decision must be 'approved' or 'denied'" });
			return;
		}
		try {
			const approval = await missionService.decideApproval(
				approvalId,
				missionId,
				ownerId,
				body.decision,
				body.note,
			);
			if (!approval) {
				res.status(404).json({ success: false, error: 'Pending approval not found' });
				return;
			}
			// On approve, pull the next wake forward so the mission reacts promptly.
			if (body.decision === 'approved') {
				const mission = await missionService.getById(missionId, ownerId);
				if (mission?.status === 'active') {
					await missionService.setNextWake(missionId, new Date(), 'manual');
				}
			}
			res.json({ success: true, data: approval });
		} catch (err) {
			logger.error({ err, missionId, approvalId }, '[missions] approval decision failed');
			res.status(500).json({ success: false, error: 'Failed to record the decision' });
		}
	});

	return router;
}
