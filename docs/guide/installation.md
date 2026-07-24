# Install with Docker Compose

This is the recommended way to run Valmis. A single `docker compose up` gives you:

- The **app container** (web UI on port 3000 + API), from the published `ghcr.io/valmishq/valmis` image
- **PostgreSQL 17 with pgvector** (the vector extension agents use for memory), with a persistent volume
- The hardened **agent sandbox**: every agent turn runs in its own locked-down Docker container (`ghcr.io/valmishq/agent-runtime`), spawned through a restricted Docker socket proxy
- **Automatic database migrations** on startup — no manual schema steps

## Prerequisites

- A Linux server (or macOS machine) with **Docker Engine 26 or newer** and Docker Compose. Engine ≥ 26 is required — the sandbox mounts per-agent volume subpaths, a Docker 26 feature, and the server checks this at startup.
- Around 2 GB of free RAM (Postgres + app + headroom for concurrent agent sandboxes, which default to a 1 GB memory cap each).

::: tip No source tree needed
The compose file is pull-only: you can deploy with just `docker-compose.yml` and a `.env` file. Cloning the repository is the easiest way to get both.
:::

## 1. Get the compose file and environment template

```bash
git clone https://github.com/valmishq/valmis.git
cd valmis
cp .env.example .env
```

## 2. Configure `.env`

Open `.env` and set the values below. Everything else has a working default for Docker — the full list is in the [Configuration Reference](/guide/configuration).

### Database

```ini
POSTGRES_DB=valmis
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<choose-a-strong-password>
POSTGRES_PORT=5432
POSTGRES_HOST=postgres
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
```

`POSTGRES_HOST=postgres` is the compose service name — leave it as-is unless you bring your own database.

### Secrets

Three independent secrets are required. Generate each one separately:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```ini
# AES-256-GCM key for encrypting credentials and API keys at rest (32-byte hex)
CREDENTIAL_ENCRYPTION_KEY=<generated value 1>

# Signs login session tokens
JWT_SECRET=<generated value 2>

# Signs the short-lived tokens issued to agent sandboxes — must differ from JWT_SECRET
PROXY_TOKEN_SECRET=<generated value 3>
```

::: danger Back up CREDENTIAL_ENCRYPTION_KEY
All stored credentials and LLM API keys are encrypted with this key. If you lose it, every stored credential becomes unrecoverable and must be re-entered.
:::

### URLs and ports

```ini
# The address users will open in their browser. With a domain + reverse proxy:
# APP_URL=https://agent.example.com
APP_URL=http://localhost:3000

# CORS allowlist — set to the same value as APP_URL
ALLOWED_ORIGINS=http://localhost:3000

# Published host port for the web UI (container-internal port stays 3000)
FRONTEND_PORT=3000

# Set to 1 if you run nginx/Caddy/Traefik in front of Valmis, otherwise 0
TRUST_PROXY_HOPS=0
```

::: warning Do not change BACKEND_PORT in Docker
`BACKEND_PORT` exists for bare-metal development only. Inside the containers the ports are a fixed contract: frontend 3000, backend 4000. The backend port is never published to the internet — only the frontend is.
:::

`APP_URL` is also the base for OAuth2 redirect URIs (`<APP_URL>/oauth2/callback`), so it must match what providers like Google or Slack redirect back to. See [Credentials](/guide/credentials).

### Pin the image versions

CI publishes both images tagged with the short commit hash (and semver tags for releases) — the two images from the same build are always protocol-compatible. Pin **both to the same tag** and bump them together:

```ini
APP_IMAGE=ghcr.io/valmishq/valmis:<tag>
AGENT_RUNTIME_IMAGE=ghcr.io/valmishq/agent-runtime:<tag>
```

Browse available tags on GHCR: [valmis](https://github.com/valmishq/valmis/pkgs/container/valmis) and [agent-runtime](https://github.com/valmishq/valmis/pkgs/container/agent-runtime).

## 3. Start the stack

```bash
docker compose up -d
```

On first start the app container:

1. Waits for Postgres to be healthy
2. Enables the pgvector extension and applies all database migrations
3. Pulls the agent runtime image (also re-checked on every later startup)
4. Starts the web UI and API

Check that everything is running:

```bash
docker compose ps
docker compose logs -f app
```

## 4. Create the admin account

Open `http://localhost:3000` (or your `APP_URL`). Since no user exists yet, you are redirected to the **setup page**. Create the first admin account (email + password), then sign in.

The setup endpoint locks itself permanently once the first user exists.

## 5. Next steps

You have a running platform but no models or agents yet:

1. [Add an LLM provider](/guide/llm-providers) — paste an API key and pick a model
2. [Create your first agent](/guide/getting-started) — the ten-minute tour
3. [Add credentials](/guide/credentials) — let agents call your services

## Operating the deployment

### Updating

Set `APP_IMAGE` and `AGENT_RUNTIME_IMAGE` to the new tag (always the same tag for both), then:

```bash
docker compose pull
docker compose up -d
```

Migrations run automatically on startup.

### Data persistence

| Volume                    | Contents                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| `postgres_data`           | The entire database: users, agents, conversations, memory, encrypted credentials |
| `valmis_agent_workspaces` | Per-agent file workspaces (`read_file` / `write_file` / code execution)          |

Back up the Postgres volume (or use `pg_dump`) and keep your `.env` — especially `CREDENTIAL_ENCRYPTION_KEY` — somewhere safe.

### Production hardening

- The compose file publishes Postgres on host port `5432` for convenience (override with `POSTGRES_HOST_PORT` if another Postgres already occupies it). Remove that `ports:` entry in production if you don't need direct database access.
- Put a reverse proxy with TLS in front of port 3000, set `APP_URL`/`ALLOWED_ORIGINS` to the public HTTPS URL, and set `TRUST_PROXY_HOPS=1`.
- The Docker socket is never mounted into the app container — agent sandboxes are managed through a restricted [socket proxy](/guide/security#the-docker-socket-proxy). Don't attach the socket proxy to the agent runtime networks.

### Building images yourself

The default compose file only pulls published images. To build from source instead, use the separate build file (the image names match, so a local build transparently replaces the published image):

```bash
# Build both images
docker compose -f docker-compose.build.yml build

# Or build just one
docker compose -f docker-compose.build.yml build agent-runtime
```
