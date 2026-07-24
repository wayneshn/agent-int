/**
 * Shared test environment constants.
 *
 * The secrets below are FIXED, PUBLIC, TEST-ONLY values. They exist so tests can
 * mint matching tokens (see tokens.ts) and so CI needs no secret configuration.
 * They must never be reused outside the test suite — production deployments
 * generate their own via `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
 */

/** Test-only JWT secret for user sessions (backend JWT_SECRET). */
export const TEST_JWT_SECRET = 'test-only-jwt-secret-do-not-use-in-production-000000';

/** Test-only expiry (backend requires JWT_EXPIRES_IN to be set). */
export const TEST_JWT_EXPIRES_IN = '1h';

/** Test-only proxy token secret (backend PROXY_TOKEN_SECRET). */
export const TEST_PROXY_TOKEN_SECRET = 'test-only-proxy-token-secret-do-not-use-in-prod';

/** Test-only credential encryption key — 32 bytes hex (backend CREDENTIAL_ENCRYPTION_KEY). */
export const TEST_CREDENTIAL_ENCRYPTION_KEY =
	'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** Default Postgres connection for tests. CI overrides via TEST_DATABASE_URL. */
export const DEFAULT_TEST_DATABASE_URL =
	'postgres://postgres:postgres@localhost:5432/valmis_test';

/** Resolved test database URL (TEST_DATABASE_URL env wins). */
export function testDatabaseUrl(): string {
	return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

/**
 * Environment for a booted backend under test. Everything the backend requires
 * at boot, pointed at throwaway resources:
 *   - fixed test secrets (above)
 *   - process driver (no Docker dependency in CI)
 *   - tmp dirs for workspaces/chat files (overridable per boot)
 *   - generous rate limit so tests don't trip the global limiter
 */
export function backendTestEnv(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		NODE_ENV: 'test',
		JWT_SECRET: TEST_JWT_SECRET,
		JWT_EXPIRES_IN: TEST_JWT_EXPIRES_IN,
		PROXY_TOKEN_SECRET: TEST_PROXY_TOKEN_SECRET,
		CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
		DATABASE_URL: testDatabaseUrl(),
		AGENT_RUNTIME_DRIVER: 'process',
		TRUST_PROXY_HOPS: '0',
		// High enough that no test trips the limiter incidentally; the dedicated
		// rate-limit test boots its own server with a low max instead.
		RATE_LIMIT_MAX: '100000',
		BROWSER_FEATURE_ENABLED: 'false',
		...overrides,
	};
}
