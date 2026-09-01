import type { Handle, RequestEvent } from '@sveltejs/kit';
import { jwtVerify } from 'jose';
import type { ApiResponse, AuthTokenPayload } from '@repo/types';
import { env } from '$env/dynamic/private';

// JWT_SECRET is read via dynamic env (runtime process.env; in dev SvelteKit
// loads it from the root .env via env.dir = '../../'). It must NEVER come from
// $env/static/private — static values are baked into the built bundle, which
// both embeds the secret in the image and breaks secret rotation at deploy time.
// Read per-request so prerendering/build never touches it.
const getJwtSecret = (): Uint8Array => new TextEncoder().encode(env.JWT_SECRET ?? '');

// Hop-by-hop headers must not be forwarded between the proxy and either peer.
const HOP_BY_HOP_HEADERS = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
];

// undici requires `duplex` when a request body is streamed, but the TS
// RequestInit type does not include it yet.
interface ProxyRequestInit extends RequestInit {
	duplex: 'half';
}

/**
 * Proxies /api/* requests to the internal Express backend, stripping the /api
 * prefix (same rewrite as the Vite dev proxy in vite.config.ts).
 *
 * This runs in dev as well as in production. The Vite dev proxy only intercepts
 * requests that actually travel over HTTP, i.e. those the browser makes; a
 * same-origin `event.fetch` from a load function or form action never becomes an
 * HTTP request — SvelteKit dispatches it straight into this hook — so every
 * server-side `$lib/server/api` call reaches the backend through here in both
 * environments.
 *
 * The response body is passed through as a stream so SSE (the chat stream
 * endpoint) works unchanged. Server-side callers must therefore not hold an
 * unread response across an await boundary; `$lib/server/api` buffers for them.
 */
const proxyApiRequest = async (event: RequestEvent): Promise<Response> => {
	const backendUrl = env.BACKEND_URL ?? `http://localhost:${env.BACKEND_PORT ?? '4000'}`;
	const target = new URL(
		event.url.pathname.replace(/^\/api/, '') + event.url.search,
		backendUrl,
	);

	const headers = new Headers(event.request.headers);
	for (const header of HOP_BY_HOP_HEADERS) {
		headers.delete(header);
	}
	headers.set('host', target.host);

	const init: ProxyRequestInit = {
		method: event.request.method,
		headers,
		body: event.request.body,
		duplex: 'half',
		// Pass backend redirects through to the browser untouched
		redirect: 'manual',
	};

	let response: Response;
	try {
		response = await fetch(target, init);
	} catch (err) {
		// fetch only rejects on transport-level failures (backend unreachable,
		// connection reset, or the request-body stream erroring — e.g. when an
		// upload exceeds the adapter-node BODY_SIZE_LIMIT). HTTP error statuses do
		// not throw. Surface a structured ApiResponse so the client gets a usable
		// error instead of an opaque 500.
		console.error('[proxy] upstream request failed', {
			method: event.request.method,
			path: event.url.pathname,
			target: target.href,
			error: err instanceof Error ? err.message : String(err),
		});
		const errorBody: ApiResponse = {
			success: false,
			error: 'Upstream request failed. The backend may be unavailable or the request body too large.',
		};
		return new Response(JSON.stringify(errorBody), {
			status: 502,
			headers: { 'content-type': 'application/json' },
		});
	}

	const responseHeaders = new Headers(response.headers);
	for (const header of HOP_BY_HOP_HEADERS) {
		responseHeaders.delete(header);
	}
	// undici has already decompressed the body — the original encoding headers
	// no longer describe it
	responseHeaders.delete('content-encoding');
	responseHeaders.delete('content-length');

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
	});
};

/**
 * Server hook — runs on every incoming request.
 * Forwards /api/* requests to the backend, otherwise reads the accessToken
 * cookie, verifies the JWT, and populates event.locals so downstream load
 * functions can access the authenticated user.
 */
export const handle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname.startsWith('/api/')) {
		return proxyApiRequest(event);
	}

	const token = event.cookies.get('accessToken');

	if (token) {
		try {
			const { payload } = await jwtVerify(token, getJwtSecret());
			const authPayload = payload as AuthTokenPayload;
			// Map JWT payload to a minimal user shape for locals
			event.locals.user = {
				id: authPayload.sub!,
				email: authPayload.email,
				first_name: null,
				last_name: null,
				role: null,
				createdAt: new Date(),
			};
			event.locals.accessToken = token;
		} catch {
			// Invalid or expired token — treat as unauthenticated
			event.locals.user = null;
			event.locals.accessToken = null;
		}
	} else {
		event.locals.user = null;
		event.locals.accessToken = null;
	}

	return resolve(event);
};
