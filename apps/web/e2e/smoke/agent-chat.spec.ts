import { test, expect } from '@playwright/test';
import { FakeLlmServer } from '@repo/test-utils';
import {
	resetAndSeedUser,
	loginViaCookie,
	createFakeLlmProvider,
	createTestAgent,
	createTestThread,
	waitForThreadIdle,
	RUNTIME_ENTRY_BUILT,
} from '../helpers.js';

/**
 * Core product flow: configure an LLM provider (pointed at the deterministic
 * fake), send a chat message, and see the streamed reply render. Also pins the
 * markdown sanitization of agent output (XSS payload in the reply must be
 * inert). Requires the agent-runtime dist (`pnpm build`) — skipped otherwise.
 */
test.describe('agent chat', () => {
	test.skip(!RUNTIME_ENTRY_BUILT, 'agent-runtime dist not built — run `pnpm build` first');

	const fakeLlm = new FakeLlmServer();
	let token: string;
	let agentId: string;
	let threadId: string;

	test.beforeAll(async () => {
		await fakeLlm.start();
		const user = await resetAndSeedUser();
		token = user.accessToken;
		const providerId = await createFakeLlmProvider(token, fakeLlm);
		agentId = await createTestAgent(token, providerId);
		threadId = await createTestThread(token, agentId);
	});

	test.afterAll(async () => {
		await fakeLlm.stop();
	});

	test.beforeEach(async ({ context }) => {
		await loginViaCookie(context, token);
	});

	test('send a message and see the streamed reply', async ({ page }) => {
		// The backend also calls the LLM for thread-title generation mid-turn —
		// script it separately so the main reply is deterministic.
		fakeLlm.pushChatMatching(/concise title|conversation titles/, { content: 'e2e thread title' });
		fakeLlm.pushChat({ content: 'E2E_REPLY: deterministic assistant answer' });

		await page.goto(`/app/chat/${agentId}/${threadId}`);
		await page.getByPlaceholder(/Message/).fill('Hello agent');
		await page.getByPlaceholder(/Message/).press('Enter');

		await expect(page.getByText('E2E_REPLY: deterministic assistant answer')).toBeVisible({
			timeout: 90_000,
		});
		// Let the turn fully end before the next test sends on the same thread
		await waitForThreadIdle(token, agentId, threadId);
	});

	test('agent output is sanitized (script/event handlers inert)', async ({ page }) => {
		fakeLlm.pushChatMatching(/concise title|conversation titles/, { content: 'e2e thread title' });
		fakeLlm.pushChat({
			content:
				'Safe text. <img src="https://example.com/x.png" onerror="window.__pwned=1"> [click](javascript:window.__pwned=1)',
		});

		await waitForThreadIdle(token, agentId, threadId);
		await page.goto(`/app/chat/${agentId}/${threadId}`);
		await page.getByPlaceholder(/Message/).fill('Show me something');
		await page.getByPlaceholder(/Message/).press('Enter');

		// Scoped to the assistant bubble — the thread sidebar/breadcrumb also
		// carry the (escaped, inert) text via the auto-generated thread title.
		await expect(page.locator('.chat-markdown', { hasText: 'Safe text.' }).last()).toBeVisible({
			timeout: 90_000,
		});
		// The payload rendered (text-wise) but cannot have executed
		const pwned = await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned);
		expect(pwned).toBeUndefined();
		await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
	});
});
