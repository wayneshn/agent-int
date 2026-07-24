# ─── Build stage ───────────────────────────────────────────────────────────────
# Builds the entire monorepo (frontend + backend + agent-runtime) from source.
#
# Environment-agnostic build: NO env vars are baked in. The frontend reads all
# private env via $env/dynamic/private (runtime process.env, injected by
# docker-compose env_file). $env/static/private must never be used — static
# values are inlined into the bundle at build time, embedding secrets in the
# image and breaking deploy-time configuration. .env is excluded from the build
# context via .dockerignore.
#
# SvelteKit adapter:
#   svelte.config.js uses @sveltejs/adapter-node directly.
#   The build output is at apps/web/build/index.js (standalone Node.js server).
# ───────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

WORKDIR /repo

# Copy workspace manifests + lockfile first (better layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/tsconfig/package.json   packages/tsconfig/
COPY packages/types/package.json      packages/types/
COPY packages/ui/package.json         packages/ui/
COPY packages/utils/package.json      packages/utils/
COPY packages/models/package.json     packages/models/
COPY packages/openui/package.json     packages/openui/
COPY packages/extractor/package.json  packages/extractor/
COPY apps/backend/package.json        apps/backend/
COPY apps/web/package.json            apps/web/
COPY apps/agent-runtime/package.json  apps/agent-runtime/

RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build everything except @repo/docs — the docs (vitepress) package produces no
# runtime artifact and its devDependencies are not installed in this image.
# @repo/test-utils is dev/test-only — remove it so it is not in the workspace
# graph (backend's ^build would otherwise pull it in) and never lands in images.
RUN rm -rf packages/test-utils && pnpm exec turbo run build --filter=!@repo/docs

# ─── Runtime stage ─────────────────────────────────────────────────────────────
# Lean production image — compiled outputs + production dependencies only.
# No Docker CLI required — with AGENT_RUNTIME_DRIVER=docker the backend talks
# to the Docker Engine API (via dockerode) through the docker-socket-proxy
# service to spawn one hardened sibling container per agent turn. With
# AGENT_RUNTIME_DRIVER=process, agent turns run as Node.js child processes.
# ───────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS runner

# Install pnpm and PM2.
# PM2 manages both the SvelteKit and Express processes inside this container.
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate \
    && npm install -g pm2@latest

WORKDIR /repo

# Copy workspace manifests for production dependency install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/tsconfig/package.json   packages/tsconfig/
COPY packages/types/package.json      packages/types/
COPY packages/ui/package.json         packages/ui/
COPY packages/utils/package.json      packages/utils/
COPY packages/models/package.json     packages/models/
COPY packages/openui/package.json     packages/openui/
COPY packages/extractor/package.json  packages/extractor/
COPY apps/backend/package.json        apps/backend/
COPY apps/web/package.json            apps/web/
COPY apps/agent-runtime/package.json  apps/agent-runtime/

RUN pnpm install --frozen-lockfile --prod

# Shared type declarations — consumed directly from source
COPY --from=builder /repo/packages/types/src   packages/types/src
COPY --from=builder /repo/packages/ui/src      packages/ui/src

# packages/models compiled JS output — the backend imports it at runtime under
# plain node, which cannot load the .ts source (type stripping does not remap
# the .js specifiers inside it)
COPY --from=builder /repo/packages/models/dist packages/models/dist

# packages/utils compiled JS output
COPY --from=builder /repo/packages/utils/dist  packages/utils/dist

# packages/openui compiled JS output — imported at runtime by the process-driver
# agent-runtime (render_ui tool prompt + validation)
COPY --from=builder /repo/packages/openui/dist packages/openui/dist

# packages/extractor compiled JS output — imported at runtime by the backend
# (KnowledgeBaseService). Its exports "import" condition resolves to dist/index.js.
COPY --from=builder /repo/packages/extractor/dist  packages/extractor/dist

# Data files referenced at runtime via __dirname (tsc does not copy non-TS files).
# Both registries resolve ../../src/... from dist/, i.e. packages/utils/src/...
COPY --from=builder /repo/packages/utils/src/integrations/definitions  packages/utils/src/integrations/definitions
COPY --from=builder /repo/packages/utils/src/skills                    packages/utils/src/skills

# Backend compiled output (tsc → dist/)
COPY --from=builder /repo/apps/backend/dist    apps/backend/dist

# Drizzle migration files (needed for db:migrate at startup)
COPY --from=builder /repo/apps/backend/drizzle apps/backend/drizzle

# SvelteKit adapter-node output (vite build → build/)
# The build/ directory contains the standalone Node.js server entry at build/index.js
COPY --from=builder /repo/apps/web/build       apps/web/build

# Agent-runtime compiled output (tsc → dist/).
# Used only by the process driver (AGENT_RUNTIME_DRIVER=process) — the docker
# driver runs the separate ghcr.io/valmishq/agent-runtime image instead (built from
# apps/agent-runtime/Dockerfile). AGENT_RUNTIME_ENTRY points to this path.
COPY --from=builder /repo/apps/agent-runtime/dist  apps/agent-runtime/dist

# PM2 process config — runs both processes under PM2's process manager
COPY pm2.config.cjs .

# Entrypoint: runs Drizzle migrations then starts PM2
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production

# Port 3000: SvelteKit frontend (published externally in docker-compose)
# Port 4000: Express backend (NOT published externally — only on Docker network)
EXPOSE 3000
EXPOSE 4000

CMD ["/bin/sh", "docker-entrypoint.sh"]
