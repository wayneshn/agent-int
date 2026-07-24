/**
 * API factories for tests — thin fetch wrappers over the booted backend.
 * Each returns { status, body } so tests can assert on both success and failure.
 */

export interface ApiResult<T = any> {
	status: number;
	body: T;
}

async function request<T = unknown>(
	baseUrl: string,
	method: string,
	path: string,
	opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
	const res = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
			...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
			...(opts.headers ?? {}),
		},
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
	});
	const text = await res.text();
	let parsed: unknown = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	return { status: res.status, body: parsed as T };
}

export const api = {
	get: <T = any>(baseUrl: string, path: string, token?: string) =>
		request<T>(baseUrl, 'GET', path, { token }),
	post: <T = any>(baseUrl: string, path: string, body?: unknown, token?: string) =>
		request<T>(baseUrl, 'POST', path, { body, token }),
	put: <T = any>(baseUrl: string, path: string, body?: unknown, token?: string) =>
		request<T>(baseUrl, 'PUT', path, { body, token }),
	delete: <T = any>(baseUrl: string, path: string, token?: string) =>
		request<T>(baseUrl, 'DELETE', path, { token }),
};

export interface TestUser {
	email: string;
	password: string;
	/** User id from the login response. */
	id: string;
	accessToken: string;
}

let userCounter = 0;

/**
 * Create the first (admin) user via /v1/auth/setup and log in.
 * Only valid when the users table is empty — call after truncateAll().
 */
export async function setupFirstUser(baseUrl: string): Promise<TestUser> {
	const email = `admin-${++userCounter}@test.local`;
	const password = 'test-password-123';
	const setup = await api.post(baseUrl, '/v1/auth/setup', { email, password });
	if (setup.status !== 201) {
		throw new Error(`setup failed: ${setup.status} ${JSON.stringify(setup.body)}`);
	}
	return loginUser(baseUrl, email, password);
}

/**
 * Create an additional user through the admin users endpoint (requires a roleId).
 * Requires an admin's access token (the first user is Super Admin). Picks the
 * first non-admin role available.
 */
export async function createUser(
	baseUrl: string,
	adminToken: string,
	overrides: { email?: string; password?: string } = {},
): Promise<TestUser> {
	const email = overrides.email ?? `user-${++userCounter}@test.local`;
	const password = overrides.password ?? 'test-password-123';

	const roles = await api.get<{ data?: Array<{ id: string; name?: string }> }>(
		baseUrl,
		'/v1/iam/roles',
		adminToken,
	);
	const roleList = roles.body.data ?? [];
	const role = roleList.find((r) => !/admin/i.test(r.name ?? '')) ?? roleList[0];
	if (!role) {
		throw new Error(`no roles available for createUser: ${JSON.stringify(roles.body)}`);
	}

	const created = await api.post(
		baseUrl,
		'/v1/users',
		{ email, password, roleId: role.id },
		adminToken,
	);
	if (created.status !== 201 && created.status !== 200) {
		throw new Error(`create user failed: ${created.status} ${JSON.stringify(created.body)}`);
	}
	return loginUser(baseUrl, email, password);
}

/** Log in and return the token-bearing TestUser. */
export async function loginUser(
	baseUrl: string,
	email: string,
	password: string,
): Promise<TestUser> {
	const login = await api.post<{ success: boolean; data?: { accessToken: string; user: { id: string } } }>(
		baseUrl,
		'/v1/auth/login',
		{ email, password },
	);
	if (login.status !== 200 || !login.body?.data) {
		throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
	}
	return {
		email,
		password,
		id: login.body.data.user.id,
		accessToken: login.body.data.accessToken,
	};
}

interface CreatedResource {
	id: string;
	[key: string]: unknown;
}

function unwrap<T extends CreatedResource>(result: ApiResult<{ data?: T }>, what: string): T {
	if (!result.body?.data?.id) {
		throw new Error(`${what} creation failed: ${result.status} ${JSON.stringify(result.body)}`);
	}
	return result.body.data;
}

/** Create an agent; returns the created agent row (as exposed by the API). */
export async function createAgent(
	baseUrl: string,
	token: string,
	input: {
		name?: string;
		description?: string;
		credentialIds?: string[];
		modelConfigId?: string;
		embeddingModelConfigId?: string;
	} = {},
): Promise<CreatedResource> {
	const result = await api.post<{ data?: CreatedResource }>(
		baseUrl,
		'/v1/agents',
		{ name: input.name ?? `agent-${++userCounter}`, ...input },
		token,
	);
	return unwrap(result, 'agent');
}

/** Create a credential of a known definition type; returns the created credential. */
export async function createCredential(
	baseUrl: string,
	token: string,
	input: { type: string; name?: string; data: Record<string, unknown> },
): Promise<CreatedResource> {
	const result = await api.post<{ data?: CreatedResource }>(
		baseUrl,
		'/v1/credentials',
		{ name: input.name ?? `cred-${++userCounter}`, type: input.type, data: input.data },
		token,
	);
	return unwrap(result, 'credential');
}

/** Create a thread for an agent via the runtime route. */
export async function createThread(
	baseUrl: string,
	token: string,
	agentId: string,
): Promise<CreatedResource> {
	const result = await api.post<{ data?: CreatedResource }>(
		baseUrl,
		`/v1/runtime/${agentId}/threads`,
		{},
		token,
	);
	return unwrap(result, 'thread');
}
