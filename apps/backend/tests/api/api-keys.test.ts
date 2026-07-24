import { describe, it, expect } from 'vitest';
import { api, setupFirstUser } from '@repo/test-utils';
import { useBackend } from '../helpers/boot.js';

/** API key lifecycle: create (shown once) → list (masked) → use → revoke. */

const getServer = useBackend();

describe('API keys', () => {
	it('creates a key, shows it once, and lists it masked', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);

		const created = await api.post<{ data?: { key?: string } }>(
			baseUrl,
			'/v1/api-keys',
			{ name: 'ci-key', expiresInDays: 30 },
			user.accessToken,
		);
		expect(created.status).toBe(201);
		const rawKey = created.body.data?.key;
		expect(rawKey).toBeTruthy();

		const list = await api.get<{ data?: Array<{ maskedKey?: string; key?: string }> }>(
			baseUrl,
			'/v1/api-keys',
			user.accessToken,
		);
		expect(list.status).toBe(200);
		expect(list.body.data).toHaveLength(1);
		// The raw key must never appear in listings
		expect(JSON.stringify(list.body)).not.toContain(rawKey!);
	});

	it('authenticates requests with an API key (X-Api-Key header)', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const created = await api.post<{ data?: { key?: string } }>(
			baseUrl,
			'/v1/api-keys',
			{ name: 'ci-key', expiresInDays: 30 },
			user.accessToken,
		);
		const rawKey = created.body.data!.key!;

		const res = await fetch(`${baseUrl}/v1/users/profile`, {
			headers: { 'x-api-key': rawKey },
		});
		expect(res.status).toBe(200);
	});

	it('revoked keys stop working', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const created = await api.post<{ data?: { key?: string } }>(
			baseUrl,
			'/v1/api-keys',
			{ name: 'ci-key', expiresInDays: 30 },
			user.accessToken,
		);
		const rawKey = created.body.data!.key!;

		const list = await api.get<{ data?: Array<{ id: string }> }>(
			baseUrl,
			'/v1/api-keys',
			user.accessToken,
		);
		const keyId = list.body.data![0].id;
		const del = await api.delete(baseUrl, `/v1/api-keys/${keyId}`, user.accessToken);
		expect([200, 204]).toContain(del.status);

		const res = await fetch(`${baseUrl}/v1/users/profile`, {
			headers: { 'x-api-key': rawKey },
		});
		expect(res.status).toBe(401);
	});

	it('requires name and expiresInDays', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const res = await api.post(baseUrl, '/v1/api-keys', { name: 'x' }, user.accessToken);
		expect(res.status).toBe(400);
	});

	it.todo(
		'expiresInDays is range-validated (PENDING FIX L8 — today 1e9 or negative values are accepted)',
	);
});
