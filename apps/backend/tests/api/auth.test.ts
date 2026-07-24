import { describe, it, expect } from 'vitest';
import { api, setupFirstUser, loginUser } from '@repo/test-utils';
import { useBackend } from '../helpers/boot.js';

/** Auth lifecycle: setup → login → profile → password change. */

const getServer = useBackend();

describe('setup and login', () => {
	it('reports needsSetup on a fresh install, then blocks setup after the first user', async () => {
		const { baseUrl } = getServer();

		const before = await api.get<{ data?: { needsSetup?: boolean } }>(baseUrl, '/v1/auth/status');
		expect(before.body.data?.needsSetup).toBe(true);

		const setup = await api.post(baseUrl, '/v1/auth/setup', {
			email: 'admin@test.local',
			password: 'password-123',
		});
		expect(setup.status).toBe(201);

		const again = await api.post(baseUrl, '/v1/auth/setup', {
			email: 'second@test.local',
			password: 'password-123',
		});
		expect(again.status).toBe(403);

		const after = await api.get<{ data?: { needsSetup?: boolean } }>(baseUrl, '/v1/auth/status');
		expect(after.body.data?.needsSetup).toBe(false);
	});

	it('setup requires email and password', async () => {
		const { baseUrl } = getServer();
		const res = await api.post(baseUrl, '/v1/auth/setup', { email: 'x@test.local' });
		expect(res.status).toBe(400);
	});

	it('login succeeds with valid credentials and returns a usable token', async () => {
		const { baseUrl } = getServer();
		await setupFirstUser(baseUrl);
		const user = await loginUser(baseUrl, 'admin-1@test.local', 'test-password-123');
		expect(user.accessToken).toBeTruthy();

		const profile = await api.get<{ data?: { email?: string } }>(
			baseUrl,
			'/v1/users/profile',
			user.accessToken,
		);
		expect(profile.status).toBe(200);
		expect(profile.body.data?.email).toBe('admin-1@test.local');
	});

	it('login failures are uniform (no user enumeration)', async () => {
		const { baseUrl } = getServer();
		await setupFirstUser(baseUrl);

		const wrongPassword = await api.post(baseUrl, '/v1/auth/login', {
			email: 'admin-1@test.local',
			password: 'wrong',
		});
		const unknownUser = await api.post(baseUrl, '/v1/auth/login', {
			email: 'nobody@test.local',
			password: 'wrong',
		});

		expect(wrongPassword.status).toBe(401);
		expect(unknownUser.status).toBe(401);
		expect(wrongPassword.body).toEqual(unknownUser.body);
	});

	it('rejects requests without a token and with a malformed token', async () => {
		const { baseUrl } = getServer();
		const noToken = await api.get(baseUrl, '/v1/users/profile');
		expect(noToken.status).toBe(401);

		const res = await fetch(`${baseUrl}/v1/users/profile`, {
			headers: { authorization: 'Bearer garbage' },
		});
		expect(res.status).toBe(401);
	});
});

describe('password change', () => {
	it('changes the password with the correct current password', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);

		const change = await api.post(
			baseUrl,
			'/v1/users/profile/password',
			{ currentPassword: 'test-password-123', newPassword: 'new-password-456' },
			user.accessToken,
		);
		expect(change.status).toBe(200);

		// Old password no longer works; new one does
		const oldLogin = await api.post(baseUrl, '/v1/auth/login', {
			email: user.email,
			password: 'test-password-123',
		});
		expect(oldLogin.status).toBe(401);
		const newLogin = await api.post(baseUrl, '/v1/auth/login', {
			email: user.email,
			password: 'new-password-456',
		});
		expect(newLogin.status).toBe(200);
	});

	it('rejects a wrong current password', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		const change = await api.post(
			baseUrl,
			'/v1/users/profile/password',
			{ currentPassword: 'not-the-password', newPassword: 'new-password-456' },
			user.accessToken,
		);
		expect(change.status).toBe(400);
	});
});
