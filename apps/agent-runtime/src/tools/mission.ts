import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { logger } from '@repo/utils';
import type { ToolContext } from './types.js';

/**
 * Mission tools — available only when this turn belongs to a mission (an
 * autonomous wake, or the owner steering-chatting on a mission thread).
 *
 * All calls are authorized host-side by the missionId claim inside the
 * PROXY_TOKEN; the sandbox never chooses which mission it operates on.
 *
 * Registered via createMissionTools() in tools/index.ts when
 * ctx.missionAvailable is true.
 */
export function createMissionTools(ctx: ToolContext): AgentTool[] {
	const text = (t: string): { content: TextContent[]; details: Record<string, never> } => ({
		content: [{ type: 'text', text: t }],
		details: {},
	});

	const updatePlan: AgentTool = {
		name: 'mission_update_plan',
		label: 'Update Mission Plan',
		description:
			'Rewrite your full mission plan/state document. This document is your PERSISTENT MEMORY ' +
			'across wakes — the next wake starts with an empty conversation and sees only the goal, ' +
			'this document, and recent journal entries. Keep it current: strategy, task list with ' +
			'statuses, key learnings, metrics, blockers, and concrete next steps. Replace the WHOLE ' +
			'document each time (it is overwritten, not appended). Update it near the end of every ' +
			'wake and whenever the owner gives you new instructions.',
		parameters: Type.Object({
			plan: Type.String({
				description:
					'The complete new plan document (markdown). Replaces the previous version entirely. ' +
					'Keep it a concise working document — max 50000 characters.',
			}),
		}),
		execute: async (_toolCallId, params) => {
			const { plan } = params as { plan: string };
			await ctx.proxyClient.missionUpdatePlan(plan);
			logger.info({ length: plan.length }, '[agent-runner] mission_update_plan — saved');
			return text(
				'Plan document saved. It will be shown to you at the start of every future wake.',
			);
		},
	};

	const log: AgentTool = {
		name: 'mission_log',
		label: 'Mission Log',
		description:
			'Append an entry to the mission activity journal your owner reads. Log meaningful ' +
			'actions and outcomes ("Posted the launch thread on X — 1.2k views", "Outreach email ' +
			'to journalist Y sent"), decisions, and blockers — NOT routine tool steps. One or two ' +
			'entries per wake is typical.',
		parameters: Type.Object({
			title: Type.String({
				description: 'Short one-line summary of what happened (max 500 characters).',
			}),
			body: Type.Optional(
				Type.String({
					description: 'Optional details, context, or numbers (max 10000 characters).',
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const { title, body } = params as { title: string; body?: string };
			await ctx.proxyClient.missionLog({ title, body });
			return text('Journal entry recorded.');
		},
	};

	const scheduleNextWake: AgentTool = {
		name: 'schedule_next_wake',
		label: 'Schedule Next Wake',
		description:
			'Schedule when you next wake up to continue the mission. Provide an ISO datetime OR a ' +
			'delay in minutes. The host clamps your request to the mission’s configured ' +
			'minimum/maximum interval and returns the ACTUAL scheduled time. Call this near the end ' +
			'of EVERY wake, matched to the work: waiting on replies → hours; monitoring results ' +
			'→ next day; active multi-step work → the minimum interval. If you do not call ' +
			'it, you wake at the fallback cadence (the maximum interval).',
		parameters: Type.Object({
			at: Type.Optional(
				Type.String({
					description: 'ISO 8601 datetime for the next wake (e.g. "2026-07-08T09:00:00Z").',
				}),
			),
			delayMinutes: Type.Optional(
				Type.Number({
					description: 'Delay from now in minutes. Use this OR "at", not both.',
				}),
			),
			reason: Type.Optional(
				Type.String({
					description:
						'Short reason shown in the activity feed (e.g. "waiting for email replies").',
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as { at?: string; delayMinutes?: number; reason?: string };
			const result = await ctx.proxyClient.missionScheduleNextWake(input);
			logger.info({ scheduledAt: result.scheduledAt }, '[agent-runner] schedule_next_wake');
			return text(`Next wake scheduled for ${result.scheduledAt} (after host clamping).`);
		},
	};

	const complete: AgentTool = {
		name: 'mission_complete',
		label: 'Complete Mission',
		description:
			'Mark the mission as COMPLETED — the goal is achieved, or it is permanently unachievable. ' +
			'This stops all future wakes and is irreversible from your side (only the owner can ' +
			'restart it). Do not use it for temporary blockers — use report_to_owner or ' +
			'request_approval for those. Include a thorough final report in the summary.',
		parameters: Type.Object({
			summary: Type.String({
				description:
					'Final report: what was achieved, key results/metrics, and anything the owner should know.',
			}),
		}),
		execute: async (_toolCallId, params) => {
			const { summary } = params as { summary: string };
			await ctx.proxyClient.missionComplete(summary);
			return text(
				'Mission marked as completed. No further wakes will occur. Finish this turn with a short closing note.',
			);
		},
	};

	const report: AgentTool = {
		name: 'report_to_owner',
		label: 'Report to Owner',
		description:
			'Send a proactive progress report to your owner (in-app notification, plus Telegram/Discord ' +
			'when linked). Use it for MILESTONES, important results, and blockers you cannot work ' +
			'around — not for every wake; the owner already sees your mission_log journal. Write it ' +
			'as a message to a busy person: lead with the outcome.',
		parameters: Type.Object({
			title: Type.String({ description: 'Short subject line (max 300 characters).' }),
			message: Type.String({ description: 'The report body (max 8000 characters).' }),
		}),
		execute: async (_toolCallId, params) => {
			const { title, message } = params as { title: string; message: string };
			const result = await ctx.proxyClient.missionReport({ title, message });
			return text(
				`Report delivered via: ${result.delivered.join(', ') || 'nothing (delivery failed)'}.`,
			);
		},
	};

	const requestApproval: AgentTool = {
		name: 'request_approval',
		label: 'Request Approval',
		description:
			'Ask your owner for permission before a risky, irreversible, or outward-facing action ' +
			'(per your approval policy) — e.g. publishing content publicly, registering an account, ' +
			'contacting a real person, committing to anything. This is ASYNCHRONOUS: it returns ' +
			'immediately and the owner decides later in the UI — do NOT perform the action in this ' +
			'wake. The decision appears in your mission context on a future wake. Plan other work ' +
			'meanwhile. Duplicate requests for the same action are wasteful — check your pending ' +
			'approvals in the mission context first.',
		parameters: Type.Object({
			action: Type.String({
				description: 'What you want to do, as a short imperative sentence (max 500 characters).',
			}),
			rationale: Type.String({
				description: 'Why this action serves the mission goal (max 4000 characters).',
			}),
		}),
		execute: async (_toolCallId, params) => {
			const { action, rationale } = params as { action: string; rationale: string };
			const result = await ctx.proxyClient.missionRequestApproval(action, rationale);
			return text(
				`Approval request submitted (id ${result.approvalId}). Do NOT perform the action yet — ` +
					'the owner will decide and you will see the decision in your mission context at a future wake. ' +
					'Continue with other work.',
			);
		},
	};

	return [updatePlan, log, scheduleNextWake, complete, report, requestApproval];
}
