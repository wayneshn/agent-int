import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/**
 * Test database lifecycle helpers.
 *
 * Mirrors the production boot path in docker-entrypoint.sh: enable pgvector,
 * then run drizzle-orm's programmatic migrator against apps/backend/drizzle.
 * The backend never self-migrates, so tests must do this explicitly.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** apps/backend/drizzle — valid from both src/ and dist/ (each one level below the package root). */
export function migrationsFolder(): string {
	return path.resolve(__dirname, '../../../apps/backend/drizzle');
}

function parseDatabaseName(databaseUrl: string): string {
	const url = new URL(databaseUrl);
	const name = url.pathname.replace(/^\//, '');
	if (!name) throw new Error(`DATABASE_URL has no database name: ${databaseUrl}`);
	return name;
}

/** Admin connection string pointing at the maintenance database on the same server. */
function maintenanceUrl(databaseUrl: string): string {
	const url = new URL(databaseUrl);
	url.pathname = '/postgres';
	return url.toString();
}

/**
 * Create the test database if it does not exist, enable pgvector, and apply all
 * migrations. Idempotent — safe to call from every test setup.
 */
export async function ensureTestDatabase(databaseUrl: string): Promise<void> {
	const dbName = parseDatabaseName(databaseUrl);

	// 1 — create the database if missing (cannot run inside a transaction)
	{
		const admin = new pg.Client({ connectionString: maintenanceUrl(databaseUrl) });
		await admin.connect();
		try {
			const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
				dbName,
			]);
			if (rows.length === 0) {
				// Identifiers can't be parameterized; quote defensively.
				await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
			}
		} finally {
			await admin.end();
		}
	}

	// 2 — pgvector extension must exist before migrations create vector columns
	const pool = new pg.Pool({ connectionString: databaseUrl });
	try {
		await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
		// 3 — apply migrations (same entrypoint code path as production)
		const db = drizzle(pool);
		await migrate(db, { migrationsFolder: migrationsFolder() });
	} finally {
		await pool.end();
	}
}

/**
 * Run a raw query against the test database. For assertions that must bypass
 * the API (e.g. verifying an encrypted credential row's plaintext directly).
 */
export async function testDbQuery<T = Record<string, unknown>>(
	databaseUrl: string,
	sql: string,
	params: unknown[] = [],
): Promise<T[]> {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
	try {
		const { rows } = await pool.query(sql, params);
		return rows as T[];
	} finally {
		await pool.end();
	}
}

/**
 * Delete all rows from every table in the public schema. The drizzle migrations
 * bookkeeping lives in the `drizzle` schema and is left untouched.
 * Call in beforeEach for test isolation.
 */
export async function truncateAll(databaseUrl: string): Promise<void> {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
	try {
		const { rows } = await pool.query<{ tablename: string }>(
			`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
		);
		if (rows.length === 0) return;
		const tables = rows.map((r) => `"public"."${r.tablename.replace(/"/g, '""')}"`).join(', ');
		await pool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
	} finally {
		await pool.end();
	}
}
