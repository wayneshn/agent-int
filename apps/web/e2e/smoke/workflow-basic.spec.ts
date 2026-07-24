import { test, expect } from '@playwright/test';
import { api } from '@repo/test-utils';
import { E2E_BACKEND_URL } from '../ports.js';
import { resetAndSeedUser, loginViaCookie, createFakeLlmProvider, createTestAgent } from '../helpers.js';
import { FakeLlmServer } from '@repo/test-utils';

/**
 * Workflow smoke: an API-created workflow shows up in the workflows UI.
 * (Canvas drag-and-drop authoring is intentionally not smoke-tested — it's the
 * flakiest surface in the app; it belongs in the nightly full set.)
 */
test.describe('workflows', () => {
	const fakeLlm = new FakeLlmServer();
	let token: string;
	let agentId: string;

	test.beforeAll(async () => {
		await fakeLlm.start();
		const user = await resetAndSeedUser();
		token = user.accessToken;
		const providerId = await createFakeLlmProvider(token, fakeLlm);
		agentId = await createTestAgent(token, providerId);

		const stepId = '00000000-0000-4000-8000-00000000bb01';
		const created = await api.post(
			E2E_BACKEND_URL,
			`/v1/agents/${agentId}/workflows`,
			{
				name: 'e2e-workflow',
				steps: [
					{
						id: stepId,
						name: 'Only step',
						instruction: 'Reply briefly.',
						errorHandling: { action: 'stop' },
					},
				],
			},
			token,
		);
		expect(created.status).toBe(201);
	});

	test.afterAll(async () => {
		await fakeLlm.stop();
	});

	test.beforeEach(async ({ context }) => {
		await loginViaCookie(context, token);
	});

	test('the workflow appears in the workflows page', async ({ page }) => {
		await page.goto('/app/workflows');
		await expect(page.getByText('e2e-workflow', { exact: true })).toBeVisible();
	});
});
