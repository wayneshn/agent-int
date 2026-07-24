# Install from Source

Run Valmis directly on a machine with Node.js — useful for development, contribution, or platforms where Docker isn't available. For production deployments, [Docker Compose](/guide/installation) is recommended.

## Prerequisites

- **Node.js ≥ 20**
- **pnpm ≥ 10**
- **PostgreSQL ≥ 15 with the pgvector extension** — agent memory uses vector columns. The easiest way is the `pgvector/pgvector` Docker image; otherwise install the [pgvector](https://github.com/pgvector/pgvector) extension into your Postgres.

## 1. Clone and install

```bash
git clone https://github.com/valmishq/valmis.git
cd valmis
pnpm install
```

The repository is a pnpm + Turborepo monorepo with three applications (web frontend, backend API, agent runtime) and shared packages.

## 2. Configure the environment

```bash
cp .env.example .env
```

Set at minimum:

```ini
# Point at your PostgreSQL instance
DATABASE_URL="postgresql://user:password@localhost:5432/valmis"

# Three independent secrets — generate each with:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CREDENTIAL_ENCRYPTION_KEY=
JWT_SECRET=
PROXY_TOKEN_SECRET=

APP_URL=http://localhost:3000
ALLOWED_ORIGINS=http://localhost:3000
```

The full variable list is documented in the [Configuration Reference](/guide/configuration).

## 3. Prepare the database

Enable pgvector in your database, then apply migrations:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

```bash
pnpm db:migrate
```

## 4. Build the agent runtime

Agent turns execute a compiled entrypoint (`apps/agent-runtime/dist/index.js`), so the runtime must be built before agents can respond:

```bash
pnpm --filter @repo/agent-runtime build
```

::: warning Rebuild after changes
The backend spawns the compiled `dist/index.js` directly. If you modify anything under `apps/agent-runtime/src/`, run this build again — source changes are not picked up otherwise.
:::

## 5. Start the dev servers

```bash
pnpm dev
```

This starts everything concurrently:

| Service                  | URL                     |
| ------------------------ | ----------------------- |
| Web UI (Vite dev server) | `http://localhost:5173` |
| Backend API (Express)    | `http://localhost:4000` |

Open the web UI — you'll be redirected to the setup page to create the first admin account, then sign in.

In development, agents run with the `process` execution driver: each agent turn is a plain Node.js child process with code-level isolation only (no OS sandbox). That's fine for development; see below for using the Docker sandbox on bare metal.

## Optional: Docker sandbox on bare metal

You can keep the app on bare metal but run agent turns in hardened Docker containers:

```ini
AGENT_RUNTIME_DRIVER=docker
AGENT_RUNTIME_IMAGE=ghcr.io/valmishq/agent-runtime:latest
# Runtime containers must reach your bare-metal backend:
AGENT_RUNTIME_PROXY_HOST=http://host.docker.internal:4000
# Absolute HOST path for per-agent workspace bind mounts:
AGENT_RUNTIME_WORKSPACE_HOST_PATH=/absolute/path/to/agent-workspaces
# Linux only — lets containers resolve host.docker.internal:
AGENT_RUNTIME_ADD_HOST_GATEWAY=true
```

Docker Desktop and OrbStack on macOS resolve `host.docker.internal` natively; on Linux set `AGENT_RUNTIME_ADD_HOST_GATEWAY=true`.

## Production from source

If you deploy from source rather than images:

```bash
pnpm build        # builds all packages in dependency order
pnpm db:migrate
```

Then run the two compiled servers (the Docker image does this with PM2):

```bash
node apps/backend/dist/index.js          # API on BACKEND_PORT (default 4000)
PORT=3000 ORIGIN=$APP_URL node apps/web/build/index.js   # web UI
```

Set `AGENT_RUNTIME_ENTRY` to the absolute path of `apps/agent-runtime/dist/index.js` and `AGENT_WORKSPACES_PATH` to a persistent directory outside the repo.

## Running the tests

The monorepo has a layered test suite — unit tests (`pnpm test`), API integration and security regression tests against a real backend and throwaway database (`pnpm test:integration`), and Playwright end-to-end tests (`pnpm test:e2e`). See the [Testing](/guide/testing) guide for prerequisites, the shared harness, and how to write tests.
