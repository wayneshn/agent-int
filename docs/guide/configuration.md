# Configuration Reference

All configuration is done through environment variables, normally in a `.env` file next to `docker-compose.yml` (Docker) or in the repo root (from source). Copy `.env.example` as your starting point — it contains the same variables with inline documentation.

## PostgreSQL

| Variable            | Default                 | Description                                                                                                  |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_DB`       | `valmis`                | Database name (used by the bundled Postgres container).                                                      |
| `POSTGRES_USER`     | `postgres`              | Database user.                                                                                               |
| `POSTGRES_PASSWORD` | —                       | Database password. Always set your own.                                                                      |
| `POSTGRES_PORT`     | `5432`                  | Database port.                                                                                               |
| `POSTGRES_HOST`     | `postgres`              | Database host. `postgres` is the compose service name; use your own host when bringing an external database. |
| `DATABASE_URL`      | composed from the above | Full connection string the backend actually uses.                                                            |

The database must have the **pgvector** extension available. The Docker deployment uses the `pgvector/pgvector:pg17` image and enables it automatically on startup.

## Ports and proxying

| Variable           | Default | Description                                                                                                                                             |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRONTEND_PORT`    | `3000`  | Published **host** port for the web UI in Docker. Inside the container the frontend always listens on 3000.                                             |
| `BACKEND_PORT`     | `4000`  | Bare-metal development only (e.g. when 4000 is taken on your machine). **Do not change in Docker** — the container-internal ports are a fixed contract. |
| `TRUST_PROXY_HOPS` | `0`     | Number of reverse-proxy hops in front of the backend. `0` for direct access / local dev, `1` behind one nginx/Caddy/load-balancer hop. Must be numeric. |

## URLs and CORS

| Variable          | Default                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`         | `http://localhost:3000` | Public-facing application URL. Also the base for OAuth2 redirect URIs (`<APP_URL>/oauth2/callback`) and app-trigger webhook delivery URLs (`<APP_URL>/api/v1/webhooks/<triggerId>`) — it must match what users open in the browser. For app-trigger webhooks to work, external apps must reach this over public HTTPS; testing locally needs a tunnel ([see Testing locally](/integrations/triggers/#testing-locally-tunneling)), not `localhost`. |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated CORS allowlist. Set to the same origin(s) as `APP_URL`.                                                                                                                                                                                                                                                                                                                                                                            |

## Rate limiting

A global rate limiter is applied per client IP across the API (public status, OAuth callback, webhook, sandbox-internal, and SSE-stream paths are excluded). Tune it with:

| Variable               | Default | Description                                                                                           |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Length of the rate-limit window in milliseconds (default 1 minute).                                   |
| `RATE_LIMIT_MAX`       | `500`   | Maximum requests allowed per window, per IP. Invalid or non-positive values fall back to the default. |

## Secrets

Generate each value independently with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable                    | Description                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREDENTIAL_ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM encryption of stored credentials and API keys. **Losing this key makes all stored credentials unrecoverable.** |
| `JWT_SECRET`                | Signs login session tokens (minimum 32 characters recommended).                                                                                |
| `JWT_EXPIRES_IN`            | Session lifetime, e.g. `7d`, `1h`, `30m`. Default `7d`.                                                                                        |
| `PROXY_TOKEN_SECRET`        | Signs the short-lived (15-minute) tokens issued to agent sandboxes. Must be different from `JWT_SECRET`.                                       |

## Agent runtime

| Variable                       | Default             | Description                                                                                                                                                                                                                        |
| ------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_RUNTIME_DRIVER`         | `process`           | How agent turns execute. `process` = plain Node.js child process (code-level isolation only). `docker` = one hardened sibling container per turn (recommended; the compose file sets this automatically).                          |
| `AGENT_RUNTIME_ENTRY`          | —                   | Absolute path to the compiled agent-runtime entrypoint (`apps/agent-runtime/dist/index.js`). Used by the `process` driver. In the Docker deployment this is preset to `/repo/apps/agent-runtime/dist/index.js`.                    |
| `AGENT_WORKSPACES_PATH`        | `.agent-workspaces` | Base directory for per-agent persistent file workspaces. Each agent gets its own subdirectory and can only access that subdirectory. Use an absolute path outside the repo in production (Docker preset: `/opt/agent-workspaces`). |
| `AGENT_RUNTIME_TIMEOUT_MS`     | `2400000` (40 min)  | Hard wall-clock limit per agent run, both drivers. Must exceed the 35-minute `ask_human` wait window.                                                                                                                              |
| `AGENT_RUNTIME_MAX_CONCURRENT` | `20`                | Maximum simultaneous agent runs across all agents.                                                                                                                                                                                 |

### Agent-to-agent messaging

Tune how agents delegate to each other — see [Agent-to-Agent Messaging](/guide/agent-to-agent).

| Variable                       | Default            | Description                                                                                                                                              |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_MESSAGE_MAX_DEPTH`      | `5`                | Maximum delegation chain length — how many times a task may be re-delegated (agent → agent → …) before further delegation is refused. Also bounds fan-out. |
| `AGENT_MESSAGE_ASK_TIMEOUT_MS` | `1200000` (20 min) | How long a synchronous `ask_agent` call waits for the target agent to finish before returning an error. Kept below `AGENT_RUNTIME_TIMEOUT_MS` so the caller's own run is not killed mid-wait. |

### Docker driver options

These apply only when `AGENT_RUNTIME_DRIVER=docker`. The compose file presets all of them.

| Variable                            | Default                                 | Description                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENT_RUNTIME_IMAGE`               | `ghcr.io/valmishq/agent-runtime:latest` | Sandbox container image. Pin it to the **same tag** as `APP_IMAGE`.                                                                                                                  |
| `AGENT_RUNTIME_PROXY_HOST`          | —                                       | URL sandbox containers use to reach the backend. Compose sets `http://app:4000`; bare-metal Docker driver uses `http://host.docker.internal:4000`.                                   |
| `AGENT_RUNTIME_NETWORK`             | `valmis_runtime`                        | Docker network for agents **with** internet access.                                                                                                                                  |
| `AGENT_RUNTIME_NETWORK_INTERNAL`    | `valmis_runtime_internal`               | Internal-only network for agents **without** internet access — they can only reach the backend, so credential-proxied `call_api` still works but direct egress (curl, pip) does not. |
| `AGENT_RUNTIME_WORKSPACE_VOLUME`    | —                                       | Named Docker volume holding all agent workspaces (production; per-agent subpath mounts require Docker Engine ≥ 26). Compose sets `valmis_agent_workspaces`.                          |
| `AGENT_RUNTIME_WORKSPACE_HOST_PATH` | —                                       | Absolute **host** path of the workspaces directory (bare-metal dev bind mounts). Set exactly one of this or `AGENT_RUNTIME_WORKSPACE_VOLUME`.                                        |
| `AGENT_RUNTIME_ADD_HOST_GATEWAY`    | `false`                                 | Set `true` on Linux bare-metal dev so sandbox containers can resolve `host.docker.internal`.                                                                                         |
| `AGENT_RUNTIME_MEMORY_LIMIT_MB`     | `1024`                                  | Per-sandbox memory limit.                                                                                                                                                            |
| `AGENT_RUNTIME_CPU_LIMIT`           | `1`                                     | Per-sandbox CPU limit.                                                                                                                                                               |
| `AGENT_RUNTIME_PIDS_LIMIT`          | `256`                                   | Per-sandbox process count limit.                                                                                                                                                     |
| `AGENT_RUNTIME_DOCKER_RUNTIME`      | —                                       | Optional alternate OCI runtime for sandboxes, e.g. `runsc` to run them under gVisor.                                                                                                 |
| `DOCKER_HOST`                       | —                                       | How the backend reaches the Docker daemon. Compose sets `tcp://docker-socket-proxy:2375` (restricted socket proxy — never a raw socket mount).                                       |

## Web browser

Lets agents drive a real browser to read pages and operate web apps. **Off by default** — see the [Web Browser](/guide/browser) guide. The browser runs separate from the agent sandbox (a dedicated container in Docker deployments, in-process for bare-metal). An agent can browse only when this feature is on **and** the agent has [internet access](/guide/agents#allow-internet-access).

| Variable                          | Default                               | Description                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_FEATURE_ENABLED`         | `false`                               | Master switch. When off, no browser image is pulled, no browser runs, and no agent sees the browser tools or the browser menu.                                                                          |
| `BROWSER_MODE`                    | `auto`                                | `auto` = container in Docker deployments (`AGENT_RUNTIME_DRIVER=docker`), in-process `local` otherwise. Force with `container` or `local`.                                                              |
| `BROWSER_IMAGE`                   | `ghcr.io/valmishq/valmis-browser:latest` | Browser container image (container mode). The default is an in-house **Apache-2.0** Playwright-server image. Pin it to the same release tag as `APP_IMAGE` (it is version-locked to the backend's Playwright). The backend pulls it only when the feature is enabled. |
| `BROWSER_CONNECT_MODE`            | `ws`                                  | How the backend connects to the browser: `ws` (Playwright protocol — the default `valmis-browser` image) or `cdp` (`connectOverCDP` — for browserless or a raw-Chromium CDP image).                       |
| `BROWSER_NETWORK`                 | `valmis_browser`                      | Dedicated Docker network for the browser container. Agent sandboxes are never attached to it, so an agent can't reach the browser directly.                                                             |
| `BROWSER_WS_ENDPOINT`             | —                                     | Connect to an externally-managed browser instead of launching one. When set, the backend does not launch or pull a container.                                                                           |
| `BROWSER_MAX_CONCURRENT_SESSIONS` | `10`                                  | Maximum simultaneous browser sessions across all agents.                                                                                                                                                |
| `BROWSER_SESSION_IDLE_TIMEOUT_MS` | `300000` (5 min)                      | Idle time before an unused session is closed (its state is saved first).                                                                                                                                |
| `BROWSER_SESSION_MAX_LIFETIME_MS` | `1800000` (30 min)                    | Hard cap on a session's total lifetime regardless of activity.                                                                                                                                          |
| `BROWSER_MEMORY_LIMIT_MB`         | `1024`                                | Per-browser-container memory limit (container mode).                                                                                                                                                    |
| `AGENT_BROWSER_STATE_PATH`        | repo-root sibling dir                 | Server-only directory holding each agent's saved logins (cookies + site storage) and history. **Never** mounted into an agent sandbox. Docker preset: a dedicated volume at `/opt/agent-browser-state`. |
| `BROWSER_LOCAL_EXECUTABLE_PATH`   | —                                     | Local mode only: path to an existing Chromium/Chrome binary, to avoid downloading Playwright's browser.                                                                                                 |
| `BROWSER_LOCAL_CHANNEL`           | —                                     | Local mode only: use an installed branded browser, e.g. `chrome` or `msedge`.                                                                                                                           |

For a bare-metal (no-Docker) deployment using local mode, install the browser once with `pnpm --filter @repo/backend exec playwright install chromium` (or point `BROWSER_LOCAL_CHANNEL`/`BROWSER_LOCAL_EXECUTABLE_PATH` at an existing browser).

## Skills

| Variable                                | Default       | Description                                                                                                                                                                                                                        |
| --------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                          | —             | Optional GitHub token used when [installing skills](/guide/skills) from GitHub. Unauthenticated requests are limited to 60/hour by GitHub; a token (public-repo read access is enough) raises the limit.                           |
| `SKILL_INSTALL_ALLOWED_FILE_EXT`        | `md,txt`      | Comma-separated allowlist of file extensions for installed skill bundles (no leading dots). Files with other extensions are filtered out and reported at install review. `md` is always allowed; binary files are always rejected. |
| `SKILL_EVOLUTION_ENABLED`               | `true`        | Enables the background skill-evolution worker. Set `false` to disable entirely.                                                                                                                                                    |
| `SKILL_EVOLUTION_CRON`                  | `0 */6 * * *` | Cron schedule for evolution cycles (default: every 6 hours).                                                                                                                                                                       |
| `SKILL_EVOLUTION_MIN_TRACES`            | `5`           | Minimum fresh usage traces per (agent, skill) pair before a reflection is attempted.                                                                                                                                               |
| `SKILL_EVOLUTION_MIN_TRACES_NO_FAILURE` | `10`          | Without any failed traces, require this many traces before evolving anyway.                                                                                                                                                        |
| `SKILL_EVOLUTION_MAX_PER_CYCLE`         | `10`          | Hard cap on reflection LLM calls per cycle.                                                                                                                                                                                        |
| `SKILL_TRACE_RETENTION_DAYS`            | `30`          | Usage traces older than this are deleted each cycle.                                                                                                                                                                               |

## Docker image pinning

| Variable              | Default                                 | Description                                                                                                              |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `APP_IMAGE`           | `ghcr.io/valmishq/valmis:latest`        | App image reference used by `docker-compose.yml`. Pin to a published tag.                                                |
| `AGENT_RUNTIME_IMAGE` | `ghcr.io/valmishq/agent-runtime:latest` | Sandbox image. Always pin to the **same tag** as `APP_IMAGE` — the two are published together and must stay in lockstep. |
