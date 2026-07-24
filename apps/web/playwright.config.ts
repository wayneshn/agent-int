import { defineConfig } from '@playwright/test';
import { TEST_JWT_SECRET } from '@repo/test-utils';
import { E2E_BACKEND_URL, E2E_WEB_PORT, E2E_WEB_URL } from './e2e/ports.js';

/**
 * E2E against the production build: Playwright serves apps/web/build via
 * adapter-node, wired to the real backend booted in global-setup.ts against a
 * throwaway Postgres DB. Requires `pnpm build` first (CI builds before tests).
 *
 * Specs run serially (workers: 1) because they share one test database;
 * each spec file re-seeds its own fixtures (see e2e/helpers.ts).
 */
export default defineConfig({
	testDir: './e2e',
	globalSetup: './e2e/global-setup.ts',
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
	use: {
		baseURL: E2E_WEB_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	webServer: {
		command: 'node build/index.js',
		port: E2E_WEB_PORT,
		env: {
			PORT: String(E2E_WEB_PORT),
			ORIGIN: E2E_WEB_URL,
			BACKEND_URL: E2E_BACKEND_URL,
			// The SvelteKit server verifies session JWTs itself (hooks.server.ts) —
			// it must share the backend's test secret or every SSR page is logged out.
			JWT_SECRET: TEST_JWT_SECRET,
			BROWSER_FEATURE_ENABLED: 'false',
		},
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
	projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
