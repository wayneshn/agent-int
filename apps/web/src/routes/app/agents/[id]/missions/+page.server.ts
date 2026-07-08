import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { api } from '$lib/server/api';
import type { Agent, AgentMission } from '@repo/types';

/**
 * Load the agent and its missions for the mission list page.
 */
export const load: PageServerLoad = async (event) => {
	const { id: agentId } = event.params;
	const ownerId = event.locals.user?.id;

	if (!ownerId) {
		error(401, 'Unauthorized');
	}

	const [agentRes, missionsRes] = await Promise.all([
		api(`/agents/${agentId}`, event),
		api(`/agents/${agentId}/missions`, event)
	]);

	if (!agentRes.ok) {
		error(404, 'Agent not found');
	}

	const agent = (await agentRes.json()).data as Agent;

	let missions: AgentMission[] = [];
	if (missionsRes.ok) {
		missions = ((await missionsRes.json()).data ?? []) as AgentMission[];
	}

	return { agent, missions };
};
