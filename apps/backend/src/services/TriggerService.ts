import { eq, and, isNull, or } from 'drizzle-orm';
import * as nodeCron from 'node-cron';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { db } from '../db/index.js';
import { agentTriggers, agents, workflows } from '../db/schema/index.js';
import type {
	AgentTrigger,
	AgentTriggerKind,
	AgentTriggerConfig,
	AppTriggerConfig,
	CronTriggerConfig,
	WebhookTriggerConfig,
	WorkflowTriggerContext,
} from '@repo/types';
import { AgentRuntimeService } from './AgentRuntimeService.js';
import { AgentSessionService } from './AgentSessionService.js';
import { WorkflowService } from './WorkflowService.js';
import { WorkflowRunService } from './WorkflowRunService.js';
import { logger } from '../config/logger.js';

// ─── Mappers ──────────────────────────────────────────────────────────────────

function rowToTrigger(row: typeof agentTriggers.$inferSelect): AgentTrigger {
	let appRegistration: AgentTrigger['appRegistration'];
	if (row.kind === 'app' && row.state && typeof row.state === 'object') {
		const s = row.state as {
			registeredAt?: string;
			lastRegisterError?: string;
			registrationMode?: 'auto' | 'manual';
			verificationToken?: string;
		};
		if (s.registeredAt || s.lastRegisterError || s.verificationToken) {
			appRegistration = {
				registeredAt: s.registeredAt,
				error: s.lastRegisterError,
				mode: s.registrationMode,
				verificationToken: s.verificationToken,
			};
		}
	}
	return {
		id: row.id,
		agentId: row.agentId,
		ownerId: row.ownerId,
		kind: row.kind as AgentTriggerKind,
		name: row.name,
		config: row.config as AgentTriggerConfig,
		isEnabled: row.isEnabled,
		lastFiredAt: row.lastFiredAt ?? undefined,
		description: row.description ?? undefined,
		workflowId: row.workflowId ?? undefined,
		appRegistration,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum consecutive cron execution failures before a trigger is automatically disabled.
 * After this threshold the trigger is set isEnabled=false and an error is logged.
 * This prevents a persistently failing cron from silently burning resources.
 */
const MAX_CONSECUTIVE_CRON_FAILURES = 5;

// ─── Errors & Results ─────────────────────────────────────────────────────────

/** Machine-readable reason a trigger fire was rejected or failed. */
export type TriggerFireErrorCode =
	| 'not_found'
	| 'disabled'
	| 'wrong_kind'
	| 'bad_signature'
	| 'spawn_failed';

/**
 * Typed error thrown by the trigger firing paths so route handlers can map
 * failures to HTTP status codes without string-matching error messages.
 * The message stays internal (logged) — routes send their own generic text.
 */
export class TriggerFireError extends Error {
	constructor(
		message: string,
		public readonly code: TriggerFireErrorCode,
	) {
		super(message);
		this.name = 'TriggerFireError';
	}
}

/** Identifiers of what a successful trigger fire started. */
export interface TriggerFireResult {
	/** Workflow run ID — null for standalone triggers with no workflow attached */
	runId: string | null;
	/** Workflow ID — null for standalone triggers with no workflow attached */
	workflowId: string | null;
	/** The thread housing the spawned runtime */
	threadId: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Manages agent trigger CRUD and cron scheduling.
 *
 * Lifecycle:
 *   1. On backend startup, call TriggerService.loadAll() to schedule all enabled cron triggers.
 *   2. When a trigger is created/updated/deleted, the in-memory scheduler is updated in-place.
 *   3. Webhook triggers are fired externally via TriggerService.fireWebhookTrigger().
 *   4. Manual triggers are fired via TriggerService.fireManualTrigger().
 *
 * Trigger → Workflow routing:
 *   When a trigger has a workflowId set, fireTrigger() routes to the workflow pipeline:
 *     1. Creates a workflow_run record via WorkflowRunService.
 *     2. Builds a WorkflowTriggerContext (type, triggerName, firedAt, payload).
 *     3. Spawns the sandbox with AgentRuntimeConfig.workflow populated.
 *   When workflowId is null/undefined, the existing chat-style thread creation is used.
 *
 * Cron scheduling:
 *   - Uses node-cron, which runs in the host process.
 *   - Each enabled cron trigger gets one ScheduledTask stored in cronJobs map.
 *   - On disable/delete, the task is stopped and removed.
 *   - After MAX_CONSECUTIVE_CRON_FAILURES consecutive failures the trigger is auto-disabled.
 */
export class TriggerService {
	/** In-memory map of cron tasks keyed by trigger ID */
	private readonly cronJobs = new Map<string, nodeCron.ScheduledTask>();

	/**
	 * Tracks consecutive failure counts for cron triggers.
	 * Reset to 0 on a successful execution. Auto-disable fires at MAX_CONSECUTIVE_CRON_FAILURES.
	 */
	private readonly cronFailureCounts = new Map<string, number>();

	constructor(
		private readonly runtimeService: AgentRuntimeService,
		private readonly sessionService: AgentSessionService,
		private readonly workflowService: WorkflowService,
		private readonly workflowRunService: WorkflowRunService,
	) {}

	// ─── CRUD ──────────────────────────────────────────────────────────────

	/** Create a new trigger */
	async create(input: {
		agentId: string;
		ownerId: string;
		kind: AgentTriggerKind;
		name: string;
		config: AgentTriggerConfig;
		description?: string;
		workflowId?: string;
	}): Promise<AgentTrigger> {
		// For webhook triggers, generate a secret if not provided and default to
		// requiring signed requests unless the caller explicitly opted out.
		let config = input.config;
		if (input.kind === 'webhook') {
			const webhookInput = config as WebhookTriggerConfig;
			const webhookConfig: WebhookTriggerConfig = {
				secret: webhookInput.secret || randomBytes(32).toString('hex'),
				requireSignature: webhookInput.requireSignature ?? true,
			};
			config = webhookConfig;
		}

		const now = new Date();
		const [row] = await db
			.insert(agentTriggers)
			.values({
				agentId: input.agentId,
				ownerId: input.ownerId,
				kind: input.kind,
				name: input.name,
				config,
				isEnabled: true,
				description: input.description ?? null,
				workflowId: input.workflowId ?? null,
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		const trigger = rowToTrigger(row);

		// Schedule immediately if cron
		if (trigger.kind === 'cron' && trigger.isEnabled) {
			this.scheduleCron(trigger);
		}

		return trigger;
	}

	/** List triggers for an agent */
	async listByAgent(agentId: string, ownerId: string): Promise<AgentTrigger[]> {
		// Verify agent ownership
		const agentRows = await db
			.select({ id: agents.id })
			.from(agents)
			.where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)))
			.limit(1);
		if (!agentRows[0]) return [];

		const rows = await db
			.select()
			.from(agentTriggers)
			.where(and(eq(agentTriggers.agentId, agentId), eq(agentTriggers.ownerId, ownerId)));
		return rows.map(rowToTrigger);
	}

	/** Get a trigger by ID with ownership check */
	async getById(id: string, ownerId: string): Promise<AgentTrigger | null> {
		const rows = await db
			.select()
			.from(agentTriggers)
			.where(and(eq(agentTriggers.id, id), eq(agentTriggers.ownerId, ownerId)))
			.limit(1);
		return rows[0] ? rowToTrigger(rows[0]) : null;
	}

	/** Get a trigger by ID without ownership check (for webhook validation) */
	async getByIdInternal(id: string): Promise<AgentTrigger | null> {
		const rows = await db.select().from(agentTriggers).where(eq(agentTriggers.id, id)).limit(1);
		return rows[0] ? rowToTrigger(rows[0]) : null;
	}

	/** Update a trigger's config, enabled state, or workflow assignment */
	async update(
		id: string,
		ownerId: string,
		input: {
			name?: string;
			config?: AgentTriggerConfig;
			isEnabled?: boolean;
			description?: string;
			workflowId?: string | null;
		},
	): Promise<AgentTrigger | null> {
		const existing = await this.getById(id, ownerId);
		if (!existing) return null;

		const updates: Partial<{
			name: string;
			config: AgentTriggerConfig;
			isEnabled: boolean;
			description: string | null;
			workflowId: string | null;
			updatedAt: Date;
		}> = { updatedAt: new Date() };

		if (input.name !== undefined) updates.name = input.name;
		if (input.config !== undefined) updates.config = input.config;
		if (input.isEnabled !== undefined) updates.isEnabled = input.isEnabled;
		if (input.description !== undefined) updates.description = input.description ?? null;
		if (input.workflowId !== undefined) updates.workflowId = input.workflowId;

		await db
			.update(agentTriggers)
			.set(updates)
			.where(and(eq(agentTriggers.id, id), eq(agentTriggers.ownerId, ownerId)));

		const updated = await this.getById(id, ownerId);
		if (!updated) return null;

		// Reschedule cron if needed
		if (updated.kind === 'cron') {
			this.unscheduleCron(id);
			if (updated.isEnabled) {
				this.scheduleCron(updated);
			}
		}

		return updated;
	}

	/** Delete a trigger */
	async delete(id: string, ownerId: string): Promise<boolean> {
		const existing = await this.getById(id, ownerId);
		if (!existing) return false;

		// Stop cron job if running
		this.unscheduleCron(id);

		const result = await db
			.delete(agentTriggers)
			.where(and(eq(agentTriggers.id, id), eq(agentTriggers.ownerId, ownerId)));
		return (result.rowCount ?? 0) > 0;
	}

	// ─── Trigger Firing ───────────────────────────────────────────────────

	/**
	 * Fire a webhook trigger after verifying the HMAC signature.
	 * Called by the webhook route handler.
	 *
	 * Signature verification is skipped when the trigger's config has
	 * requireSignature === false (absent means required — the safe default).
	 *
	 * @param triggerId  The trigger ID from the URL
	 * @param signature  X-Hub-Signature-256 header value (e.g. "sha256=<hex>"), if sent
	 * @param rawBody    Raw request body as a Buffer (for accurate HMAC)
	 * @param body       Parsed request body
	 * @param headers    Sanitized request headers (auth/signature headers already stripped)
	 */
	async fireWebhookTrigger(
		triggerId: string,
		signature: string | undefined,
		rawBody: Buffer,
		body: Record<string, unknown>,
		headers: Record<string, string> = {},
	): Promise<TriggerFireResult> {
		const trigger = await this.getByIdInternal(triggerId);
		if (!trigger) {
			throw new TriggerFireError(`Trigger not found: ${triggerId}`, 'not_found');
		}
		if (!trigger.isEnabled) {
			throw new TriggerFireError(`Trigger ${triggerId} is disabled`, 'disabled');
		}
		if (trigger.kind !== 'webhook') {
			throw new TriggerFireError(`Trigger ${triggerId} is not a webhook trigger`, 'wrong_kind');
		}

		const config = trigger.config as WebhookTriggerConfig;
		if (config.requireSignature !== false) {
			if (!signature) {
				throw new TriggerFireError('Missing X-Hub-Signature-256 header', 'bad_signature');
			}
			// Verify HMAC signature using a constant-time comparison to prevent timing attacks.
			const expectedSig = `sha256=${createHmac('sha256', config.secret).update(rawBody).digest('hex')}`;
			const expectedBuf = Buffer.from(expectedSig);
			const receivedBuf = Buffer.from(signature);
			const signaturesMatch =
				expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf);
			if (!signaturesMatch) {
				throw new TriggerFireError('Invalid webhook signature', 'bad_signature');
			}
		}

		return this.fireTrigger(trigger, { headers, body });
	}

	/** Fire a manual trigger (user-initiated) */
	async fireManualTrigger(triggerId: string, ownerId: string): Promise<TriggerFireResult> {
		const trigger = await this.getById(triggerId, ownerId);
		if (!trigger) throw new TriggerFireError(`Trigger not found: ${triggerId}`, 'not_found');
		if (!trigger.isEnabled)
			throw new TriggerFireError(`Trigger ${triggerId} is disabled`, 'disabled');
		if (trigger.kind !== 'manual')
			throw new TriggerFireError(`Trigger ${triggerId} is not a manual trigger`, 'wrong_kind');

		return this.fireTrigger(trigger, { firedAt: new Date().toISOString() });
	}

	/**
	 * Fire an app trigger with a provider-normalized event payload.
	 * Called by AppTriggerManager once per external event (poll batch item, webhook
	 * delivery, or stream message). Routes through the same fireTrigger() funnel as
	 * cron/webhook/manual, so each event becomes one workflow run.
	 */
	async fireAppEvent(
		triggerId: string,
		payload: Record<string, unknown>,
	): Promise<TriggerFireResult> {
		const trigger = await this.getByIdInternal(triggerId);
		if (!trigger) throw new TriggerFireError(`Trigger not found: ${triggerId}`, 'not_found');
		if (!trigger.isEnabled)
			throw new TriggerFireError(`Trigger ${triggerId} is disabled`, 'disabled');
		if (trigger.kind !== 'app')
			throw new TriggerFireError(`Trigger ${triggerId} is not an app trigger`, 'wrong_kind');

		return this.fireTrigger(trigger, payload);
	}

	/**
	 * Fire a trigger in Test mode from the builder — a real run seeded with a user-supplied or
	 * fetched payload. Unlike the live fire paths this intentionally:
	 *   - accepts ANY trigger kind (webhook/manual/cron/app all testable with a chosen payload),
	 *   - runs even when the workflow is DISABLED (you test before enabling),
	 *   - marks the run `is_test` (excluded from history) and skips the lastFiredAt bump.
	 * `testNode` runs ONLY that node using `seededOutputs` from a prior run ("Execute node");
	 * omit for a full run.
	 */
	async fireTestRun(
		triggerId: string,
		ownerId: string,
		payload: Record<string, unknown>,
		opts: {
			testNode?: { nodeId: string; seededOutputs: Record<string, Record<string, unknown>> };
		} = {},
	): Promise<TriggerFireResult> {
		const trigger = await this.getById(triggerId, ownerId);
		if (!trigger) throw new TriggerFireError(`Trigger not found: ${triggerId}`, 'not_found');
		return this.fireTrigger(trigger, payload, {
			isTest: true,
			testNode: opts.testNode,
		});
	}

	// ─── Public scheduling helpers ────────────────────────────────────────

	/**
	 * Schedule a cron trigger in memory if it is a cron kind and is enabled.
	 * This is used by WorkflowService / routes that create or update triggers
	 * directly via DB (to avoid a circular dependency) so the cron job is
	 * registered immediately without waiting for the next server restart.
	 *
	 * Safe to call for non-cron or disabled triggers — it is a no-op in those cases.
	 */
	scheduleFromWorkflow(trigger: AgentTrigger): void {
		if (trigger.kind === 'cron' && trigger.isEnabled) {
			// Unschedule any existing job for this id first (update path)
			this.unscheduleCron(trigger.id);
			this.scheduleCron(trigger);
		}
	}

	/**
	 * Unschedule a cron job by trigger ID.
	 * Called by routes that delete a workflow (and its trigger) directly via DB.
	 * Safe to call for IDs that have no active cron job — it is a no-op.
	 */
	unscheduleFromWorkflow(triggerId: string): void {
		this.unscheduleCron(triggerId);
	}

	// ─── Startup ──────────────────────────────────────────────────────────

	/**
	 * Load all enabled cron triggers from the DB and schedule them.
	 * Call this once at server startup.
	 *
	 * Skips triggers whose linked workflow is disabled — a disabled workflow should
	 * not fire even if the trigger row itself still has isEnabled=true.
	 * Triggers with no workflowId (standalone triggers) are always scheduled.
	 */
	async loadAll(): Promise<void> {
		const rows = await db
			.select({ trigger: agentTriggers })
			.from(agentTriggers)
			// Left-join workflows so we can filter on workflow.isEnabled
			.leftJoin(workflows, eq(agentTriggers.workflowId, workflows.id))
			.where(
				and(
					eq(agentTriggers.kind, 'cron'),
					eq(agentTriggers.isEnabled, true),
					// Only schedule if there is no linked workflow OR the workflow is enabled
					or(isNull(agentTriggers.workflowId), eq(workflows.isEnabled, true)),
				),
			);

		let scheduled = 0;
		for (const row of rows) {
			const trigger = rowToTrigger(row.trigger);
			try {
				this.scheduleCron(trigger);
				scheduled++;
			} catch (err) {
				logger.error({ err, triggerId: trigger.id }, '[triggers] failed to schedule cron trigger');
			}
		}
		logger.info({ scheduled }, '[triggers] loaded and scheduled cron triggers');
	}

	// ─── Private ──────────────────────────────────────────────────────────

	/**
	 * Common trigger fire logic.
	 *
	 * If the trigger has a workflowId:
	 *   1. Load the workflow definition.
	 *   2. Create a workflow_run record.
	 *   3. Build WorkflowTriggerContext and spawn sandbox with workflow config.
	 *
	 * If the trigger has no workflowId (legacy / non-workflow triggers):
	 *   1. Create a chat-style agent_thread.
	 *   2. Spawn sandbox with the trigger payload (original behaviour).
	 */
	private async fireTrigger(
		trigger: AgentTrigger,
		payload: Record<string, unknown>,
		opts: {
			isTest?: boolean;
			testNode?: { nodeId: string; seededOutputs: Record<string, Record<string, unknown>> };
		} = {},
	): Promise<TriggerFireResult> {
		logger.info(
			{
				triggerId: trigger.id,
				agentId: trigger.agentId,
				kind: trigger.kind,
				workflowId: trigger.workflowId ?? null,
				isTest: opts.isTest ?? false,
			},
			'[triggers] firing trigger',
		);

		const firedAt = new Date().toISOString();
		let result: TriggerFireResult;

		if (trigger.workflowId) {
			// ── Workflow execution path ───────────────────────────────────────────
			const workflow = await this.workflowService.getByIdInternal(trigger.workflowId);
			if (!workflow) {
				throw new TriggerFireError(
					`Workflow ${trigger.workflowId} not found for trigger ${trigger.id}`,
					'not_found',
				);
			}
			// Test runs may execute a disabled workflow (that's the point of testing it before
			// enabling); real fires must not.
			if (!workflow.isEnabled && !opts.isTest) {
				throw new TriggerFireError(`Workflow ${trigger.workflowId} is disabled`, 'disabled');
			}

			// Create the run record
			const run = await this.workflowRunService.createRun({
				workflowId: workflow.id,
				agentId: trigger.agentId,
				ownerId: trigger.ownerId,
				triggerType: trigger.kind,
				triggerId: trigger.id,
				triggerPayload: payload,
				isTest: opts.isTest,
			});

			// The run row was created with status 'running' — anything that prevents the
			// runtime from starting must mark it 'error' or it would stay 'running' forever.
			try {
				// Build normalized trigger context for the sandbox
				const triggerContext: WorkflowTriggerContext = {
					type: trigger.kind,
					triggerName: trigger.name,
					firedAt,
					payload,
				};
				// For app triggers, surface the provider + event so Step 1's prompt can name the source.
				if (trigger.kind === 'app') {
					const appConfig = trigger.config as AppTriggerConfig;
					triggerContext.appProvider = appConfig.provider;
					triggerContext.appEvent = appConfig.event;
				}

				// Create a thread to house the sandbox spawn.
				// Marked as a workflow thread so users can filter it out in the chat history.
				const thread = await this.sessionService.createThread({
					agentId: trigger.agentId,
					ownerId: trigger.ownerId,
					title: `${workflow.name} — ${firedAt}`,
					triggerType: trigger.kind,
					triggerId: trigger.id,
					triggerPayload: payload,
					isWorkflowThread: true,
				});

				// Spawn sandbox with workflow config embedded in AgentRuntimeConfig
				const spawned = await this.runtimeService.spawnForThread(
					trigger.agentId,
					thread.id,
					trigger.ownerId,
					trigger.kind,
					payload,
					undefined, // no userDatetime for automated triggers
					{
						runId: run.id,
						definition: workflow,
						triggerContext,
						testNode: opts.testNode,
					},
				);
				if (!spawned) {
					throw new TriggerFireError(
						`Runtime could not be started for workflow run ${run.id}`,
						'spawn_failed',
					);
				}

				result = { runId: run.id, workflowId: workflow.id, threadId: thread.id };
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Workflow run failed to start';
				try {
					await this.workflowRunService.completeRun(run.id, 'error', message);
				} catch (completeErr) {
					logger.error(
						{ completeErr, runId: run.id },
						'[triggers] failed to mark workflow run as errored',
					);
				}
				throw err;
			}
		} else {
			// ── Legacy / standalone trigger path ─────────────────────────────────
			const thread = await this.sessionService.createThread({
				agentId: trigger.agentId,
				ownerId: trigger.ownerId,
				title: `${trigger.name} — ${firedAt}`,
				triggerType: trigger.kind,
				triggerId: trigger.id,
				triggerPayload: payload,
			});

			const spawned = await this.runtimeService.spawnForThread(
				trigger.agentId,
				thread.id,
				trigger.ownerId,
				trigger.kind,
				payload,
			);
			if (!spawned) {
				throw new TriggerFireError(
					`Runtime could not be started for trigger ${trigger.id}`,
					'spawn_failed',
				);
			}

			result = { runId: null, workflowId: null, threadId: thread.id };
		}

		// Update lastFiredAt for real fires only — a test run must not look like a live fire.
		if (!opts.isTest) {
			await db
				.update(agentTriggers)
				.set({ lastFiredAt: new Date(), updatedAt: new Date() })
				.where(eq(agentTriggers.id, trigger.id));
		}

		return result;
	}

	/** Register a node-cron job for a trigger */
	private scheduleCron(trigger: AgentTrigger): void {
		const config = trigger.config as CronTriggerConfig;
		const schedule = config.schedule;
		const timezone = config.timezone;

		if (!nodeCron.validate(schedule)) {
			logger.warn(
				{ triggerId: trigger.id, schedule },
				'[triggers] invalid cron schedule, skipping',
			);
			return;
		}

		const task = nodeCron.schedule(
			schedule,
			async () => {
				try {
					await this.fireTrigger(trigger, { firedAt: new Date().toISOString() });
					// Reset failure counter on success
					this.cronFailureCounts.delete(trigger.id);
				} catch (err) {
					const failures = (this.cronFailureCounts.get(trigger.id) ?? 0) + 1;
					this.cronFailureCounts.set(trigger.id, failures);

					logger.error(
						{ err, triggerId: trigger.id, consecutiveFailures: failures },
						'[triggers] cron trigger execution failed',
					);

					// Auto-disable after too many consecutive failures to prevent silent resource burn
					if (failures >= MAX_CONSECUTIVE_CRON_FAILURES) {
						logger.error(
							{ triggerId: trigger.id, failures },
							'[triggers] auto-disabling trigger after repeated consecutive failures',
						);
						this.unscheduleCron(trigger.id);
						try {
							await this.update(trigger.id, trigger.ownerId, { isEnabled: false });
						} catch (disableErr) {
							logger.error(
								{ disableErr, triggerId: trigger.id },
								'[triggers] failed to auto-disable trigger in DB',
							);
						}
					}
				}
			},
			{ timezone },
		);

		this.cronJobs.set(trigger.id, task);
		logger.info({ triggerId: trigger.id, schedule, timezone }, '[triggers] cron scheduled');
	}

	/** Stop and remove a cron job */
	private unscheduleCron(triggerId: string): void {
		const task = this.cronJobs.get(triggerId);
		if (task) {
			task.stop();
			this.cronJobs.delete(triggerId);
			logger.info({ triggerId }, '[triggers] cron unscheduled');
		}
	}
}
