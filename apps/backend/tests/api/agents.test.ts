import { describe, it, expect } from 'vitest';
import { api, setupFirstUser, createAgent, createCredential } from '@repo/test-utils';
import { useBackend } from '../helpers/boot.js';

/** Agent CRUD + credential assignment scoping. */

const getServer = useBackend();

describe('agents', () => {
	it('creates, reads, updates, and deletes an agent', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);

		const agent = await createAgent(baseUrl, user.accessToken, { name: 'Researcher' });
		expect(agent.id).toBeTruthy();

		const read = await api.get<{ data?: { name?: string } }>(
			baseUrl,
			`/v1/agents/${agent.id}`,
			user.accessToken,
		);
		expect(read.status).toBe(200);
		expect(read.body.data?.name).toBe('Researcher');

		const updated = await api.put(
			baseUrl,
			`/v1/agents/${agent.id}`,
			{ description: 'does research' },
			user.accessToken,
		);
		expect(updated.status).toBe(200);

		const del = await api.delete(baseUrl, `/v1/agents/${agent.id}`, user.accessToken);
		expect([200, 204]).toContain(del.status);
		const gone = await api.get(baseUrl, `/v1/agents/${agent.id}`, user.accessToken);
		expect(gone.status).toBe(404);
	});

	it('requires a name', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const res = await api.post(baseUrl, '/v1/agents', { description: 'no name' }, user.accessToken);
		expect(res.status).toBe(400);
	});

	it('assigns credentials to an agent and round-trips the assignment', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const credential = await createCredential(baseUrl, user.accessToken, {
			type: 'tally-api-key',
			data: { apiKey: 'k' },
		});

		const agent = await createAgent(baseUrl, user.accessToken, {
			credentialIds: [credential.id as string],
		});

		const read = await api.get<{ data?: { credentialIds?: string[] } }>(
			baseUrl,
			`/v1/agents/${agent.id}`,
			user.accessToken,
		);
		expect(read.status).toBe(200);
		expect(read.body.data?.credentialIds).toContain(credential.id);
	});
});
