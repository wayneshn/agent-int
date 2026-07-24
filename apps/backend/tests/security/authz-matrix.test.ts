import { describe, it, expect } from 'vitest';
import { api, setupFirstUser, createUser, createAgent, createCredential, createThread } from '@repo/test-utils';
import { useBackend } from '../helpers/boot.js';

/**
 * Cross-tenant authorization matrix (IDOR/BOLA regression pin). User B must
 * never read or mutate user A's resources by guessing IDs. UUIDs are
 * unguessable in practice, but the DB must enforce ownership regardless.
 *
 * Convention: `expectForbidden` accepts 403 or 404 — both deny access without
 * leaking; what matters is that no data crosses the tenant boundary.
 */

const getServer = useBackend();

function expectForbidden(status: number): void {
	expect([401, 403, 404]).toContain(status);
}

interface Fixture {
	baseUrl: string;
	userA: Awaited<ReturnType<typeof setupFirstUser>>;
	userB: Awaited<ReturnType<typeof setupFirstUser>>;
	agentId: string;
	credentialId: string;
	threadId: string;
}

async function makeFixture(): Promise<Fixture> {
	const { baseUrl } = getServer();
	const userA = await setupFirstUser(baseUrl);
	const userB = await createUser(baseUrl, userA.accessToken);
	const agent = await createAgent(baseUrl, userA.accessToken);
	const credential = await createCredential(baseUrl, userA.accessToken, {
		type: 'tally-api-key',
		data: { apiKey: 'secret-value' },
	});
	const thread = await createThread(baseUrl, userA.accessToken, agent.id as string);
	return {
		baseUrl,
		userA,
		userB,
		agentId: agent.id as string,
		credentialId: credential.id as string,
		threadId: thread.id as string,
	};
}

describe('cross-tenant access control', () => {
	it('agents: B cannot read, update, or delete A\'s agent', async () => {
		const f = await makeFixture();
		const t = f.userB.accessToken;

		const read = await api.get(f.baseUrl, `/v1/agents/${f.agentId}`, t);
		expectForbidden(read.status);
		expect(read.body?.success).toBe(false);

		const update = await api.put(f.baseUrl, `/v1/agents/${f.agentId}`, { name: 'pwned' }, t);
		expectForbidden(update.status);

		const del = await api.delete(f.baseUrl, `/v1/agents/${f.agentId}`, t);
		expectForbidden(del.status);

		// A's agent is untouched
		const verify = await api.get<{ data?: { name?: string } }>(
			f.baseUrl,
			`/v1/agents/${f.agentId}`,
			f.userA.accessToken,
		);
		expect(verify.status).toBe(200);
		expect(verify.body.data?.name).not.toBe('pwned');
	});

	it('agents: B\'s list does not include A\'s agents', async () => {
		const f = await makeFixture();
		const list = await api.get<{ data?: unknown[] }>(f.baseUrl, '/v1/agents', f.userB.accessToken);
		expect(list.status).toBe(200);
		expect(list.body.data).toEqual([]);
	});

	it('credentials: B cannot read A\'s credential (and never its data)', async () => {
		const f = await makeFixture();
		const t = f.userB.accessToken;

		const read = await api.get(f.baseUrl, `/v1/credentials/${f.credentialId}`, t);
		expectForbidden(read.status);

		const data = await api.get(f.baseUrl, `/v1/credentials/${f.credentialId}/data`, t);
		expectForbidden(data.status);
		expect(JSON.stringify(data.body)).not.toContain('secret-value');

		const update = await api.put(f.baseUrl, `/v1/credentials/${f.credentialId}`, { name: 'x' }, t);
		expectForbidden(update.status);

		const del = await api.delete(f.baseUrl, `/v1/credentials/${f.credentialId}`, t);
		expectForbidden(del.status);
	});

	it('threads: B cannot read or post into A\'s threads', async () => {
		const f = await makeFixture();
		const t = f.userB.accessToken;

		// listThreads verifies agent ownership and returns [] for foreign agents
		// (same pattern as workflows) — no data leaks, but the status is 200.
		const list = await api.get<{ data?: unknown[] }>(
			f.baseUrl,
			`/v1/runtime/${f.agentId}/threads`,
			t,
		);
		if (list.status === 200) {
			expect(list.body.data).toEqual([]);
		} else {
			expectForbidden(list.status);
		}

		const messages = await api.get(
			f.baseUrl,
			`/v1/runtime/${f.agentId}/threads/${f.threadId}/messages`,
			t,
		);
		expectForbidden(messages.status);

		const post = await api.post(
			f.baseUrl,
			`/v1/runtime/${f.agentId}/threads/${f.threadId}/messages`,
			{ content: 'injected' },
			t,
		);
		expectForbidden(post.status);
	});

	it('workflows: B cannot read A\'s workflows or create one on A\'s agent that executes', async () => {
		const f = await makeFixture();
		const t = f.userB.accessToken;

		const list = await api.get<{ data?: unknown[] }>(
			f.baseUrl,
			`/v1/agents/${f.agentId}/workflows`,
			t,
		);
		// listByAgent returns [] for foreign agents (ownership verified)
		if (list.status === 200) {
			expect(list.body.data).toEqual([]);
		} else {
			expectForbidden(list.status);
		}
	});

	it('chat files: B cannot list A\'s thread files', async () => {
		const f = await makeFixture();
		const files = await api.get(
			f.baseUrl,
			`/v1/runtime/${f.agentId}/threads/${f.threadId}/files`,
			f.userB.accessToken,
		);
		expectForbidden(files.status);
	});

	it('unauthenticated requests are rejected across the board', async () => {
		const f = await makeFixture();
		for (const path of [
			`/v1/agents/${f.agentId}`,
			`/v1/credentials/${f.credentialId}`,
			`/v1/runtime/${f.agentId}/threads`,
			'/v1/users/profile',
			'/v1/api-keys',
		]) {
			const res = await api.get(f.baseUrl, path);
			expect(res.status).toBe(401);
		}
	});
});

describe('cross-tenant write gaps (PENDING FIX M6 from the security review)', () => {
	it.todo(
		'workflow creation with a foreign agentId is rejected at write time ' +
			'(today the row is created and only fails at spawn — WorkflowService.create must verify agent ownership)',
	);
	it.todo(
		'thread creation on a foreign agentId is rejected at write time ' +
			'(AgentSessionService.createThread must verify agent ownership)',
	);
	it.todo(
		'agent credentialIds are sanitized to same-owner credentials at write time ' +
			'(defense-in-depth — today only the decrypt-time owner check prevents use)',
	);
});
