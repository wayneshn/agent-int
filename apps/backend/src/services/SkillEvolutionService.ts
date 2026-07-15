import * as nodeCron from 'node-cron';
import { eq, and, desc, sql, lt } from 'drizzle-orm';
import { complete, type UserMessage, type TextContent } from '@earendil-works/pi-ai';
import { getSkillCatalogEntry, extractJsonValue } from '@repo/utils';
import { db } from '../db/index.js';
import { agentExecutionTraces, agentEvolvedSkills } from '../db/schema/index.js';
import { AgentService } from './AgentService.js';
import { LlmProviderService } from './LlmProviderService.js';
import { SkillService } from './SkillService.js';
import { resolveAgentModel, buildProviderAuthOptions } from './llm/resolveAgentModel.js';
import { logger } from '../config/logger.js';

// ─── Tunables (env-overridable) ───────────────────────────────────────────────

/** A pair must have at least this many fresh traces to be considered */
const MIN_TRACES = Number(process.env.SKILL_EVOLUTION_MIN_TRACES ?? 5);
/** With zero failures, require this many traces before evolving anyway */
const MIN_TRACES_NO_FAILURE = Number(process.env.SKILL_EVOLUTION_MIN_TRACES_NO_FAILURE ?? 10);
/** Hard cap on reflection LLM calls per cycle */
const MAX_REFLECTIONS_PER_CYCLE = Number(process.env.SKILL_EVOLUTION_MAX_PER_CYCLE ?? 10);
/** Traces included in the reflection prompt */
const MAX_TRACES_IN_PROMPT = 20;
/** Per-trace excerpt cap in the reflection prompt */
const TRACE_EXCERPT_CHARS = 200;
/** Reject improved instructions larger than this */
const MAX_INSTRUCTIONS_BYTES = 32 * 1024;
/** Traces older than this are deleted by the cycle's retention sweep */
const TRACE_RETENTION_DAYS = Number(process.env.SKILL_TRACE_RETENTION_DAYS ?? 30);

const DEFAULT_CRON = '0 */6 * * *'; // every 6 hours

/** One (agentId, skillName) pair with fresh-trace stats from the mining query */
interface EvolutionCandidate {
	agentId: string;
	skillName: string;
	total: number;
	failures: number;
}

/** Shape of the reflection LLM's required JSON reply */
interface ReflectionReply {
	shouldUpdate: boolean;
	reason?: string;
	improvedInstructions?: string;
	changeSummary?: string;
}

/**
 * GEPA-inspired skill evolution engine.
 *
 * Periodically (SKILL_EVOLUTION_CRON, default every 6 hours):
 *   1. Trace mining — group agent_execution_traces by (agentId, skillName),
 *      counting only traces newer than the pair's last evolution.
 *   2. Eligibility — the skill must resolve in the merged catalog with
 *      evolvable === true, still be assigned to the agent, and meet the trace
 *      thresholds (MIN_TRACES fresh traces AND at least one failure, or
 *      MIN_TRACES_NO_FAILURE without failures).
 *   3. Reflection — a single non-streaming complete() call using the agent's
 *      own chat model (resolveAgentModel) proposes improved instructions.
 *   4. Storage — upsert into agent_evolved_skills with version + 1. The
 *      materializer picks the new version up on the agent's next spawn.
 *
 * Safety: evolution NEVER mutates SKILL.md sources or skill_files — evolved
 * instructions live only in agent_evolved_skills, per agent. Reflection output
 * is sanity-capped (non-empty, ≤ 32 KB) and instructed not to contradict
 * system-level safety rules; the runtime's prompt subordination rules still
 * apply on top of whatever the instructions say.
 */
export class SkillEvolutionService {
	private task: nodeCron.ScheduledTask | null = null;
	private cycleRunning = false;

	constructor(
		private readonly agentService: AgentService,
		private readonly llmProviderService: LlmProviderService,
		private readonly skillService: SkillService,
	) {}

	/** Schedule the background worker. Call once after the server starts. */
	start(): void {
		if (process.env.SKILL_EVOLUTION_ENABLED === 'false') {
			logger.info('[skill-evolution] disabled via SKILL_EVOLUTION_ENABLED=false');
			return;
		}

		const schedule = process.env.SKILL_EVOLUTION_CRON ?? DEFAULT_CRON;
		if (!nodeCron.validate(schedule)) {
			logger.error({ schedule }, '[skill-evolution] invalid SKILL_EVOLUTION_CRON — not starting');
			return;
		}

		this.task = nodeCron.schedule(schedule, () => {
			void this.runCycle();
		});
		logger.info({ schedule }, '[skill-evolution] worker scheduled');
	}

	/** Stop the scheduled worker (shutdown). */
	stop(): void {
		this.task?.stop();
		this.task = null;
	}

	/**
	 * One full evolution cycle. Public so it can be invoked manually in dev.
	 * Re-entrancy guarded — overlapping cron ticks are skipped.
	 */
	async runCycle(): Promise<void> {
		if (this.cycleRunning) {
			logger.warn('[skill-evolution] previous cycle still running — skipping tick');
			return;
		}
		this.cycleRunning = true;

		try {
			const candidates = await this.mineCandidates();
			const eligible = candidates
				.filter(
					(c) => c.total >= MIN_TRACES && (c.failures >= 1 || c.total >= MIN_TRACES_NO_FAILURE),
				)
				.slice(0, MAX_REFLECTIONS_PER_CYCLE);

			logger.info(
				{ candidatePairs: candidates.length, eligible: eligible.length },
				'[skill-evolution] cycle started',
			);

			let evolvedCount = 0;
			for (const candidate of eligible) {
				try {
					const evolved = await this.evolvePair(candidate);
					if (evolved) evolvedCount++;
				} catch (err) {
					// One bad pair must never abort the cycle
					logger.warn(
						{ err, agentId: candidate.agentId, skillName: candidate.skillName },
						'[skill-evolution] pair evolution failed (non-fatal)',
					);
				}
			}

			await this.sweepOldTraces();
			logger.info({ evolvedCount }, '[skill-evolution] cycle complete');
		} catch (err) {
			logger.error({ err }, '[skill-evolution] cycle failed');
		} finally {
			this.cycleRunning = false;
		}
	}

	// ─── Step 1: trace mining ───────────────────────────────────────────────────

	/**
	 * Groups traces by (agentId, skillName), counting only traces newer than the
	 * pair's last evolution (all traces when no evolved record exists yet).
	 */
	private async mineCandidates(): Promise<EvolutionCandidate[]> {
		const rows = await db
			.select({
				agentId: agentExecutionTraces.agentId,
				skillName: agentExecutionTraces.skillName,
				total: sql<number>`count(*)::int`,
				failures: sql<number>`(count(*) filter (where ${agentExecutionTraces.success} = false))::int`,
			})
			.from(agentExecutionTraces)
			.leftJoin(
				agentEvolvedSkills,
				and(
					eq(agentEvolvedSkills.agentId, agentExecutionTraces.agentId),
					eq(agentEvolvedSkills.skillName, agentExecutionTraces.skillName),
				),
			)
			.where(
				sql`${agentExecutionTraces.createdAt} > coalesce(${agentEvolvedSkills.updatedAt}, to_timestamp(0))`,
			)
			.groupBy(agentExecutionTraces.agentId, agentExecutionTraces.skillName);

		return rows;
	}

	// ─── Steps 2-4: eligibility, reflection, storage ───────────────────────────

	/** Returns true when a new evolved version was stored */
	private async evolvePair(candidate: EvolutionCandidate): Promise<boolean> {
		const { agentId, skillName } = candidate;

		// Skill must still be assigned to the agent
		const assignment = await this.skillService.getAssignment(agentId, skillName);
		if (!assignment) return false;

		// Skill must be evolvable (builtin frontmatter or skills.evolvable)
		if (assignment.source === 'builtin') {
			const entry = getSkillCatalogEntry(skillName);
			if (!entry?.evolvable) return false;
		} else {
			if (!assignment.skillId) return false;
			const installed = await this.skillService.getInstalledByIdInternal(assignment.skillId);
			if (!installed?.evolvable) return false;
		}

		// Agent must still exist and have a usable chat model
		const agent = await this.agentService.getByIdInternal(agentId);
		if (!agent || !agent.modelConfigId) return false;

		// Current resolved instructions (evolved > base) + current version
		const currentInstructions = await this.skillService.getSkillInstructions(agentId, skillName);
		if (!currentInstructions) return false;
		const existingEvolved = await this.skillService.getEvolvedSkill(agentId, skillName);
		const currentVersion = existingEvolved?.version ?? 0;

		// Fresh traces for the reflection prompt (newest first)
		const traces = await db
			.select()
			.from(agentExecutionTraces)
			.where(
				and(
					eq(agentExecutionTraces.agentId, agentId),
					eq(agentExecutionTraces.skillName, skillName),
				),
			)
			.orderBy(desc(agentExecutionTraces.createdAt))
			.limit(MAX_TRACES_IN_PROMPT);

		const traceLines = traces
			.map((t, i) => {
				const logExcerpt = t.executionLog
					? JSON.stringify(t.executionLog).slice(0, TRACE_EXCERPT_CHARS)
					: 'n/a';
				return `- Trace ${i + 1}: success=${t.success}, toolCalls=${t.toolCallCount}, log: ${logExcerpt}`;
			})
			.join('\n');

		const reflectionPrompt =
			`You are a skill-optimization assistant (GEPA-style reflective mutation).\n\n` +
			`## Current skill instructions (version ${currentVersion})\n` +
			`${currentInstructions}\n\n` +
			`## Execution traces since the last revision\n` +
			`${traceLines}\n\n` +
			`## Task\n` +
			`Analyze the failure patterns and inefficiencies in the traces. Produce an improved ` +
			`version of the instructions that addresses them. Preserve the skill's intent and ` +
			`output format. Do not add instructions that contradict system-level safety rules ` +
			`(workspace boundaries, credential rules, tool restrictions).\n\n` +
			`You MUST respond with valid JSON only (no markdown, no explanation):\n` +
			`{"shouldUpdate":false,"reason":"<why no change is needed>"}\n` +
			`or\n` +
			`{"shouldUpdate":true,"improvedInstructions":"<full improved markdown instructions>","changeSummary":"<one-line summary>"}`;

		// Reflection call — uses the agent's own chat model
		const { model, apiKey } = await resolveAgentModel(
			this.agentService,
			this.llmProviderService,
			agentId,
			agent.ownerId,
		);

		const userMsg: UserMessage = {
			role: 'user',
			content: [{ type: 'text', text: reflectionPrompt } as TextContent],
			timestamp: Date.now(),
		};

		const response = await complete(
			model,
			{
				systemPrompt:
					'You are a skill-optimization assistant. Always respond with valid JSON only, ' +
					'no markdown fencing, no explanation.',
				messages: [userMsg],
				tools: [],
			},
			buildProviderAuthOptions(model, apiKey),
		);

		const rawText = response.content
			.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
			.map((b) => b.text)
			.join('')
			.trim();
		if (!rawText) return false;

		// Recover the JSON value even if the model wrapped it in prose or ```json fences.
		const extracted = extractJsonValue(rawText);
		if (extracted === null) {
			logger.warn(
				{ agentId, skillName, rawText: rawText.slice(0, 200) },
				'[skill-evolution] reflection returned non-JSON — skipping pair',
			);
			return false;
		}
		const parsed = extracted as ReflectionReply;

		if (!parsed.shouldUpdate) {
			logger.debug(
				{ agentId, skillName, reason: parsed.reason },
				'[skill-evolution] reflection: no update needed',
			);
			return false;
		}

		// Sanity caps on the proposed instructions
		const improved = parsed.improvedInstructions?.trim();
		if (!improved) return false;
		if (Buffer.byteLength(improved, 'utf-8') > MAX_INSTRUCTIONS_BYTES) {
			logger.warn(
				{ agentId, skillName },
				'[skill-evolution] improved instructions exceed size cap — rejecting',
			);
			return false;
		}

		const stored = await this.skillService.upsertEvolvedSkill(agentId, skillName, improved);
		logger.info(
			{ agentId, skillName, version: stored.version, changeSummary: parsed.changeSummary },
			'[skill-evolution] skill evolved',
		);
		return true;
	}

	// ─── Retention sweep ────────────────────────────────────────────────────────

	private async sweepOldTraces(): Promise<void> {
		const cutoff = new Date(Date.now() - TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
		const result = await db
			.delete(agentExecutionTraces)
			.where(lt(agentExecutionTraces.createdAt, cutoff));
		if ((result.rowCount ?? 0) > 0) {
			logger.info(
				{ deleted: result.rowCount, retentionDays: TRACE_RETENTION_DAYS },
				'[skill-evolution] old traces swept',
			);
		}
	}
}
