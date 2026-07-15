import { jwtVerify, SignJWT } from 'jose';
import { randomBytes } from 'node:crypto';
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
	 * Build the shared, scoped JWT claims common to access and refresh tokens.
	 */
	private tokenClaims(
		payload: Omit<SandboxTokenPayload, 'iat' | 'exp' | 'type'>,
	): Record<string, unknown> {
		return {
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
		};
	}

	/**
	 * Issue a short-lived access PROXY_TOKEN for a container spawn.
	 * TTL: 15 minutes — sufficient for a typical agent task. Longer runs (esp.
	 * workflows) self-heal by exchanging the refresh token via refresh-token.
	 */
	async issueProxyToken(
		payload: Omit<SandboxTokenPayload, 'iat' | 'exp' | 'type'>,
	): Promise<string> {
		return new SignJWT({ ...this.tokenClaims(payload), type: 'access' })
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuedAt()
			.setExpirationTime('15m')
			.sign(this.proxyTokenSecret);
	}

	/**
	 * Issue a longer-lived refresh token, injected into the sandbox alongside the
	 * access token. It may ONLY be exchanged for a fresh access token (same scope)
	 * via POST /v1/runtime/refresh-token — never accepted on /internal/*. Its TTL
	 * is the hard ceiling on how long a single run can keep self-healing.
	 * Configurable via PROXY_REFRESH_TOKEN_TTL (default 8h).
	 */
	async issueRefreshToken(
		payload: Omit<SandboxTokenPayload, 'iat' | 'exp' | 'type'>,
	): Promise<string> {
		const ttl = process.env.PROXY_REFRESH_TOKEN_TTL ?? '8h';
		return new SignJWT({ ...this.tokenClaims(payload), type: 'refresh' })
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuedAt()
			.setExpirationTime(ttl)
			.sign(this.proxyTokenSecret);
	}

	/**
	 * Validate an access PROXY_TOKEN and return its decoded payload.
	 * Throws if the token is invalid, expired, malformed, or is a refresh token
	 * (a long-lived refresh token must never be accepted on /internal/*).
	 */
	async verifyProxyToken(token: string): Promise<SandboxTokenPayload> {
		const { payload } = await jwtVerify(token, this.proxyTokenSecret);
		if ((payload as { type?: string }).type === 'refresh') {
			throw new Error('Refresh token cannot be used as an access token');
		}
		return payload as unknown as SandboxTokenPayload;
	}

	/**
	 * Validate a refresh token and return its decoded payload.
	 * Throws if the token is invalid, expired, malformed, or is not a refresh token.
	 */
	async verifyRefreshToken(token: string): Promise<SandboxTokenPayload> {
		const { payload } = await jwtVerify(token, this.proxyTokenSecret);
		if ((payload as { type?: string }).type !== 'refresh') {
			throw new Error('Not a refresh token');
		}
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

	/** Drop any Content-Type header (case-insensitive) so fetch can set the value itself. */
	private stripContentType(
		headers: Record<string, string> | undefined,
	): Record<string, string> | undefined {
		if (!headers) return headers;
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === 'content-type') continue;
			out[key] = value;
		}
		return out;
	}

	/**
	 * Resolve the outbound headers for a built body: multipart drops any caller Content-Type
	 * (so form-data's boundary isn't clobbered), and a returned `contentType` (multipart/related)
	 * is set EXPLICITLY as a header value — header values are preserved verbatim, unlike a Blob's
	 * `type` which fetch lowercases and would corrupt the mixed-case boundary token.
	 */
	private applyOutboundContentType(
		sanitizedHeaders: Record<string, string> | undefined,
		outbound: { isMultipart: boolean; contentType?: string },
	): Record<string, string> | undefined {
		const base = outbound.isMultipart ? this.stripContentType(sanitizedHeaders) : sanitizedHeaders;
		if (!outbound.contentType) return base;
		return { ...(base ?? {}), 'Content-Type': outbound.contentType };
	}

	/**
	 * Assemble a multipart/related request body from ordered parts. Unlike form-data,
	 * each part is a bare section with its own Content-Type (no field names / boundaries
	 * managed by FormData) — the structure APIs like Google Drive's multipart upload need.
	 * Returns the raw bytes and the boundary token to advertise in the Content-Type.
	 */
	private buildMultipartRelated(request: ProxyRequest): { bytes: Buffer; boundary: string } {
		// All-lowercase (hex is already lowercase) so no header-normalisation layer can ever
		// desync the header's boundary token from the body's delimiters.
		const boundary = `valmisrelated${randomBytes(16).toString('hex')}`;
		const chunks: Buffer[] = [];
		for (const part of request.multipart ?? []) {
			const contentType = part.contentType ?? 'application/octet-stream';
			chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`, 'utf-8'));
			chunks.push(
				part.dataBase64 != null
					? Buffer.from(part.dataBase64, 'base64')
					: Buffer.from(part.value ?? '', 'utf-8'),
			);
			chunks.push(Buffer.from('\r\n', 'utf-8'));
		}
		chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
		return { bytes: Buffer.concat(chunks), boundary };
	}

	/**
	 * Build the outbound fetch body from a ProxyRequest, decoding binary payloads.
	 *   - multipart (form-data) → a FormData (fetch sets the Content-Type + boundary)
	 *   - multipart (related)   → a Blob whose type carries multipart/related; boundary=…
	 *   - bodyEncoding 'base64' → raw bytes (Buffer) so binary survives intact
	 *   - otherwise → the raw string (or undefined)
	 *
	 * `isMultipart` means "the body dictates its own Content-Type" — the caller strips any
	 * caller-supplied Content-Type. For form-data, fetch then emits the FormData type +
	 * boundary; for related, `contentType` is returned so the caller sets it EXPLICITLY
	 * (undici lowercases a Blob's `type`, which would corrupt the mixed-case boundary token).
	 */
	private buildOutboundBody(request: ProxyRequest): {
		body: string | Blob | FormData | undefined;
		isMultipart: boolean;
		contentType?: string;
	} {
		if (request.multipart && request.multipart.length > 0) {
			if (request.multipartSubtype === 'related') {
				const { bytes, boundary } = this.buildMultipartRelated(request);
				// Typeless Blob — the Content-Type (with the exact-case boundary) is set as an
				// explicit header by the caller, since a Blob.type would be lowercased by fetch.
				return {
					body: new Blob([new Uint8Array(bytes)]),
					isMultipart: true,
					contentType: `multipart/related; boundary=${boundary}`,
				};
			}
			const form = new FormData();
			for (const part of request.multipart) {
				if (part.dataBase64 != null) {
					const bytes = Buffer.from(part.dataBase64, 'base64');
					const blob = new Blob([bytes], {
						type: part.contentType ?? 'application/octet-stream',
					});
					form.append(part.name, blob, part.filename ?? part.name);
				} else {
					form.append(part.name, part.value ?? '');
				}
			}
			return { body: form, isMultipart: true };
		}
		if (request.bodyEncoding === 'base64' && request.body != null) {
			// Wrap the raw bytes in a Blob (a valid BodyInit). The agent-supplied
			// Content-Type header still wins, so the correct MIME type is sent.
			return { body: new Blob([Buffer.from(request.body, 'base64')]), isMultipart: false };
		}
		return { body: request.body, isMultipart: false };
	}

	/**
	 * Read a fetch Response into a ProxyResponse. When the request asked for
	 * responseEncoding 'base64', the body is read as raw bytes and base64-encoded
	 * (for binary downloads); otherwise it is read as UTF-8 text.
	 */
	private async readResponseBody(
		request: ProxyRequest,
		response: Response,
	): Promise<ProxyResponse> {
		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key] = value;
		});
		if (request.responseEncoding === 'base64') {
			const bytes = Buffer.from(await response.arrayBuffer());
			return {
				status: response.status,
				headers,
				body: bytes.toString('base64'),
				bodyEncoding: 'base64',
			};
		}
		const body = await response.text();
		return { status: response.status, headers, body, bodyEncoding: 'text' };
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

			const outbound = this.buildOutboundBody(request);
			// For multipart, drop any caller Content-Type; form-data lets fetch write the
			// boundary, while related supplies an explicit Content-Type (exact-case boundary).
			const headers = this.applyOutboundContentType(sanitizedHeaders, outbound);

			const fetchOptions: RequestInit = {
				method: request.method,
				headers,
			};
			if (outbound.body !== undefined) {
				fetchOptions.body = outbound.body;
			}

			const response = await fetch(targetUrl, fetchOptions);
			return await this.readResponseBody(request, response);
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

		// Step 4 — build the outbound body (decode base64 / assemble multipart) and resolve
		// its Content-Type (strip for form-data; explicit boundary header for related).
		const outbound = this.buildOutboundBody(request);
		const headers = this.applyOutboundContentType(sanitizedHeaders, outbound);

		// Step 5 — execute via resolver (handles OAuth2 refresh, header injection, etc.)
		const response = await this.credentialResolver.executeWithCredential(
			request.credentialId,
			tokenPayload.ownerId,
			{
				method: request.method,
				url: request.url,
				headers,
				qs: request.qs,
				body: outbound.body,
			},
		);

		// Step 6 — collect response (text, or base64 bytes for binary downloads)
		return await this.readResponseBody(request, response);
	}
}
