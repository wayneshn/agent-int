# Security Overview

Valmis is built for self-hosters who give AI agents real credentials. The design goal: even a fully misbehaving agent — one following malicious instructions — should not be able to read your secrets or escape its box. This page explains how the platform isolates agent execution and protects your credentials and LLM API keys.

## The sandbox: no secrets, ever

Every agent turn runs in an isolated runtime **outside** the main server process. The runtime receives only its agent ID, thread ID, a short-lived access token, and non-secret configuration. It never receives:

- The database connection
- LLM API keys
- Stored credentials
- The platform's encryption or signing keys

Everything sensitive is **proxied**: when the agent calls an LLM, the server resolves the key and streams the response through; when the agent calls `call_api` with a credential, the server injects the secret into the outbound request. Secrets exist only inside the server process.

The runtime's access token is a JWT valid for **15 minutes** and scoped to exactly one agent, one thread, and that agent's attached credentials — a leaked token can't touch anything else, and not for long.

## Execution drivers

How strongly the runtime is isolated depends on the execution driver ([`AGENT_RUNTIME_DRIVER`](/guide/configuration#agent-runtime)):

### `docker` — hardened containers (production default)

The Docker Compose deployment runs **one hardened container per agent turn**:

- Non-root user, read-only root filesystem, all Linux capabilities dropped
- Memory, CPU, and process-count limits per container
- Only that agent's own workspace directory is mounted
- Optional gVisor (`runsc`) runtime for an additional kernel boundary

**Per-agent network egress** is enforced at the network level: agents with [internet access](/guide/agents#allow-internet-access) disabled run on an `internal: true` Docker network where the only reachable host is the backend proxy — `call_api` through credentials still works, but `curl`/`pip` from terminal or code execution cannot reach the internet.

#### The Docker socket proxy

The app container never mounts the Docker socket (which is root-equivalent on the host). It manages sandbox containers through a **restricted socket proxy** (`tecnativa/docker-socket-proxy`) that exposes only the API groups needed for container lifecycle. The proxy is never attached to the agent networks, so even a compromised sandbox cannot reach it.

### `process` — plain child process (bare-metal default)

Each turn is a Node.js child process with a sanitized environment. The no-secrets proxy architecture is identical, and file tools are confined to the agent workspace with path-traversal guards — but there is **no OS boundary** around `run_terminal`/`run_code`. Suitable for development and trusted single-user setups; use the Docker driver when agents handle untrusted input.

## Credential protection

- **AES-256-GCM at rest** — credential data and LLM API keys are encrypted with your `CREDENTIAL_ENCRYPTION_KEY`.
- **Redaction in the UI** — secret fields never travel back to the browser; edit forms show placeholders and preserve untouched values.
- **Scoped attachment** — an agent can only use credentials you explicitly attached; detaching takes effect immediately, even mid-run.
- **OAuth2 hardening** — the OAuth2 `state` is HMAC-signed with a 5-minute TTL, PKCE is used where supported, and token refresh happens server-side.

## Platform access

- **Sessions** — email + password (bcrypt-hashed) with JWT session cookies (HttpOnly).
- **API keys** — stored as SHA-256 hashes, with mandatory expiry (1–365 days). See [API Keys](/guide/api-keys).
- **First-run setup** — the bootstrap endpoint creates the first admin and permanently locks itself once any user exists.
- **Rate limiting** — the API applies a global per-IP rate limit (200 requests / 15 min), excluding streaming, webhook, and internal sandbox endpoints.
- **Webhooks** — workflow webhook triggers require an HMAC-SHA256 signature; [app triggers](/guide/workflows/triggers#app-event) either poll the app's API outbound (Gmail, Outlook/Hotmail, Google Forms — no inbound endpoint) or verify each inbound push with the provider's own scheme (Slack signing secret, Notion `X-Notion-Signature`); channel pairing codes are single-use, expire in 10 minutes, and are brute-force rate-limited.

## Resource guards

- Hard wall-clock timeout per agent run (default 40 minutes)
- Global concurrency cap (default 20 simultaneous runs)
- Per-turn tool-call cap (20), with graceful text fallback
- `run_terminal`/`run_code`: 30-second timeout, 64 KB output cap, minimal environment

## What you should still do

Valmis contains the blast radius of a misbehaving agent, but some risk decisions are yours:

- **Attach credentials sparingly.** An agent's attached credentials define what a prompt-injected agent could misuse. Prefer narrowly-scoped tokens (most [integrations](/integrations/) support them).
- **Review skills before installing.** [Skill](/guide/skills) instructions steer the agent; the install scan warns but does not block.
- **Turn off internet access** for agents that process untrusted content.
- **Run the Docker driver in production**, terminate TLS in front of the app, and keep `CREDENTIAL_ENCRYPTION_KEY` backed up and secret.
