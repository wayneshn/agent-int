import type { RequestEvent } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import type { ApiResponse } from '@repo/types';

const BASE_URL = '/api/v1';

/**
 * HTTP statuses that must not carry a body. Passing a non-null body for one of
 * these makes the `Response` constructor throw.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Server-side API client for use in SvelteKit load functions and form actions.
 * Reads the access token from the cookie store and uses event.fetch so Vite's
 * dev proxy is respected.
 *
 * Throws a SvelteKit error() on non-OK responses so they properly propagate
 * to the nearest +error.svelte page.
 *
 * The response body is drained into memory here, and a fresh Response backed by
 * that buffer is returned. This is deliberate — do NOT "optimise" it back into
 * returning the streamed response directly.
 *
 * `event.fetch` on a same-origin URL does not go over HTTP: SvelteKit routes it
 * through this app's own `handle` hook, where `proxyApiRequest` streams the
 * upstream backend socket back via `new Response(response.body)`. A caller that
 * holds several of those unread responses across an await boundary — the usual
 * `const [a, b] = await Promise.all([api(...), api(...)])` then read each in
 * turn — can find a stream already torn down by the time it reads it, which
 * fails as `TypeError: Body is unusable: Body has already been read`.
 * Draining immediately, before any other await can interleave, closes that gap.
 */
export const api = async (
	url: string,
	event: RequestEvent,
	options: RequestInit = {}
): Promise<Response> => {
	const token = event.cookies.get('accessToken');
	const response = await event.fetch(`${BASE_URL}${url}`, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(options.headers as Record<string, string>)
		}
	});

	const buffer = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();

	// Throw SvelteKit error on non-OK responses so they propagate to +error.svelte
	if (!response.ok) {
		let errorMessage = 'An error occurred';
		try {
			const decoded = new TextDecoder().decode(buffer ?? new ArrayBuffer(0));
			const body = JSON.parse(decoded) as ApiResponse;
			if (body.error && typeof body.error === 'string') {
				errorMessage = body.error;
			}
		} catch {
			// If response is not JSON or parsing fails, use default message
			errorMessage = response.statusText || errorMessage;
		}
		throw error(response.status, errorMessage);
	}

	// The body has already been decoded by undici, so the transfer-related
	// headers no longer describe what the caller will read.
	const headers = new Headers(response.headers);
	headers.delete('content-encoding');
	headers.delete('content-length');

	return new Response(buffer, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
};
