import {
	ensureTestDatabase,
	truncateAll,
	bootBackend,
	testDatabaseUrl,
	type BootedServer,
} from '@repo/test-utils';
import { E2E_BACKEND_PORT } from './ports.js';

/**
 * Boots the real backend against a throwaway, fully-migrated test database.
 * The web preview server is managed separately by Playwright's webServer
 * (it must start before globalSetup, so it cannot be wired here).
 * Fake LLM servers are started per spec file (in the worker process) so each
 * file scripts its own replies — see e2e/helpers.ts.
 *
 * Requires TEST_DATABASE_URL (or the default localhost Postgres) — provided
 * by the CI service container or a local `docker compose up postgres`.
 */

let server: BootedServer | null = null;

export default async function globalSetup(): Promise<() => Promise<void>> {
	await ensureTestDatabase(testDatabaseUrl());
	await truncateAll(testDatabaseUrl());
	server = await bootBackend({ port: E2E_BACKEND_PORT, timeoutMs: 120_000 });

	// Returned function runs as the global teardown in the same process.
	return async () => {
		await server?.stop();
		server = null;
	};
}
