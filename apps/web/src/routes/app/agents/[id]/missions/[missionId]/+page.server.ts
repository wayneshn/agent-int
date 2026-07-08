import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { api } from '$lib/server/api';
import type { Agent, AgentMission, MissionApproval, MissionEvent } from '@repo/types';

/**
 * Load the agent, mission, activity feed, and approvals for the detail page.
 * The page keeps everything fresh client-side with a polling refresh.
 */
export const load: PageServerLoad = async (event) => {
	const { id: agentId, missionId } = event.params;
	const ownerId = event.locals.user?.id;

	if (!ownerId) {
		error(401, 'Unauthorized');
	}

	const [agentRes, missionRes, eventsRes, approvalsRes] = await Promise.all([
		api(`/agents/${agentId}`, event),
		api(`/agents/${agentId}/missions/${missionId}`, event),
		api(`/agents/${agentId}/missions/${missionId}/events?limit=50`, event),
		api(`/agents/${agentId}/missions/${missionId}/approvals`, event)
	]);

	if (!agentRes.ok) {
		error(404, 'Agent not found');
	}
	if (!missionRes.ok) {
		error(404, 'Mission not found');
	}

	const agent = (await agentRes.json()).data as Agent;
	const mission = (await missionRes.json()).data as AgentMission;

	let events: MissionEvent[] = [];
	if (eventsRes.ok) {
		events = ((await eventsRes.json()).data ?? []) as MissionEvent[];
	}
	let approvals: MissionApproval[] = [];
	if (approvalsRes.ok) {
		approvals = ((await approvalsRes.json()).data ?? []) as MissionApproval[];
	}

	return { agent, mission, events, approvals };
};
