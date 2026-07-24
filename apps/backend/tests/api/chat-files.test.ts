import { describe, it, expect } from 'vitest';
import { setupFirstUser, createAgent, createThread } from '@repo/test-utils';
import { useBackend } from '../helpers/boot.js';

/**
 * Chat file upload/serve security properties (verified correct in the review):
 * extension allowlist, image magic-byte sniffing, filename sanitization,
 * forced attachment + nosniff for HTML, owner+thread scoping.
 */

const getServer = useBackend();

interface FileFixture {
	baseUrl: string;
	token: string;
	agentId: string;
	threadId: string;
}

async function makeFixture(): Promise<FileFixture> {
	const { baseUrl } = getServer();
	const user = await setupFirstUser(baseUrl);
	const agent = await createAgent(baseUrl, user.accessToken);
	const thread = await createThread(baseUrl, user.accessToken, agent.id as string);
	return {
		baseUrl,
		token: user.accessToken,
		agentId: agent.id as string,
		threadId: thread.id as string,
	};
}

async function upload(
	f: FileFixture,
	name: string,
	content: string | Uint8Array<ArrayBuffer>,
	mimeType = 'application/octet-stream',
): Promise<{ status: number; body: { success?: boolean; data?: Array<{ id: string; name: string }>; error?: string } }> {
	const form = new FormData();
	const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
	form.append('files', new Blob([bytes], { type: mimeType }), name);
	const res = await fetch(`${f.baseUrl}/v1/runtime/${f.agentId}/threads/${f.threadId}/files`, {
		method: 'POST',
		headers: { authorization: `Bearer ${f.token}` },
		body: form,
	});
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('chat file upload', () => {
	it('accepts an allowed document type', async () => {
		const f = await makeFixture();
		const res = await upload(f, 'notes.txt', 'hello world', 'text/plain');
		expect(res.status).toBe(201);
		expect(res.body.data?.[0]?.name).toBe('notes.txt');
	});

	it('rejects disallowed extensions', async () => {
		const f = await makeFixture();
		for (const name of ['evil.exe', 'run.sh', 'page.svg', 'archive.zip']) {
			const res = await upload(f, name, 'MZ fake');
			expect(res.status).toBe(400);
		}
	});

	it('rejects an image whose bytes fail magic-byte sniffing', async () => {
		const f = await makeFixture();
		// Claims .png but is plain text — extension is not trusted
		const res = await upload(f, 'fake.png', 'definitely not a png', 'image/png');
		expect(res.status).toBe(400);
	});

	it('sanitizes path-traversal filenames', async () => {
		const f = await makeFixture();
		const res = await upload(f, '../../etc/evil.txt', 'content', 'text/plain');
		if (res.status === 201) {
			const storedName = res.body.data![0].name;
			expect(storedName).not.toContain('..');
			expect(storedName).not.toMatch(/[/\\]/);
		} else {
			expect(res.status).toBe(400);
		}
	});

	it('serves a text file inline with nosniff', async () => {
		const f = await makeFixture();
		const created = await upload(f, 'notes.txt', 'hello world', 'text/plain');
		const fileId = created.body.data![0].id;

		const res = await fetch(
			`${f.baseUrl}/v1/runtime/${f.agentId}/threads/${f.threadId}/files/${fileId}`,
			{ headers: { authorization: `Bearer ${f.token}` } },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('content-disposition')).toContain('inline');
		expect(await res.text()).toBe('hello world');
	});

	it('forces attachment for HTML files (stored-XSS guard)', async () => {
		const f = await makeFixture();
		const created = await upload(f, 'page.html', '<html><body>x</body></html>', 'text/html');
		expect(created.status).toBe(201);
		const fileId = created.body.data![0].id;

		const res = await fetch(
			`${f.baseUrl}/v1/runtime/${f.agentId}/threads/${f.threadId}/files/${fileId}`,
			{ headers: { authorization: `Bearer ${f.token}` } },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toContain('attachment');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('requires auth and enforces thread scoping on serve', async () => {
		const f = await makeFixture();
		const created = await upload(f, 'notes.txt', 'hello world', 'text/plain');
		const fileId = created.body.data![0].id;

		// No token
		const noAuth = await fetch(
			`${f.baseUrl}/v1/runtime/${f.agentId}/threads/${f.threadId}/files/${fileId}`,
		);
		expect(noAuth.status).toBe(401);

		// Wrong threadId in path
		const wrongThread = await fetch(
			`${f.baseUrl}/v1/runtime/${f.agentId}/threads/00000000-0000-4000-8000-000000000000/files/${fileId}`,
			{ headers: { authorization: `Bearer ${f.token}` } },
		);
		expect([403, 404]).toContain(wrongThread.status);
	});

	it('deletes a file', async () => {
		const f = await makeFixture();
		const created = await upload(f, 'notes.txt', 'hello world', 'text/plain');
		const fileId = created.body.data![0].id;

		const del = await fetch(
			`${f.baseUrl}/v1/runtime/${f.agentId}/threads/${f.threadId}/files/${fileId}`,
			{ method: 'DELETE', headers: { authorization: `Bearer ${f.token}` } },
		);
		expect([200, 204]).toContain(del.status);

		const res = await fetch(
			`${f.baseUrl}/v1/runtime/${f.agentId}/threads/${f.threadId}/files/${fileId}`,
			{ headers: { authorization: `Bearer ${f.token}` } },
		);
		expect(res.status).toBe(404);
	});
});
