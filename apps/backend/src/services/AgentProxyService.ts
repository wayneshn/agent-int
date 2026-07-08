import { jwtVerify, SignJWT } from 'jose';
import { eq, and } from 'drizzle-orm';
import type { ProxyRequest, ProxyResponse, SandboxTokenPayload, HitlRequest } from '@repo/types';
import { CredentialResolverService } from './CredentialResolverService.js';
import { agentStreamBus } from './AgentStreamBus.js';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { agentCredentials } from '../db/schema/agentCredentials.js';
import { credentials } from '../db/schema/credentials.js';

/**
 * TTL for a pending HITL request.
 * If the human does not respond within this window the sandbox receives a timeout error.
 */
const HITL_TIMEOUT_MS = 30 * 60 * 1000;

/** Internal state for one pending HITL interaction */
interface HitlPending {
	resolve: (response: string) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Validates PROXY_TOKENs issued to agent sandboxes and executes credential proxy requests.
 * Also manages in-process Human-in-the-Loop (HITL) blocking interactions.
 *
 * Security model:
 *   - Every sandbox receives a short-lived JWT (PROXY_TOKEN) at container spawn time.
 *   - The token is scoped to one agent, one thread, and one set of allowed credential IDs.
 *   - This service validates the token and enforces that the requested credentialId is
 *     in the token's allowlist before calling CredentialResolverService.
 *   - A live DB check against agent_credentials ensures that credentials revoked (unlinked)
 *     after the token was issued are immediately blocked — not just at next spawn.
 *   - Raw credential values never leave the host process — the sandbox only receives
 *     the API response body.
 *
 * HITL design:
 *   - The sandbox calls POST /v1/runtime/internal/hitl/request with { prompt, options? }.
 *   - The route handler calls submitHitlRequest() which stores a Promise resolver keyed by
 *     threadId and emits a `hitl_request` SSE event so the browser can unlock the input.
 *   - The route handler then awaits the returned promise (long HTTP connection).
 *   - When the user sends their next message, the message route handler checks for a pending
 *     HITL via resolveHitlRequest() and resolves it instead of spawning a new child process.
 */
export class AgentProxyService {
	private readonly credentialResolver: CredentialResolverService;
	private readonly proxyTokenSecret: Uint8Array;

	/** Keyed by threadId — at most one pending HITL per thread at any time */
	private readonly pendingHitl = new Map<string, HitlPending>();

	constructor(credentialResolver: CredentialResolverService, proxyTokenSecret: string) {
		this.credentialResolver = credentialResolver;
		this.proxyTokenSecret = new TextEncoder().encode(proxyTokenSecret);
	}

	/**
	 * Issue a PROXY_TOKEN for a container spawn.
	 * TTL: 15 minutes — sufficient for a typical agent task.
	 */
	async issueProxyToken(payload: Omit<SandboxTokenPayload, 'iat' | 'exp'>): Promise<string> {
		return new SignJWT({
			agentId: payload.agentId,
			ownerId: payload.ownerId,
			threadId: payload.threadId,
			credentialIds: payload.credentialIds,
			// Without this, an allCredentials agent's token loses the flag and the proxy
			// falls back to the junction check — denying any owner credential not linked.
			allCredentials: payload.allCredentials,
			// Scopes the /internal/mission/* endpoints and attributes LLM cost to the
			// mission budget. Absent for non-mission turns.
			missionId: payload.missionId,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuedAt()
			.setExpirationTime('15m')
			.sign(this.proxyTokenSecret);
	}

	/**
	 * Validate a PROXY_TOKEN and return its decoded payload.
	 * Throws if the token is invalid, expired, or malformed.
	 */
	async verifyProxyToken(token: string): Promise<SandboxTokenPayload> {
		const { payload } = await jwtVerify(token, this.proxyTokenSecret);
		return payload as unknown as SandboxTokenPayload;
	}

	// HITL

	/**
	 * Submit a HITL request on behalf of a sandbox.
	 *
	 * Emits a `hitl_request` SSE event to the browser so the UI can display the
	 * prompt and unlock the chat input. Returns a promise that resolves when
	 * resolveHitlRequest() is called (i.e. when the human sends their reply).
	 *
	 * Rejects automatically after HITL_TIMEOUT_MS if the human does not respond.
	 */
	submitHitlRequest(threadId: string, request: HitlRequest): Promise<string> {
		// Reject any previously pending HITL for this thread (shouldn't happen normally)
		if (this.pendingHitl.has(threadId)) {
			const existing = this.pendingHitl.get(threadId)!;
			clearTimeout(existing.timer);
			existing.reject(new Error('Superseded by a new HITL request'));
			this.pendingHitl.delete(threadId);
		}

		logger.info(
			{ threadId, prompt: request.prompt },
			'[hitl] sandbox submitted HITL request — waiting for human response',
		);

		// Emit SSE event so the browser unlocks the chat input and shows the prompt
		agentStreamBus.emit(threadId, {
			type: 'hitl_request',
			prompt: request.prompt,
			options: request.options,
		});

		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingHitl.delete(threadId);
				logger.warn({ threadId }, '[hitl] HITL request timed out — no human response');
				reject(new Error('HITL request timed out — no human response within the allowed window'));
			}, HITL_TIMEOUT_MS);

			this.pendingHitl.set(threadId, { resolve, reject, timer });
		});
	}

	/**
	 * Check whether a thread has a pending HITL request awaiting a human response.
	 * Used by the message route handler before deciding whether to spawn a child process.
	 */
	hasPendingHitl(threadId: string): boolean {
		return this.pendingHitl.has(threadId);
	}

	/**
	 * Resolve a pending HITL request with the human's response text.
	 * The promise returned by submitHitlRequest() will resolve with this value,
	 * unblocking the long-polling HTTP connection held by the child process.
	 *
	 * Returns true if a pending request was found and resolved, false otherwise.
	 */
	resolveHitlRequest(threadId: string, response: string): boolean {
		const pending = this.pendingHitl.get(threadId);
		if (!pending) return false;

		clearTimeout(pending.timer);
		this.pendingHitl.delete(threadId);

		logger.info({ threadId }, '[hitl] HITL request resolved by human response');
		pending.resolve(response);
		return true;
	}

	// Header sanitisation

	/**
	 * Strip surrounding double-quote characters that LLMs occasionally wrap around
	 * header names, e.g. '"Content-Type"' becomes 'Content-Type'.
	 *
	 * Node.js fetch's Headers.append rejects quoted names with the error:
	 *   `Headers.append: ""Content-Type"" is an invalid header name`
	 *
	 * This is a defensive normalisation layer — valid header names are unchanged.
	 */
	private sanitizeHeaders(
		headers: Record<string, string> | undefined,
	): Record<string, string> | undefined {
		if (!headers) return headers;
		const sanitized: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			// Remove leading/trailing double-quote characters from the header name
			const cleanKey = key.replace(/^"+|"+$/g, '');
			sanitized[cleanKey] = value;
		}
		return sanitized;
	}

	// Credential Proxy

	/**
	 * Execute a credential proxy request on behalf of a sandbox.
	 *
	 * Steps:
	 *   1. Verify PROXY_TOKEN
	 *   2. Sanitize caller-supplied header names (strip LLM-generated surrounding quotes)
	 *   3. If credentialId is non-empty, enforce it is in the token's allowed list
	 *   4. Live DB check: verify the (agentId, credentialId) junction row still exists —
	 *      blocks credentials unlinked mid-session even though the PROXY_TOKEN is still valid
	 *   5. Delegate to CredentialResolverService.executeWithCredential()
	 *   6. If credentialId is empty, execute the request directly without auth injection
	 *   7. Return response (status, headers, body) — never the raw credential
	 *
	 * On revocation (step 4), throws an Error whose message surfaces to the agent as a
	 * tool result text block, allowing the LLM to reason about the access denial.
	 */
	async executeProxyRequest(proxyToken: string, request: ProxyRequest): Promise<ProxyResponse> {
		// Step 1 — validate token
		const tokenPayload = await this.verifyProxyToken(proxyToken);

		// Step 2 — sanitize headers: strip surrounding quotes that LLMs generate
		const sanitizedHeaders = this.sanitizeHeaders(request.headers);

		// Step 3a — unauthenticated path: empty credentialId means no auth injection
		if (!request.credentialId) {
			logger.info(
				{ agentId: tokenPayload.agentId, url: request.url },
				'[proxy] executing unauthenticated proxy request (no credential)',
			);

			// Build URL with any caller-supplied query string params
			let targetUrl = request.url;
			if (request.qs && Object.keys(request.qs).length > 0) {
				const urlObj = new URL(request.url);
				for (const [key, value] of Object.entries(request.qs)) {
					urlObj.searchParams.set(key, value);
				}
				targetUrl = urlObj.toString();
			}

			const fetchOptions: RequestInit = {
				method: request.method,
				headers: sanitizedHeaders,
			};
			if (request.body) {
				fetchOptions.body = request.body;
			}

			const response = await fetch(targetUrl, fetchOptions);
			const body = await response.text();
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});

			return { status: response.status, headers, body };
		}

		// Step 3b — authenticated path: enforce credential allowlist (token-time snapshot).
		// Skipped for allCredentials agents, which may use any credential the owner has —
		// including ones added after the token was issued.
		if (
			!tokenPayload.allCredentials &&
			!tokenPayload.credentialIds.includes(request.credentialId)
		) {
			throw new Error(
				`Credential ${request.credentialId} is not authorized for this sandbox session`,
			);
		}

		// Step 4 — live authorization check against the DB. The PROXY_TOKEN allowlist is
		// a snapshot from spawn time; this ensures changes take effect immediately.
		//   - allCredentials agents: the credential must still belong to the owner.
		//   - otherwise: the agent_credentials junction row must still exist (revocation).
		// The error message is propagated back to the agent as a tool result text block.
		let authorized: boolean;
		if (tokenPayload.allCredentials) {
			const owned = await db
				.select({ id: credentials.id })
				.from(credentials)
				.where(
					and(
						eq(credentials.id, request.credentialId),
						eq(credentials.ownerId, tokenPayload.ownerId),
					),
				)
				.limit(1);
			authorized = owned.length > 0;
		} else {
			const junction = await db
				.select({ agentId: agentCredentials.agentId })
				.from(agentCredentials)
				.where(
					and(
						eq(agentCredentials.agentId, tokenPayload.agentId),
						eq(agentCredentials.credentialId, request.credentialId),
					),
				)
				.limit(1);
			authorized = junction.length > 0;
		}

		if (!authorized) {
			logger.warn(
				{ agentId: tokenPayload.agentId, credentialId: request.credentialId },
				'[proxy] credential access denied — no longer authorized for this agent',
			);
			throw new Error(
				`Credential ${request.credentialId} has been revoked — it is no longer linked to this agent`,
			);
		}

		logger.info(
			{ agentId: tokenPayload.agentId, credentialId: request.credentialId, url: request.url },
			'[proxy] executing authenticated credential proxy request',
		);

		// Step 4 — execute via resolver (handles OAuth2 refresh, header injection, etc.)
		const response = await this.credentialResolver.executeWithCredential(
			request.credentialId,
			tokenPayload.ownerId,
			{
				method: request.method,
				url: request.url,
				headers: sanitizedHeaders,
				qs: request.qs,
				body: request.body,
			},
		);

		// Step 5 — collect response
		const body = await response.text();
		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key] = value;
		});

		return { status: response.status, headers, body };
	}
}
