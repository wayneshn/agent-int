/**
 * Shared e2e network constants. The frontend preview server must know the
 * backend port statically (Playwright starts webServer before globalSetup),
 * so e2e uses fixed, uncommon ports — all overridable via env.
 */

export const E2E_BACKEND_PORT = parseInt(process.env.E2E_BACKEND_PORT ?? '4199', 10);
export const E2E_WEB_PORT = parseInt(process.env.E2E_WEB_PORT ?? '4399', 10);

export const E2E_BACKEND_URL = `http://127.0.0.1:${E2E_BACKEND_PORT}`;
export const E2E_WEB_URL = `http://127.0.0.1:${E2E_WEB_PORT}`;
