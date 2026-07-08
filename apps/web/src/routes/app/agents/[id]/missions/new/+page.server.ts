import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { api } from '$lib/server/api';
import type { Agent, AgentMission, ChannelLink } from '@repo/types';

/**
 * Load the agent, the owner's channel links (report delivery targets), and —
 * in edit mode (?id=<missionId>) — the existing mission to pre-fill the form.
 */
export const load: PageServerLoad = async (event) => {
	const { id: agentId } = event.params;
	const ownerId = event.locals.user?.id;

	if (!ownerId) {
		error(401, 'Unauthorized');
	}

	const missionId = event.url.searchParams.get('id');

	const [agentRes, linksRes, missionRes] = await Promise.all([
		api(`/agents/${agentId}`, event),
		api(`/channels/links`, event),
		missionId ? api(`/agents/${agentId}/missions/${missionId}`, event) : Promise.resolve(null)
	]);

	if (!agentRes.ok) {
		error(404, 'Agent not found');
	}

	const agent = (await agentRes.json()).data as Agent;

	let channelLinks: ChannelLink[] = [];
	if (linksRes.ok) {
		channelLinks = ((await linksRes.json()).data ?? []) as ChannelLink[];
	}

	let mission: AgentMission | null = null;
	if (missionRes) {
		if (!missionRes.ok) {
			error(404, 'Mission not found');
		}
		mission = (await missionRes.json()).data as AgentMission;
	}

	return { agent, channelLinks, mission };
};
