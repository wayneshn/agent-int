import { describe, it, expect } from 'vitest';
import { AgentProxyService } from './AgentProxyService.js';
import type { ProxyRequest } from '@repo/types';

/**
 * Unit tests for the pure request-shaping helpers on AgentProxyService
 * (header sanitization and outbound body building). These are private methods;
 * tests reach them through a narrowly-typed accessor so refactors that rename
 * them fail loudly here. No DB, no fetch, no credential resolver.
 */

interface PrivateShape {
	sanitizeHeaders(h?: Record<string, string>): Record<string, string> | undefined;
	stripContentType(h?: Record<string, string>): Record<string, string> | undefined;
	applyOutboundContentType(
		h: Record<string, string> | undefined,
		outbound: { isMultipart: boolean; contentType?: string },
	): Record<string, string> | undefined;
	buildOutboundBody(request: ProxyRequest): {
		body: string | Blob | FormData | undefined;
		isMultipart: boolean;
		contentType?: string;
	};
}

function makeService(): PrivateShape {
	const svc = new AgentProxyService(
		null as unknown as ConstructorParameters<typeof AgentProxyService>[0],
		'test-secret',
	);
	return svc as unknown as PrivateShape;
}

describe('sanitizeHeaders', () => {
	it('strips surrounding quotes LLMs wrap around header names', () => {
		const svc = makeService();
		expect(svc.sanitizeHeaders({ '"Content-Type"': 'application/json', Accept: 'x' })).toEqual({
			'Content-Type': 'application/json',
			Accept: 'x',
		});
	});

	it('leaves valid header names untouched', () => {
		const svc = makeService();
		expect(svc.sanitizeHeaders({ 'X-Api-Key': 'k' })).toEqual({ 'X-Api-Key': 'k' });
	});

	it('passes through undefined', () => {
		expect(makeService().sanitizeHeaders(undefined)).toBeUndefined();
	});
});

describe('applyOutboundContentType', () => {
	it('drops caller Content-Type for multipart bodies', () => {
		const svc = makeService();
		const out = svc.applyOutboundContentType(
			{ 'content-type': 'text/plain', 'X-Other': '1' },
			{ isMultipart: true },
		);
		expect(out).toEqual({ 'X-Other': '1' });
	});

	it('keeps caller Content-Type for non-multipart bodies', () => {
		const svc = makeService();
		const out = svc.applyOutboundContentType(
			{ 'Content-Type': 'application/json' },
			{ isMultipart: false },
		);
		expect(out).toEqual({ 'Content-Type': 'application/json' });
	});

	it('sets an explicit contentType verbatim (multipart/related boundary case)', () => {
		const svc = makeService();
		const out = svc.applyOutboundContentType(undefined, {
			isMultipart: true,
			contentType: 'multipart/related; boundary=AbC',
		});
		expect(out).toEqual({ 'Content-Type': 'multipart/related; boundary=AbC' });
	});
});

describe('buildOutboundBody', () => {
	const baseRequest: ProxyRequest = {
		method: 'POST',
		url: 'https://example.com',
	} as ProxyRequest;

	it('returns the raw string body by default', () => {
		const svc = makeService();
		const out = svc.buildOutboundBody({ ...baseRequest, body: '{"a":1}' });
		expect(out.isMultipart).toBe(false);
		expect(out.body).toBe('{"a":1}');
	});

	it('returns undefined body when none is set', () => {
		const svc = makeService();
		const out = svc.buildOutboundBody({ ...baseRequest });
		expect(out.body).toBeUndefined();
		expect(out.isMultipart).toBe(false);
	});

	it('decodes base64 bodies into bytes', async () => {
		const svc = makeService();
		const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
		const out = svc.buildOutboundBody({
			...baseRequest,
			body: Buffer.from(raw).toString('base64'),
			bodyEncoding: 'base64',
		});
		expect(out.isMultipart).toBe(false);
		expect(out.body).toBeInstanceOf(Blob);
		const bytes = new Uint8Array(await (out.body as Blob).arrayBuffer());
		expect(Array.from(bytes)).toEqual(Array.from(raw));
	});

	it('builds multipart/related with a boundary and base64 part decoding', async () => {
		const svc = makeService();
		const out = svc.buildOutboundBody({
			...baseRequest,
			multipartSubtype: 'related',
			multipart: [
				{ name: 'meta', contentType: 'application/json', value: '{"name":"x"}' },
				{
					name: 'blob',
					contentType: 'image/png',
					dataBase64: Buffer.from('PNGDATA').toString('base64'),
				},
			],
		} as ProxyRequest);
		expect(out.isMultipart).toBe(true);
		expect(out.contentType).toMatch(/^multipart\/related; boundary=valmisrelated[0-9a-f]{32}$/);
		const text = await (out.body as Blob).text();
		const boundary = out.contentType!.split('boundary=')[1];
		expect(text).toContain(`--${boundary}\r\nContent-Type: application/json\r\n\r\n{"name":"x"}`);
		expect(text).toContain('Content-Type: image/png\r\n\r\nPNGDATA');
		expect(text.trim().endsWith(`--${boundary}--`)).toBe(true);
	});

	it('builds form-data multipart with fields and files', async () => {
		const svc = makeService();
		const out = svc.buildOutboundBody({
			...baseRequest,
			multipart: [
				{ name: 'field', value: 'value' },
				{
					name: 'file',
					filename: 'a.txt',
					contentType: 'text/plain',
					dataBase64: Buffer.from('file-bytes').toString('base64'),
				},
			],
		} as ProxyRequest);
		expect(out.isMultipart).toBe(true);
		expect(out.contentType).toBeUndefined(); // fetch sets it with the boundary
		const form = out.body as FormData;
		expect(form.get('field')).toBe('value');
		const file = form.get('file') as File;
		expect(file.name).toBe('a.txt');
		expect(await file.text()).toBe('file-bytes');
	});
});
