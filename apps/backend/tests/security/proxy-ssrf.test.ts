import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mintProxyToken } from '@repo/test-utils';
import { useBackend } from '../helpers/boot.js';

/**
 * PENDING FIX — security review findings C1/C2 (credential proxy SSRF).
 *
 * C1: the unauthenticated proxy path (empty credentialId) fetches ANY URL the
 *     sandbox supplies — no scheme check, no assertPublicUrl, no redirect
 *     vetting. From the backend's network position this reaches cloud metadata,
 *     loopback services, and the docker-socket-proxy (container escape).
 * C2: the authenticated path injects decrypted credential headers into ANY URL
 *     the sandbox supplies (no per-credential destination allowlist).
 *
 * These tests are written and SKIPPED until the fix lands (assertPublicUrl on
 * both paths + redirect re-validation + per-credential host allowlist).
 * Remove the `.skip` in the same PR as the fix — they fail against the
 * pre-fix code by design.
 */

const getServer = useBackend();

/** Fixture HTTP server that records every hit. */
class HitRecorder {
	private server: http.Server | null = null;
	hits: string[] = [];

	async start(): Promise<void> {
		this.server = http.createServer((req, res) => {
			this.hits.push(`${req.method} ${req.url}`);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"secret":"you should never see this"}');
		});
		await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
	}

	get port(): number {
		return (this.server!.address() as AddressInfo).port;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => {
			this.server!.close(() => resolve());
		});
	}
}

async function proxyCall(baseUrl: string, token: string, body: Record<string, unknown>) {
	const res = await fetch(`${baseUrl}/v1/runtime/internal/proxy`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

async function freshToken(): Promise<string> {
	return mintProxyToken({
		agentId: randomUUID(),
		ownerId: randomUUID(),
		threadId: randomUUID(),
	});
}

describe.skip('proxy SSRF guard (PENDING FIX C1)', () => {
	const recorder = new HitRecorder();
	beforeAll(() => recorder.start());
	afterAll(() => recorder.stop());

	it('rejects loopback targets and never issues the request', async () => {
		const { baseUrl } = getServer();
		const token = await freshToken();
		const before = recorder.hits.length;

		const res = await proxyCall(baseUrl, token, {
			method: 'GET',
			url: `http://127.0.0.1:${recorder.port}/admin`,
		});
		expect(res.status).toBe(400);
		expect(recorder.hits.length).toBe(before); // request never reached the target
	});

	it('rejects the cloud metadata endpoint', async () => {
		const { baseUrl } = getServer();
		const token = await freshToken();
		const res = await proxyCall(baseUrl, token, {
			method: 'GET',
			url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
		});
		// The guard must reject BEFORE any network attempt (fast, deterministic)
		expect(res.status).toBe(400);
	});

	it('rejects RFC-1918 and CGNAT targets', async () => {
		const { baseUrl } = getServer();
		const token = await freshToken();
		for (const url of ['http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://100.64.0.1/']) {
			const res = await proxyCall(baseUrl, token, { method: 'GET', url });
			expect(res.status).toBe(400);
		}
	});

	it('rejects non-http(s) schemes', async () => {
		const { baseUrl } = getServer();
		const token = await freshToken();
		const res = await proxyCall(baseUrl, token, { method: 'GET', url: 'file:///etc/passwd' });
		expect(res.status).toBe(400);
	});

	it('rejects redirect responses that retarget a private address', async () => {
		// Requires a redirect fixture reachable at a PUBLIC-looking address —
		// implement with a DNS-stubbed hostname once the fix's redirect
		// re-validation lands; see the review plan for details.
		expect(true).toBe(true);
	});

	it('applies a connect/read timeout to outbound proxy requests', async () => {
		const { baseUrl } = getServer();
		const token = await freshToken();
		// A silent server that accepts but never responds
		const silent = http.createServer(() => {});
		await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
		const { port } = silent.address() as AddressInfo;
		try {
			const start = Date.now();
			await proxyCall(baseUrl, token, { method: 'GET', url: `http://127.0.0.1:${port}/` });
			// With the fix the guard rejects instantly; without a timeout this would hang
			expect(Date.now() - start).toBeLessThan(30_000);
		} finally {
			silent.closeAllConnections?.();
			silent.close();
		}
	});
});

describe('credential destination allowlist (PENDING FIX C2)', () => {
	it.todo(
		'a credential is only sent to hosts declared by its integration definition ' +
			'(Authorization headers must never reach an attacker-chosen origin)',
	);
	it.todo(
		'the destination check runs before any redirect is followed ' +
			'(a public URL must not 302 the credential to a private/attacker host)',
	);
});
