import { defineConfig } from 'vitest/config';

/**
 * Two test projects:
 *   unit        — colocated src/** tests. Pure logic; no DB, no server boot.
 *   integration — tests/** files. Boot the real backend as a child process
 *                 against a shared throwaway Postgres DB (see @repo/test-utils).
 *                 Files run sequentially so per-file truncateAll() isolation holds.
 */
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					include: ['src/**/*.test.ts'],
					environment: 'node',
				},
			},
			{
				test: {
					name: 'integration',
					include: ['tests/**/*.test.ts'],
					environment: 'node',
					fileParallelism: false,
					testTimeout: 120_000,
					hookTimeout: 180_000,
				},
			},
		],
	},
});
