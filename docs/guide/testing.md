# Testing

Valmis has a layered test suite: fast **unit tests** for pure logic, **API integration and security regression tests** that boot the real backend against a throwaway PostgreSQL database, and **end-to-end (e2e) tests** that drive the production frontend in a real browser. Everything shares one harness package, `@repo/test-utils`.

The suite is security-first: beyond feature coverage, it pins the platform's security boundaries (sandbox token scoping, credential secrecy, webhook signatures, cross-tenant isolation, markdown sanitization), and every open finding from the security review ships with an acceptance test that goes green when its fix lands.

## Quick start

```bash
# Unit tests only — no external services needed
pnpm test

# API integration + security regression tests — needs PostgreSQL with pgvector
pnpm test:integration

# End-to-end browser tests — needs PostgreSQL + a full build
pnpm build
pnpm test:e2e
```

**Prerequisites for integration and e2e:** a PostgreSQL ≥ 15 server with the `pgvector` extension, reachable via `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/valmis_test`). The harness creates the database if missing, enables `vector`, and applies all migrations — so any scratch server works, e.g. the compose Postgres (`docker compose up postgres`) or a local install.

**Prerequisites for e2e:** `pnpm build` first — Playwright serves the production build (`apps/web/build` via adapter-node) and agent turns spawn the compiled runtime (`apps/agent-runtime/dist`). Chromium is installed with `pnpm --filter @repo/web exec playwright install chromium`.

## Test layers

### 1 — Unit tests (`pnpm test`)

Colocated `*.test.ts` files next to the code they test. No database, no server, no network — they run anywhere in seconds.

| Package | Location | Covers |
| --- | --- | --- |
| `apps/backend` | `src/**/*.test.ts` | SSRF guard (IPv4/IPv6, NAT64, CGNAT, IPv4-mapped/embedded forms), credential encryption (fresh IV per write, tamper detection, wrong-key rejection), credential-proxy header sanitization and multipart body building |
| `packages/utils` | `src/**/*.test.ts` | workflow validator/graph/filter, `json-extract`, email validation, the integrations YAML catalog (every definition is schema-valid, ids unique, registry never silently drops a file) |
| `packages/extractor` | `tests/*.test.ts` | format detection by magic bytes, chunking (segment boundaries, sentence splits, tail merging), text/HTML/OOXML/PDF extraction (fixtures generated in-test), error paths |
| `apps/web` | `src/**/*.test.ts` | markdown sanitization pipeline (script/event-handler/`javascript:`-URL removal) rendered under jsdom |

Run a single package or file:

```bash
pnpm --filter @repo/backend test                 # one package
pnpm --filter @repo/backend exec vitest run src/utils/ssrfGuard.test.ts
```

### 2 — API integration + security regression tests (`pnpm test:integration`)

Located in `apps/backend/tests` (`api/` for feature flows, `security/` for boundary pins). Each file boots the **real Express backend as a child process** (via `tsx`) on a free port against the shared test database, and truncates all tables between tests. Files run sequentially so truncation is safe.

Highlights:

- **Auth lifecycle** — setup → login → profile → password change; uniform login failures (no user enumeration); setup blocked after the first user.
- **Credential hygiene** — secrets never appear in any response; the `__REDACTED__` sentinel preserves the stored secret on update (verified by decrypting the database row directly with the test key).
- **Webhook security** — HMAC-SHA256 over the raw body, constant-time comparison, generic 401 for unknown trigger vs. bad signature, disabled triggers, 5 MB body cap, and a **signed end-to-end fire** that starts a real workflow run.
- **Sandbox internal routes** — refresh tokens rejected on `/internal/*`, thread scoping (403 for other threads), credential allowlist enforcement, **live revocation** (unlink a credential after token issuance → immediately denied).
- **Cross-tenant matrix (IDOR)** — user B cannot read/mutate user A's agents, credentials, threads, workflows, or files.
- **Chat files** — extension allowlist, image magic-byte sniffing, path-traversal filename sanitization, forced `attachment` + `nosniff` for HTML, owner/thread scoping.

#### Pending-fix acceptance tests

Open security findings are captured as `it.todo(...)` (acceptance criteria, no code) or `describe.skip` blocks (fully written, skipped) so the default suite stays green. **When you implement a fix, un-skip its test in the same PR** and verify it fails against the pre-fix code once (e.g. by stashing the fix). Current pending items live in:

- `apps/backend/tests/security/proxy-ssrf.test.ts` (written, skipped — proxy SSRF guard + credential destination allowlist)
- `apps/backend/tests/security/sandbox-isolation.test.ts` (todos — process-driver fail-closed, symlink containment, Notion token, auth hardening, extractor/response bounds)
- `apps/backend/tests/security/authz-matrix.test.ts` (todos — cross-tenant write gaps)
- `apps/web/src/lib/openui/url-scheme.test.ts` (todos — agent-rendered URL scheme validation)

### 3 — End-to-end tests (`pnpm test:e2e`)

Playwright specs in `apps/web/e2e` run against the **production build** of the frontend (adapter-node) wired to a real backend on a throwaway database. Specs run serially (workers: 1) and each file re-seeds its own fixtures via the API, keeping files independent. Chromium traces and screenshots are captured on failure and uploaded as CI artifacts.

The smoke set covers the first-run flow (setup → sign in), a full agent chat turn with a streamed fake-LLM reply, browser-level markdown sanitization of agent output, credential secret hygiene in DOM and network payloads, the workflows page, and chat file upload.

## The harness: `@repo/test-utils`

All layers share one package (`packages/test-utils`). It resolves to compiled JS at runtime (built by turbo before tests) and to TypeScript sources for typechecking.

### Fake LLM server

A deterministic OpenAI-compatible server. Provider configs accept a custom `baseUrl`, so tests point an agent's LLM provider at the fake and get reproducible, offline completions. Use provider `openrouter` (maps to the chat-completions API the fake implements); `openai` uses the Responses API, which the fake does not implement.

```ts
import { FakeLlmServer } from '@repo/test-utils';

const fakeLlm = new FakeLlmServer();
await fakeLlm.start();

fakeLlm.pushChat({ content: 'Deterministic answer' });                    // FIFO queue
fakeLlm.pushChat({ toolCalls: [{ name: 'run_terminal', arguments: { command: 'ls' } }] });
fakeLlm.pushError(500);                                                   // error injection

// Request-matched replies — matched entries win over unconditional ones.
// The backend's thread-title generation prompt contains "concise title",
// so script it separately from the main turn reply:
fakeLlm.pushChatMatching(/concise title|conversation titles/, { content: 'a title' });

fakeLlm.requests; // every request (path, parsed body, timestamp) for assertions
await fakeLlm.stop();
```

Endpoints: `POST /v1/chat/completions` (SSE streaming in fixed-size chunks + JSON), `POST /v1/embeddings` (deterministic vectors; the embedding column is dimensionless), `GET /v1/models`. When the queue is empty, a fixed fallback reply is returned.

### Database helpers

```ts
import { ensureTestDatabase, truncateAll, testDatabaseUrl, testDbQuery } from '@repo/test-utils';

await ensureTestDatabase(testDatabaseUrl()); // create DB, enable pgvector, migrate
await truncateAll(testDatabaseUrl());        // between tests
await testDbQuery(testDatabaseUrl(), 'SELECT data FROM credentials WHERE id = $1', [id]);
```

Migrations run through the same programmatic drizzle migrator as `docker-entrypoint.sh`, so tests exercise the production migration path.

### Backend boot helper

```ts
import { bootBackend } from '@repo/test-utils';

const server = await bootBackend(); // free port, throwaway secrets + tmp state dirs
server.baseUrl;                     // http://127.0.0.1:<port>
server.logs();                      // captured child output (surfaced on boot failure)
await server.stop();                // SIGTERM → SIGKILL escalation
```

Child-process boot (rather than importing the app) exercises the real boot path including fail-fast env validation, and keeps module state isolated per test file. Integration files use the shared `useBackend()` helper in `apps/backend/tests/helpers/boot.ts`.

### Tokens and fixtures

```ts
import { mintProxyToken, mintProxyRefreshToken, mintUserJwt } from '@repo/test-utils';
import { api, setupFirstUser, createUser, createAgent, createCredential, createThread } from '@repo/test-utils';
```

Tokens are HS256 over fixed, clearly-labeled **test-only** secrets (the booted backend is configured with the same values). Never reuse these secrets anywhere else.

## Writing tests

**Unit** — create a colocated `*.test.ts`; import with `.js` specifiers like the source does. Keep it pure (no I/O beyond the unit under test).

**Integration** — add a file under `apps/backend/tests/`:

```ts
import { describe, it, expect } from 'vitest';
import { api, setupFirstUser, createAgent } from '@repo/test-utils';
import { useBackend } from '../helpers/boot.js';

const getServer = useBackend();

describe('my feature', () => {
	it('does the thing', async () => {
		const { baseUrl } = getServer();
		const user = await setupFirstUser(baseUrl);
		// ...
	});
});
```

**E2E** — add a spec under `apps/web/e2e/`. Seed fixtures through the API in `beforeAll` (fast), drive the UI in tests (the thing under test). Authenticate with `loginViaCookie(context, token)` from `e2e/helpers.ts` except when testing the login form itself. Between consecutive agent turns on one thread, call `waitForThreadIdle(...)` — the UI hides this by locking the input while busy.

## CI behavior

- **Pull requests and pushes to main:** unit + integration jobs and the e2e job (chromium) must pass. Postgres runs as a `pgvector/pgvector:pg17` service container.
- **Nightly:** the full suite plus coverage (`vitest --coverage` on unit/integration packages).
- **Publishing:** `docker-publish.yml` calls the test workflow first — images only build on green.
- All actions are pinned to commit SHAs.

There is deliberately **no global coverage-percentage gate** — gates get gamed. The hard rule is instead: every bug fix ships with a regression test, and every security fix ships with its acceptance test from the pending list.

## Troubleshooting

- **`password authentication failed` / `ECONNREFUSED`** — set `TEST_DATABASE_URL` to a reachable pgvector-enabled Postgres.
- **E2E agent-turn specs skip themselves** when `apps/agent-runtime/dist` is missing — run `pnpm build` first.
- **A turn never completes in e2e** — check the fake LLM was started, the provider uses `openrouter` (not `openai`), and `baseUrl` points at the fake's `/v1` URL.
- **Flaky selector after a UI change** — prefer role/exact-text locators; agent chat placeholders are dynamic (`Message <agent name>…`), so match with a regex like `/Message/`.
- **The production Docker build must stay lean** — `@repo/test-utils` is removed from the workspace graph inside the image builder stage; do not import it from production code.
