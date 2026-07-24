import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import { FakeLlmServer } from '@repo/test-utils';
import {
	resetAndSeedUser,
	loginViaCookie,
	createFakeLlmProvider,
	createTestAgent,
	createTestThread,
} from '../helpers.js';

/**
 * Chat attachment smoke: selecting a file in the chat input uploads it and
 * shows a pending-attachment chip. The storage/serve security properties are
 * covered by the API integration tests; this pins the UI wiring.
 */
test.describe('chat file upload', () => {
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

	test('attaching a text file shows a pending attachment chip', async ({ page, context }) => {
		await loginViaCookie(context, token);
		await page.goto(`/app/chat/${agentId}/${threadId}`);

		const tmpFile = path.join(os.tmpdir(), 'e2e-upload-notes.txt');
		await writeFile(tmpFile, 'e2e upload content');

		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles(tmpFile);

		await expect(page.getByText('e2e-upload-notes.txt')).toBeVisible({ timeout: 15_000 });
	});
});
