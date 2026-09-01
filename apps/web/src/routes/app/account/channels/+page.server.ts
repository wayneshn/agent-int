import type { PageServerLoad, Actions } from './$types';
import { api } from '$lib/server/api';
import { error, fail } from '@sveltejs/kit';
import type { Agent, ChannelLink, CredentialMetadata } from '@repo/types';

/**
 * Run a server `api()` call and fall back to an empty list on any failure.
 * `api()` throws on non-OK responses; this page aggregates three independent
 * sources, so one failing endpoint shouldn't blank the whole page.
 *
 * The body is read inside this helper, i.e. inside each `Promise.all` branch,
 * rather than after the whole batch settles — see the note in `$lib/server/api`.
 */
async function safeList<T>(request: Promise<Response>): Promise<T[]> {
	try {
		const res = await request;
		const body = await res.json();
		return (body.data ?? []) as T[];
	} catch {
		return [];
	}
}

/**
 * Load the channel links list, the user's agents, and all credentials for the "Connect" dialog.
 * The frontend filters credentials by the selected channel's required credentialType.
 */
export const load: PageServerLoad = async (event) => {
	const ownerId = event.locals.user?.id;
	if (!ownerId) throw error(401, 'Unauthorized');

	// Credentials are passed in full — the frontend filters them by the selected
	// channel's required credentialType.
	const [links, agents, credentials] = await Promise.all([
		safeList<ChannelLink>(api('/channels/links', event)),
		safeList<Agent>(api('/agents', event)),
		safeList<CredentialMetadata>(api('/credentials', event))
	]);

	return { links, agents, credentials };
};

export const actions: Actions = {
	/**
	 * Generate a 6-character one-time pairing code.
	 * Form data: { channel, agentId, credentialId? }
	 */
	generateCode: async (event) => {
		const ownerId = event.locals.user?.id;
		if (!ownerId) return fail(401, { error: 'Unauthorized' });

		const data = await event.request.formData();
		const channel = data.get('channel') as string;
		const agentId = data.get('agentId') as string;
		const credentialId = (data.get('credentialId') as string | null) ?? undefined;

		if (!channel || !agentId) {
			return fail(400, { error: 'channel and agentId are required' });
		}

		try {
			const res = await api('/channels/pairing-codes', event, {
				method: 'POST',
				body: JSON.stringify({ channel, agentId, credentialId })
			});

			const body = await res.json();
			return {
				success: true,
				code: body.data.code as string,
				expiresAt: body.data.expiresAt as string,
				channel
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to generate pairing code';
			return fail(500, { error: message });
		}
	},

	/**
	 * Update mutable settings for a channel link.
	 * Form data: { linkId, agentId?, threadMode?, notifyToolUsage }
	 */
	updateLink: async (event) => {
		const ownerId = event.locals.user?.id;
		if (!ownerId) return fail(401, { error: 'Unauthorized' });

		const data = await event.request.formData();
		const linkId = data.get('linkId') as string;
		if (!linkId) return fail(400, { error: 'linkId is required' });

		const agentId = data.get('agentId') as string | null;
		const threadMode = data.get('threadMode') as string | null;
		const notifyToolUsage = data.get('notifyToolUsage') === 'true';

		const updates: Record<string, unknown> = { notifyToolUsage };
		if (agentId) updates.agentId = agentId;
		if (threadMode) updates.threadMode = threadMode;

		try {
			await api(`/channels/links/${linkId}`, event, {
				method: 'PATCH',
				body: JSON.stringify(updates)
			});
			return { success: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to update channel link';
			return fail(500, { error: message });
		}
	},

	/**
	 * Delete (unpair) a channel link.
	 * Form data: { linkId }
	 */
	deleteLink: async (event) => {
		const ownerId = event.locals.user?.id;
		if (!ownerId) return fail(401, { error: 'Unauthorized' });

		const data = await event.request.formData();
		const linkId = data.get('linkId') as string;
		if (!linkId) return fail(400, { error: 'linkId is required' });

		try {
			await api(`/channels/links/${linkId}`, event, { method: 'DELETE' });
			return { success: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to unpair channel';
			return fail(500, { error: message });
		}
	}
};
