# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for release tags.

## [Unreleased]

### Added

- **Layered test suite with a shared harness** — the repository now has a full
  testing infrastructure where previously there was none:
  - **New workspace package `@repo/test-utils`** (`packages/test-utils`) providing:
    - A deterministic **fake OpenAI-compatible LLM server** (streaming + non-streaming
      chat completions, tool calls, embeddings) with a scriptable FIFO reply queue,
      request-matched replies (so multi-call flows like thread-title generation can be
      scripted separately), error injection, and a request log for assertions.
    - **Test database lifecycle helpers**: create the test database, enable pgvector,
      run the same programmatic drizzle migrator used by the production entrypoint,
      and `TRUNCATE ... CASCADE` between tests.
    - A **backend boot helper** that starts the real Express server as a child process
      on a free port with throwaway secrets/state dirs and waits on `/v1/health`.
    - **Token minting** for user JWTs and sandbox proxy/refresh tokens, and **API
      factories** (setup/login/agents/credentials/threads) for fixture setup.
  - **Unit tests (217)** colocated in `apps/backend/src`, `packages/utils/src`,
    `packages/extractor`, and `apps/web/src` — covering the SSRF guard (IPv4/IPv6,
    NAT64, CGNAT, mapped/embedded forms), AES-256-GCM credential encryption (fresh-IV,
    tamper, wrong-key), credential proxy request shaping (header sanitization,
    multipart bodies), workflow validator/graph/filter, JSON extraction from LLM
    output, the integrations YAML catalog (schema validity, unique ids, no silent
    drops), extractor detection/chunking and all formats, and the chat markdown
    sanitization pipeline (XSS vectors inert) via jsdom component tests.
  - **API integration + security regression tests (52 active)** under
    `apps/backend/tests` — auth lifecycle, credentials CRUD + redaction-sentinel
    round-trip (verified by decrypting the DB row), API keys, agent ownership, chat
    file upload/serve (extension allowlist, magic-byte sniffing, traversal
    sanitization, forced-attachment HTML), webhook HMAC verification (bad/missing
    signature, disabled trigger, anti-enumeration, body cap) including a signed
    end-to-end workflow fire, runtime internal routes (refresh-token type separation,
    thread scoping, credential allowlist + live-revocation), and a cross-tenant
    (IDOR) authorization matrix.
  - **Pending-fix acceptance tests** — every open finding from the security review
    has an `it.todo` or a skipped-but-written regression test (`describe.skip`) that
    lands green the moment the fix ships (proxy SSRF guard, credential destination
    allowlist, symlink containment, process-driver fail-closed, Notion token
    overwrite, login rate limiting, setup race, password policy, token revocation,
    query-token scoping, extractor bounds).
  - **Playwright e2e smoke suite (8 tests)** under `apps/web/e2e` — runs the
    production build (adapter-node) against the real backend and a throwaway
    database: setup/login, a full agent chat turn with streamed fake-LLM reply,
    markdown XSS sanitization in the browser, credential secret hygiene (never in DOM
    or network payloads), workflows listing, and chat file upload.
- **Test commands**: `pnpm test` (unit, no external deps), `pnpm test:integration`
  (requires Postgres), `pnpm test:e2e` (requires Postgres + `pnpm build`). A turbo
  `test` task builds workspace dependencies first and is never cache-skipped.
- **CI test gate** (`.github/workflows/test.yml`) — unit + integration + e2e smoke on
  every PR and push to main; nightly coverage run. Postgres runs as a pgvector
  service container. Image publishing in `docker-publish.yml` now **requires green
  tests** via a reusable-workflow call, and the `changes` job gained an explicit
  read-only `permissions` block. All new actions are pinned to commit SHAs.
- **`POSTGRES_HOST_PORT`** env var to change the host-side published Postgres port in
  `docker-compose.yml` (default `5432`), avoiding conflicts with an existing local
  Postgres.
- **Test artifact ignores** in `.gitignore` (`apps/web/test-results`,
  `apps/web/playwright-report`, `coverage`).

### Fixed

- **Chat: every second turn on a thread could fail with `Cannot continue from message
  role: assistant`.** Thread-title generation (which fires exactly when the second
  user message arrives) persisted an empty assistant row for token accounting. When
  that row landed before the freshly spawned runtime loaded its history, the history
  ended with an assistant message and the agent loop refused to continue — killing
  the turn. Two-layer fix:
  - `apps/backend/src/channels/pipeline.ts` — background tasks are now scheduled
    after the spawn marks the thread `running`, and title generation waits (bounded)
    for the turn to finish.
  - `apps/agent-runtime/src/agent-runner.ts` — content-empty assistant rows
    (accounting artifacts) are filtered from loaded history, which deterministically
    closes the race and also prevents invalid consecutive-assistant histories.
- **Production image build** — the new dev-only `@repo/test-utils` package is removed
  from the workspace graph inside the Docker builder stage, so `turbo build` no longer
  tries (and fails) to compile it in the image.

### Developer notes

- Backend typecheck now also covers the integration tests
  (`tsconfig.test.json`), and the web typecheck covers the e2e suite.
- The e2e web server shares the backend's test `JWT_SECRET` — required because the
  SvelteKit server verifies session tokens itself in `hooks.server.ts`.
