import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from '@playwright/test';
import {
	api,
	truncateAll,
	testDatabaseUrl,
	setupFirstUser,
	createAgent,
	FakeLlmServer,
	type TestUser,
} from '@repo/test-utils';
import { E2E_BACKEND_URL, E2E_WEB_URL } from './ports.js';

/**
 * Shared e2e fixture helpers. Each spec file is self-contained: it truncates
 * the test DB and seeds its own fixtures via the backend API (fast), then
 * drives the UI (the thing under test). Files run serially (workers: 1).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** agent-runtime entry — required for agent-turn e2e; built by `pnpm build`. */
export const RUNTIME_ENTRY = path.resolve(__dirname, '../../agent-runtime/dist/index.js');
export const RUNTIME_ENTRY_BUILT = existsSync(RUNTIME_ENTRY);

/** Wipe the DB and create the first (admin) user via the real setup endpoint. */
export async function resetAndSeedUser(): Promise<TestUser> {
	await truncateAll(testDatabaseUrl());
	return setupFirstUser(E2E_BACKEND_URL);
}

/**
 * Authenticate a browser context without driving the login form — injects the
 * accessToken cookie exactly as the client-side auth store sets it on login.
 * Use the form-based flow only in the spec that tests login itself.
 */
export async function loginViaCookie(context: BrowserContext, accessToken: string): Promise<void> {
	await context.addCookies([
		{
			name: 'accessToken',
			value: accessToken,
			url: E2E_WEB_URL,
			// Mirrors auth.store.ts: samesite=lax (path defaults to / via the url)
			sameSite: 'Lax',
		},
	]);
}

/** Create an LLM provider config pointing at the given fake LLM server. */
export async function createFakeLlmProvider(
	token: string,
	fakeLlm: FakeLlmServer,
): Promise<string> {
	// 'openrouter' maps to the OpenAI-compatible chat-completions API (the fake
	// LLM implements it); 'openai' would use the Responses API instead.
	const res = await api.post<{ data?: { id: string } }>(
		E2E_BACKEND_URL,
		'/v1/llm-providers',
		{
			provider: 'openrouter',
			name: 'e2e-fake',
			model: 'gpt-4o-mini',
			isDefault: true,
			data: { apiKey: 'fake-key', baseUrl: fakeLlm.url },
		},
		token,
	);
	if (res.status !== 201 || !res.body.data?.id) {
		throw new Error(`llm provider creation failed: ${res.status} ${JSON.stringify(res.body)}`);
	}
	return res.body.data.id;
}

/** Create an agent wired to the given LLM provider config. */
export async function createTestAgent(token: string, modelConfigId: string): Promise<string> {
	const agent = await createAgent(E2E_BACKEND_URL, token, {
		name: 'e2e-agent',
		modelConfigId,
	});
	return agent.id as string;
}

/** Create a chat thread for an agent and return its id. */
export async function createTestThread(token: string, agentId: string): Promise<string> {
	const res = await api.post<{ data?: { id: string } }>(
		E2E_BACKEND_URL,
		`/v1/runtime/${agentId}/threads`,
		{},
		token,
	);
	if (!res.body.data?.id) {
		throw new Error(`thread creation failed: ${res.status} ${JSON.stringify(res.body)}`);
	}
	return res.body.data.id;
}

/**
 * Wait until a thread's turn fully ends (status leaves 'running'). Necessary
 * between consecutive turns: the assistant reply is persisted BEFORE turn-end
 * cleanup finishes, and sending the next message mid-cleanup makes the runtime
 * load a history ending in an assistant message ("Cannot continue from message
 * role: assistant"). The UI hides this by locking the input while busy.
 */
export async function waitForThreadIdle(
	token: string,
	agentId: string,
	threadId: string,
	timeoutMs = 90_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await api.get<{ data?: Array<{ id: string; status?: string }> }>(
			E2E_BACKEND_URL,
			`/v1/runtime/${agentId}/threads`,
			token,
		);
		const thread = (res.body.data ?? []).find((t) => t.id === threadId);
		if (thread && thread.status !== 'running') return;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`thread ${threadId} still running after ${timeoutMs}ms`);
}
