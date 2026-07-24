import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
	api,
	setupFirstUser,
	createCredential,
	testDbQuery,
	testDatabaseUrl,
	TEST_CREDENTIAL_ENCRYPTION_KEY,
} from '@repo/test-utils';
import { useBackend } from '../helpers/boot.js';

/**
 * Decrypt a credentials row directly (mirrors EncryptionService: iv:tag:payload
 * hex, AES-256-GCM, TEST_CREDENTIAL_ENCRYPTION_KEY). The API never exposes
 * secret values — the strongest preservation check is decrypting the row.
 */
async function readStoredSecret(credentialId: string): Promise<string> {
	const rows = await testDbQuery<{ data: string }>(
		testDatabaseUrl(),
		'SELECT data FROM credentials WHERE id = $1',
		[credentialId],
	);
	expect(rows).toHaveLength(1);
	const [ivHex, tagHex, payloadHex] = rows[0].data.split(':');
	const decipher = crypto.createDecipheriv(
		'aes-256-gcm',
		Buffer.from(TEST_CREDENTIAL_ENCRYPTION_KEY, 'hex'),
		Buffer.from(ivHex, 'hex'),
	);
	decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
	const plaintext = decipher.update(payloadHex, 'hex', 'utf8') + decipher.final('utf8');
	return JSON.parse(plaintext).apiKey;
}

/**
 * Credential CRUD + secret hygiene. Key properties from the review:
 * secrets are write-only (never returned), the __REDACTED__ sentinel
 * preserves stored secrets on update, and unknown types are rejected.
 */

const getServer = useBackend();

describe('credentials', () => {
	it('creates a credential and never returns the secret value', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);

		const created = await createCredential(baseUrl, user.accessToken, {
			type: 'tally-api-key',
			data: { apiKey: 'super-secret-key' },
		});
		expect(created.id).toBeTruthy();
		expect(JSON.stringify(created)).not.toContain('super-secret-key');

		const list = await api.get<{ data?: unknown[] }>(baseUrl, '/v1/credentials', user.accessToken);
		expect(list.status).toBe(200);
		expect(list.body.data).toHaveLength(1);
		expect(JSON.stringify(list.body)).not.toContain('super-secret-key');
	});

	it('rejects unknown credential types', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const res = await api.post(
			baseUrl,
			'/v1/credentials',
			{ name: 'x', type: 'not-a-real-type', data: { apiKey: 'k' } },
			user.accessToken,
		);
		expect(res.status).toBe(400);
	});

	it('rejects missing required properties', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const res = await api.post<{ error?: string }>(
			baseUrl,
			'/v1/credentials',
			{ name: 'x', type: 'tally-api-key', data: {} },
			user.accessToken,
		);
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/Missing required properties/);
	});

	it('update with the redaction sentinel preserves the stored secret', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const credential = await createCredential(baseUrl, user.accessToken, {
			type: 'tally-api-key',
			data: { apiKey: 'original-secret' },
		});

		const updated = await api.put(
			baseUrl,
			`/v1/credentials/${credential.id}`,
			{ name: 'renamed', data: { apiKey: '__REDACTED__' } },
			user.accessToken,
		);
		expect(updated.status).toBe(200);

		// The API only ever shows __REDACTED__ for secret fields — verify the
		// stored plaintext directly in the DB row.
		expect(await readStoredSecret(credential.id as string)).toBe('original-secret');
	});

	it('update with a new value replaces the stored secret', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const credential = await createCredential(baseUrl, user.accessToken, {
			type: 'tally-api-key',
			data: { apiKey: 'original-secret' },
		});

		const updated = await api.put(
			baseUrl,
			`/v1/credentials/${credential.id}`,
			{ data: { apiKey: 'rotated-secret' } },
			user.accessToken,
		);
		expect(updated.status).toBe(200);

		expect(await readStoredSecret(credential.id as string)).toBe('rotated-secret');
	});

	it('deletes a credential', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const credential = await createCredential(baseUrl, user.accessToken, {
			type: 'tally-api-key',
			data: { apiKey: 'k' },
		});

		const del = await api.delete(baseUrl, `/v1/credentials/${credential.id}`, user.accessToken);
		expect([200, 204]).toContain(del.status);

		const list = await api.get<{ data?: unknown[] }>(baseUrl, '/v1/credentials', user.accessToken);
		expect(list.body.data).toEqual([]);
	});
});
