import { test, expect } from '@playwright/test';
import { createCredential } from '@repo/test-utils';
import { E2E_BACKEND_URL } from '../ports.js';
import { resetAndSeedUser, loginViaCookie } from '../helpers.js';

/**
 * Credential secret hygiene end-to-end: a stored secret must never appear in
 * the rendered page or in any API response the browser receives.
 */
test.describe('credentials page', () => {
	const SECRET = 'e2e-super-secret-api-key-9f8e7d6c';
	let token: string;

	test.beforeAll(async () => {
		const user = await resetAndSeedUser();
		token = user.accessToken;
		await createCredential(E2E_BACKEND_URL, token, {
			type: 'tally-api-key',
			name: 'e2e-tally',
			data: { apiKey: SECRET },
		});
	});

	test.beforeEach(async ({ context }) => {
		await loginViaCookie(context, token);
	});

	test('the credential is listed but its secret never reaches the browser', async ({ page }) => {
		// Capture every API response the page receives
		const apiBodies: string[] = [];
		page.on('response', (response) => {
			if (response.url().includes('/api/v1/')) {
				void response
					.text()
					.then((text) => apiBodies.push(text))
					.catch(() => undefined);
			}
		});

		await page.goto('/app/credentials');
		await expect(page.getByText('e2e-tally', { exact: true })).toBeVisible();

		// Neither the DOM nor any API payload may contain the raw secret
		await expect(page.getByText(SECRET)).toHaveCount(0);
		// Give in-flight responses a tick to flush into apiBodies
		await page.waitForTimeout(500);
		expect(apiBodies.join('\n')).not.toContain(SECRET);
	});
});
