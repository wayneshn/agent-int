import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { api } from '$lib/server/api';
import type { McpServer } from '@repo/types';

export const load: PageServerLoad = async (event) => {
	const ownerId = event.locals.user?.id;
	if (!ownerId) {
		error(401, 'Not authenticated');
	}

	const res = await api('/mcp-servers', event);

	let servers: McpServer[] = [];
	if (res.ok) {
		const body = await res.json();
		servers = (body.data ?? []) as McpServer[];
	}

	return { servers };
};
