import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { logger } from '@repo/utils';
import type { AgentMission, CreateMissionRequest, UpdateMissionRequest } from '@repo/types';
import type { ToolContext } from './types.js';

/**
 * Mission MANAGEMENT tools — the mission equivalent of the workflow tools
 * (list/read/create/update/control). Available on CHAT turns so the owner can
 * set up and steer missions conversationally ("start a mission to …", "how are
 * my missions doing?", "pause the brand mission").
 *
 * Distinct from the in-mission OPERATING tools (mission_update_plan,
 * schedule_next_wake, …) which only exist DURING a mission wake. All calls are
 * scoped host-side to the token's agentId + ownerId — an agent can only manage
 * its own missions.
 *
 * Registered via createMissionManagementTools() in tools/index.ts when
 * ctx.missionManagementAvailable is true.
 */
export function createMissionManagementTools(ctx: ToolContext): AgentTool[] {
	const text = (t: string): { content: TextContent[]; details: Record<string, never> } => ({
		content: [{ type: 'text', text: t }],
		details: {},
	});

	const missionLink = (id: string): string =>
		ctx.agentId ? `/app/agents/${ctx.agentId}/missions/${id}` : '';

	const summarize = (m: AgentMission): string => {
		const budget = `$${m.costTotal.toFixed(2)}/$${m.maxCostTotal.toFixed(2)}`;
		const next =
			m.status === 'active' && m.nextWakeAt
				? ` · next wake ${new Date(m.nextWakeAt).toISOString()}`
				: '';
		const link = missionLink(m.id);
		return (
			`- **${m.title}** (${m.status}) — budget ${budget}, ${m.totalTurns} wakes${next}\n` +
			`  id: \`${m.id}\`${link ? ` · [open](${link})` : ''}`
		);
	};

	const list: AgentTool = {
		name: 'list_missions',
		label: 'List Missions',
		description:
			'List the long-running autonomous missions for this agent, with each one’s status, ' +
			'budget usage, and next wake time. Use this when the user asks about their missions, ' +
			'or before controlling one so you have the correct mission id.',
		parameters: Type.Object({}),
		execute: async () => {
			const missions = await ctx.proxyClient.listMissions();
			if (missions.length === 0) {
				return text('This agent has no missions yet. You can create one with create_mission.');
			}
			return text(`Missions for this agent:\n${missions.map(summarize).join('\n')}`);
		},
	};

	const read: AgentTool = {
		name: 'read_mission',
		label: 'Read Mission',
		description:
			'Read the full detail of one mission — its goal, status, schedule, budget usage, and ' +
			'current plan document. Always call list_missions first to get the correct missionId.',
		parameters: Type.Object({
			missionId: Type.String({ description: 'The ID of the mission to read.' }),
		}),
		execute: async (_toolCallId, params) => {
			const { missionId } = params as { missionId: string };
			const m = await ctx.proxyClient.readMission(missionId);
			const lines = [
				`# ${m.title} (${m.status})`,
				`Goal: ${m.goal}`,
				`Schedule: ${m.scheduleMode}${m.scheduleMode === 'fixed' ? ` (${m.cronExpr ?? ''})` : ` (${m.minIntervalMinutes}–${m.maxIntervalMinutes} min)`}`,
				`Budget: $${m.costTotal.toFixed(4)} of $${m.maxCostTotal.toFixed(2)} total` +
					(m.maxCostPerDay !== undefined ? `, $${m.maxCostPerDay.toFixed(2)}/day` : '') +
					(m.maxTurnsPerDay !== undefined ? `, ${m.maxTurnsPerDay} wakes/day` : ''),
				`Wakes: ${m.totalTurns} total, ${m.consecutiveFailures} consecutive failures`,
				`Approval policy: ${m.approvalPolicy}`,
				m.planDocument ? `\n## Plan document\n${m.planDocument}` : '\n(No plan document yet.)',
			];
			return text(lines.join('\n'));
		},
	};

	const create: AgentTool = {
		name: 'create_mission',
		label: 'Create Mission',
		description:
			'Create a long-running AUTONOMOUS mission for this agent — a persistent goal it will ' +
			'pursue on its own schedule, waking itself up to plan, act, and report, spending real ' +
			'money (LLM cost) up to the budget you set.\n' +
			'⚠️ Only call this when the user has EXPLICITLY asked to set up a mission. FIRST confirm ' +
			'with the user, in the conversation: (1) the exact goal, and (2) the total USD budget — ' +
			'this is a real spending limit. Do NOT invent a budget silently.\n' +
			'Create it as a DRAFT by default (activate=false) and tell the user to review and start ' +
			'it from the mission page; only set activate=true if the user explicitly said to start it ' +
			'now. After creating, include the returned mission link in your reply.',
		parameters: Type.Object({
			title: Type.String({ description: 'Short mission title (e.g. "Promote the XYZ launch").' }),
			goal: Type.String({
				description:
					'The long-term goal, in detail: the outcome, strategy boundaries, what success looks ' +
					'like, and anything the agent must never do.',
			}),
			maxCostTotal: Type.Number({
				description:
					'Total budget in USD (required). A hard cap — the mission auto-pauses when reached. ' +
					'Confirm this figure with the user first.',
			}),
			maxCostPerDay: Type.Optional(
				Type.Number({ description: 'Optional daily USD cost cap (defers to next day when hit).' }),
			),
			maxTurnsPerDay: Type.Optional(
				Type.Number({ description: 'Optional max number of wakes per day.' }),
			),
			scheduleMode: Type.Optional(
				Type.Union([Type.Literal('agent'), Type.Literal('fixed')], {
					description:
						"'agent' (default) = the agent paces its own wakes between min/max interval; " +
						"'fixed' = wake on a cron schedule.",
				}),
			),
			minIntervalMinutes: Type.Optional(
				Type.Number({ description: 'Agent-paced floor between wakes (default 30).' }),
			),
			maxIntervalMinutes: Type.Optional(
				Type.Number({ description: 'Agent-paced ceiling + fallback cadence (default 1440).' }),
			),
			cronExpr: Type.Optional(
				Type.String({ description: "Cron expression, required when scheduleMode is 'fixed'." }),
			),
			timezone: Type.Optional(
				Type.String({ description: 'IANA timezone (e.g. "America/New_York").' }),
			),
			approvalPolicy: Type.Optional(
				Type.Union([Type.Literal('never'), Type.Literal('risky'), Type.Literal('always')], {
					description:
						"When the agent must ask you before acting: 'risky' (default) = before risky/" +
						"irreversible outward actions; 'always' = every outward action; 'never'.",
				}),
			),
			activate: Type.Optional(
				Type.Boolean({
					description:
						'Start the mission immediately. Leave false (draft) unless the user explicitly ' +
						'approved starting it now.',
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as CreateMissionRequest;
			const mission = await ctx.proxyClient.createMission(input);
			logger.info(
				{ missionId: mission.id, activate: input.activate ?? false },
				'[agent-runner] create_mission',
			);
			const link = missionLink(mission.id);
			return text(
				`Mission "${mission.title}" created as **${mission.status}**` +
					(mission.status === 'active'
						? ' — it will wake for the first time within a minute.'
						: ' (draft). Review and start it from the mission page.') +
					`\nBudget: $${mission.maxCostTotal.toFixed(2)} total.` +
					(link ? `\n[Open the mission](${link})` : '') +
					`\nmissionId: \`${mission.id}\``,
			);
		},
	};

	const update: AgentTool = {
		name: 'update_mission',
		label: 'Update Mission',
		description:
			'Edit an existing mission — its goal, budgets, schedule bounds, or approval policy. ' +
			'Call list_missions/read_mission first for the correct id and current values. Confirm ' +
			'any budget change with the user (it is a real spending limit).',
		parameters: Type.Object({
			missionId: Type.String({ description: 'The ID of the mission to update.' }),
			title: Type.Optional(Type.String({ description: 'New title.' })),
			goal: Type.Optional(
				Type.String({ description: 'New goal text (replaces the previous goal).' }),
			),
			maxCostTotal: Type.Optional(Type.Number({ description: 'New total USD budget.' })),
			maxCostPerDay: Type.Optional(Type.Number({ description: 'New daily USD cost cap.' })),
			maxTurnsPerDay: Type.Optional(Type.Number({ description: 'New max wakes per day.' })),
			minIntervalMinutes: Type.Optional(
				Type.Number({ description: 'New agent-paced floor (minutes).' }),
			),
			maxIntervalMinutes: Type.Optional(
				Type.Number({ description: 'New agent-paced ceiling (minutes).' }),
			),
			approvalPolicy: Type.Optional(
				Type.Union([Type.Literal('never'), Type.Literal('risky'), Type.Literal('always')], {
					description: 'New approval policy.',
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const { missionId, ...rest } = params as { missionId: string } & UpdateMissionRequest;
			const mission = await ctx.proxyClient.updateMission(missionId, rest);
			return text(`Mission "${mission.title}" updated.`);
		},
	};

	const control: AgentTool = {
		name: 'control_mission',
		label: 'Control Mission',
		description:
			'Change a mission’s run state:\n' +
			"- 'activate' — start a draft or resume a paused mission (it begins waking).\n" +
			"- 'pause' — stop future wakes and cancel any wake running right now.\n" +
			"- 'complete' — permanently finish the mission (no more wakes).\n" +
			"- 'wake' — run one wake immediately now (mission must be active).\n" +
			'Call list_missions first for the correct id. Confirm destructive actions ' +
			'(pause/complete) with the user.',
		parameters: Type.Object({
			missionId: Type.String({ description: 'The ID of the mission to control.' }),
			action: Type.Union(
				[
					Type.Literal('activate'),
					Type.Literal('pause'),
					Type.Literal('complete'),
					Type.Literal('wake'),
				],
				{ description: 'The action to take.' },
			),
		}),
		execute: async (_toolCallId, params) => {
			const { missionId, action } = params as {
				missionId: string;
				action: 'activate' | 'pause' | 'complete' | 'wake';
			};
			await ctx.proxyClient.controlMission(missionId, action);
			logger.info({ missionId, action }, '[agent-runner] control_mission');
			const done: Record<typeof action, string> = {
				activate: 'activated — it will wake shortly.',
				pause: 'paused. No further wakes until resumed.',
				complete: 'marked complete. No further wakes.',
				wake: 'woken — a wake is now running.',
			};
			return text(`Mission ${done[action]}`);
		},
	};

	return [list, read, create, update, control];
}
