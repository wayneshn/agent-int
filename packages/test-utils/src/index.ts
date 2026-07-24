// @repo/test-utils — shared test harness (Node.js only)
export {
	TEST_JWT_SECRET,
	TEST_JWT_EXPIRES_IN,
	TEST_PROXY_TOKEN_SECRET,
	TEST_CREDENTIAL_ENCRYPTION_KEY,
	DEFAULT_TEST_DATABASE_URL,
	testDatabaseUrl,
	backendTestEnv,
} from './env.js';

export { ensureTestDatabase, truncateAll, migrationsFolder, testDbQuery } from './db.js';

export { bootBackend, freePort } from './server.js';
export type { BootedServer, BootOptions } from './server.js';

export { FakeLlmServer } from './fake-llm.js';
export type { FakeChatReply, FakeErrorReply, FakeReply, FakeToolCall, RecordedLlmRequest } from './fake-llm.js';

export { mintProxyToken, mintProxyRefreshToken, mintUserJwt } from './tokens.js';
export type { ProxyTokenClaims, UserJwtClaims } from './tokens.js';

export { api, setupFirstUser, createUser, loginUser, createAgent, createCredential, createThread } from './fixtures.js';
export type { ApiResult, TestUser } from './fixtures.js';
