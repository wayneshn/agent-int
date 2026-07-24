import { beforeAll, afterAll, beforeEach } from 'vitest';
import {
	ensureTestDatabase,
	truncateAll,
	bootBackend,
	testDatabaseUrl,
	type BootedServer,
	type BootOptions,
} from '@repo/test-utils';

/**
 * Per-file backend lifecycle: migrate once, boot one server on a free port,
 * truncate all tables between tests. Integration files run sequentially
 * (fileParallelism: false in vitest.config.ts), so sharing one test DB is safe.
 *
 * Usage:
 *   const getServer = useBackend();
 *   it('...', async () => { const { baseUrl } = getServer(); ... });
 */
export function useBackend(options: BootOptions = {}): () => BootedServer {
	let server: BootedServer | null = null;

	beforeAll(async () => {
		await ensureTestDatabase(testDatabaseUrl());
		server = await bootBackend(options);
	});

	beforeEach(async () => {
		await truncateAll(testDatabaseUrl());
	});

	afterAll(async () => {
		await server?.stop();
	});

	return () => {
		if (!server) throw new Error('backend accessed before boot completed');
		return server;
	};
}
