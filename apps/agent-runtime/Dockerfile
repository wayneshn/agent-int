# ─── Agent runtime sandbox image ───────────────────────────────────────────────
# One container of this image is spawned per agent turn by the backend's
# DockerDriver (AGENT_RUNTIME_DRIVER=docker). It runs apps/agent-runtime as a
# non-root user with a read-only rootfs; the only writable paths are the
# per-agent /workspace mount and a tmpfs at /tmp.
#
# Build from the REPO ROOT (workspace dependencies require the full monorepo
# context):
#   docker compose -f docker-compose.build.yml build agent-runtime
# or:
#   docker build -f apps/agent-runtime/Dockerfile -t ghcr.io/valmishq/agent-runtime:latest .
# ────────────────────────────────────────────────────────────────────────────────

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
COPY apps/backend/package.json        apps/backend/
COPY apps/web/package.json            apps/web/
COPY apps/agent-runtime/package.json  apps/agent-runtime/

RUN pnpm install --frozen-lockfile

# Copy source and build the agent-runtime + its workspace dependencies
# (turbo resolves ^build: tsconfig → types → utils → agent-runtime)
COPY . .
RUN pnpm exec turbo run build --filter=@repo/agent-runtime

# ─── Runtime stage ─────────────────────────────────────────────────────────────

FROM node:22-slim AS runner

# python3 enables the run_code tool's python language support; curl and git
# are common run_terminal utilities. ca-certificates for outbound HTTPS.
#
# Plain-HTTP debian mirrors are prone to "Hash Sum mismatch" failures behind
# transparent proxies/CDN caches, so: (1) disable apt's http pipelining/caching,
# (2) bootstrap ca-certificates over HTTP (the slim base ships none, so HTTPS
# apt is impossible at first), (3) switch the mirrors to HTTPS for everything else.
RUN printf 'Acquire::http::Pipeline-Depth 0;\nAcquire::http::No-Cache true;\nAcquire::BrokenProxy true;\n' \
        > /etc/apt/apt.conf.d/99fix-bad-proxy \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 curl git \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.20.0 --activate

WORKDIR /repo

# Production dependency install — scoped to the agent-runtime and its
# workspace dependency graph
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/tsconfig/package.json   packages/tsconfig/
COPY packages/types/package.json      packages/types/
COPY packages/ui/package.json         packages/ui/
COPY packages/utils/package.json      packages/utils/
COPY packages/models/package.json     packages/models/
COPY packages/openui/package.json     packages/openui/
COPY apps/backend/package.json        apps/backend/
COPY apps/web/package.json            apps/web/
COPY apps/agent-runtime/package.json  apps/agent-runtime/

RUN pnpm install --frozen-lockfile --prod --filter @repo/agent-runtime...

# Type declarations consumed from source (type-only — erased at compile time,
# but the symlinked package must exist for module resolution)
COPY --from=builder /repo/packages/types/src   packages/types/src

# packages/utils compiled output + data files resolved via __dirname at runtime.
# Both registries resolve ../../src/... from dist/, i.e. packages/utils/src/...
COPY --from=builder /repo/packages/utils/dist  packages/utils/dist
COPY --from=builder /repo/packages/utils/src/integrations/definitions  packages/utils/src/integrations/definitions
COPY --from=builder /repo/packages/utils/src/skills                    packages/utils/src/skills

# packages/openui compiled output — render_ui tool prompt + validation
COPY --from=builder /repo/packages/openui/dist  packages/openui/dist

# Agent-runtime compiled output
COPY --from=builder /repo/apps/agent-runtime/dist  apps/agent-runtime/dist

# Non-root runtime user. The uid/gid must match RUNTIME_UID in the backend's
# DockerDriver — the workspace dir is chown'd to it before each spawn.
RUN groupadd --gid 10001 agent && useradd --uid 10001 --gid 10001 --create-home agent

# Workspace mountpoint, owned by the runtime user. Docker's volume copy-up
# stamps the IMAGE mountpoint's ownership onto an empty volume (sub)path at
# every container create — without this dir the mountpoint is auto-created as
# root:root and the daemon resets empty agent workspaces to root on each spawn,
# silently undoing the backend's chown and making the workspace read-only for
# the agent.
RUN mkdir -p /workspace && chown agent:agent /workspace

ENV NODE_ENV=production

# Commit this image was built from, stamped by CI (build-args: GIT_SHA). This
# image is version-locked to the app image, so stamping both makes a mismatched
# pin visible. Defaults to "unknown" for local builds.
ARG GIT_SHA=unknown
ENV APP_VERSION=$GIT_SHA

USER 10001:10001

ENTRYPOINT ["node", "/repo/apps/agent-runtime/dist/index.js"]
