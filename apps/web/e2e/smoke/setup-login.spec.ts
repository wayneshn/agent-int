import { test, expect } from '@playwright/test';
import { truncateAll, testDatabaseUrl } from '@repo/test-utils';

/**
 * First-run flow: /setup creates the admin, redirects to /signin, and the
 * real login form lands on /app. This is the only spec that drives the
 * auth forms — everything else injects the cookie (see helpers.ts).
 */
test.describe('setup and login', () => {
	test.beforeAll(async () => {
		await truncateAll(testDatabaseUrl());
	});

	test('setup creates the first admin and signs in', async ({ page }) => {
		await page.goto('/setup');
		await page.locator('#firstName').fill('E2E');
		await page.locator('#lastName').fill('Admin');
		await page.locator('#email').fill('e2e-admin@test.local');
		await page.locator('#password').fill('e2e-password-123');
		await page.getByRole('button', { name: 'Create admin account' }).click();

		await expect(page).toHaveURL(/\/signin/);

		await page.locator('#email').fill('e2e-admin@test.local');
		await page.locator('#password').fill('e2e-password-123');
		await page.getByRole('button', { name: 'Sign in' }).click();

		await expect(page).toHaveURL(/\/app/);
	});

	test('a wrong password shows an error instead of signing in', async ({ page }) => {
		await page.goto('/signin');
		await page.locator('#email').fill('e2e-admin@test.local');
		await page.locator('#password').fill('wrong-password');
		await page.getByRole('button', { name: 'Sign in' }).click();

		await expect(page.getByText(/invalid|failed/i).first()).toBeVisible();
		await expect(page).toHaveURL(/\/signin/);
	});

	test('unauthenticated visitors are redirected away from /app', async ({ page }) => {
		await page.goto('/app');
		await expect(page).not.toHaveURL(/\/app$/);
	});
});
