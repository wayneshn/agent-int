import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
	api,
	setupFirstUser,
	createAgent,
	createCredential,
	createThread,
	mintProxyToken,
	mintProxyRefreshToken,
} from '@repo/test-utils';
import { useBackend } from '../helpers/boot.js';

/**
 * Sandbox-internal route security (/v1/runtime/internal/*, PROXY_TOKEN-gated).
 * Behavior verified correct in the security review — these are regression pins:
 *   - refresh tokens are never accepted as access tokens
 *   - the sandbox can only touch its own thread
 *   - credential use is bounded by the token allowlist AND a live DB check
 */

const getServer = useBackend();

async function proxyCall(
	baseUrl: string,
	token: string,
	body: Record<string, unknown>,
): Promise<{ status: number; body: { success?: boolean; error?: string } | null }> {
	const res = await fetch(`${baseUrl}/v1/runtime/internal/proxy`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

describe('internal auth middleware', () => {
	it('rejects requests without a PROXY_TOKEN', async () => {
		const { baseUrl } = getServer();
		const res = await fetch(`${baseUrl}/v1/runtime/internal/config`);
		expect(res.status).toBe(401);
	});

	it('rejects garbage tokens', async () => {
		const { baseUrl } = getServer();
		const res = await fetch(`${baseUrl}/v1/runtime/internal/config`, {
			headers: { authorization: 'Bearer not-a-jwt' },
		});
		expect(res.status).toBe(401);
	});

	it('rejects refresh tokens on /internal/* (type separation)', async () => {
		const { baseUrl } = getServer();
		const refresh = await mintProxyRefreshToken({
			agentId: randomUUID(),
			ownerId: randomUUID(),
			threadId: randomUUID(),
		});
		const res = await fetch(`${baseUrl}/v1/runtime/internal/config`, {
			headers: { authorization: `Bearer ${refresh}` },
		});
		expect(res.status).toBe(401);
	});

	it('refresh-token exchange mints a scoped access token', async () => {
		const { baseUrl } = getServer();
		const claims = { agentId: randomUUID(), ownerId: randomUUID(), threadId: randomUUID() };
		const refresh = await mintProxyRefreshToken(claims);
		const res = await api.post<{ data?: { proxyToken?: string } }>(
			baseUrl,
			'/v1/runtime/refresh-token',
			undefined,
			refresh,
		);
		expect(res.status).toBe(200);
		expect(res.body.data?.proxyToken).toBeTruthy();
	});

	it('refresh-token exchange rejects access tokens', async () => {
		const { baseUrl } = getServer();
		const access = await mintProxyToken({
			agentId: randomUUID(),
			ownerId: randomUUID(),
			threadId: randomUUID(),
		});
		const res = await api.post(baseUrl, '/v1/runtime/refresh-token', undefined, access);
		expect(res.status).toBe(401);
	});
});

describe('thread scoping', () => {
	it('rejects access to a thread other than the token\'s own', async () => {
		const { baseUrl } = getServer();
		const token = await mintProxyToken({
			agentId: randomUUID(),
			ownerId: randomUUID(),
			threadId: randomUUID(),
		});
		const otherThread = randomUUID();
		const res = await fetch(`${baseUrl}/v1/runtime/internal/thread/${otherThread}/messages`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(403);
	});

	it('serves the token\'s own thread history', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const agent = await createAgent(baseUrl, user.accessToken);
		const thread = await createThread(baseUrl, user.accessToken, agent.id as string);

		const token = await mintProxyToken({
			agentId: agent.id as string,
			ownerId: user.id,
			threadId: thread.id as string,
		});
		const res = await fetch(`${baseUrl}/v1/runtime/internal/thread/${thread.id}/messages`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { success: boolean; data: unknown[] };
		expect(body.success).toBe(true);
		expect(Array.isArray(body.data)).toBe(true);
	});
});

describe('credential proxy authorization (allowlist + live DB check)', () => {
	it('rejects credentials outside the token allowlist', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const credential = await createCredential(baseUrl, user.accessToken, {
			type: 'tally-api-key',
			data: { apiKey: 'k' },
		});
		const agent = await createAgent(baseUrl, user.accessToken, {
			credentialIds: [credential.id as string],
		});
		const thread = await createThread(baseUrl, user.accessToken, agent.id as string);

		// Token snapshots an EMPTY allowlist — credential is off-limits
		const token = await mintProxyToken({
			agentId: agent.id as string,
			ownerId: user.id,
			threadId: thread.id as string,
			credentialIds: [],
		});
		const res = await proxyCall(baseUrl, token, {
			method: 'GET',
			url: 'https://api.tally.so/example',
			credentialId: credential.id,
		});
		expect(res.status).toBe(400);
		expect(res.body?.success).toBe(false);
	});

	it('rejects a credential revoked (unlinked) after the token was issued', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const credential = await createCredential(baseUrl, user.accessToken, {
			type: 'tally-api-key',
			data: { apiKey: 'k' },
		});
		const agent = await createAgent(baseUrl, user.accessToken, {
			credentialIds: [credential.id as string],
		});
		const thread = await createThread(baseUrl, user.accessToken, agent.id as string);

		// Token snapshots the credential as allowed…
		const token = await mintProxyToken({
			agentId: agent.id as string,
			ownerId: user.id,
			threadId: thread.id as string,
			credentialIds: [credential.id as string],
		});

		// …then the owner unlinks it — the live DB check must deny immediately
		const unlink = await api.put(
			baseUrl,
			`/v1/agents/${agent.id}`,
			{ credentialIds: [] },
			user.accessToken,
		);
		expect(unlink.status).toBe(200);

		const res = await proxyCall(baseUrl, token, {
			method: 'GET',
			url: 'https://api.tally.so/example',
			credentialId: credential.id,
		});
		expect(res.status).toBe(400);
		expect(res.body?.success).toBe(false);
	});

	it('rejects credentials belonging to another owner even when claimed in the token', async () => {
		const { baseUrl } = getServer();
		const userA = await setupFirstUser(baseUrl);
		const credential = await createCredential(baseUrl, userA.accessToken, {
			type: 'tally-api-key',
			data: { apiKey: 'k' },
		});
		// A token for a DIFFERENT agent+owner that claims A's credential
		const token = await mintProxyToken({
			agentId: randomUUID(),
			ownerId: randomUUID(),
			threadId: randomUUID(),
			credentialIds: [credential.id as string],
		});
		const res = await proxyCall(baseUrl, token, {
			method: 'GET',
			url: 'https://api.tally.so/example',
			credentialId: credential.id,
		});
		expect(res.status).toBe(400);
		expect(res.body?.success).toBe(false);
	});
});
