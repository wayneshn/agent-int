import { describe, it, expect } from 'vitest';
import { assertPublicUrl, isBlockedAddress, isBlockedIPv4, ipv6ToBytes } from './ssrfGuard.js';

describe('isBlockedIPv4', () => {
	it.each([
		['0.0.0.0', true],
		['0.1.2.3', true], // 0/8 "this" network
		['127.0.0.1', true],
		['127.255.255.254', true],
		['10.0.0.1', true],
		['10.255.255.255', true],
		['169.254.169.254', true], // cloud metadata
		['169.254.0.1', true],
		['172.16.0.1', true],
		['172.31.255.255', true],
		['172.15.0.1', false], // just outside 172.16/12
		['172.32.0.1', false], // just outside 172.16/12
		['192.168.0.1', true],
		['192.168.255.255', true],
		['192.167.0.1', false],
		['100.64.0.1', true], // CGNAT start
		['100.127.255.255', true], // CGNAT end
		['100.63.255.255', false], // just below CGNAT
		['100.128.0.0', false], // just above CGNAT
		['8.8.8.8', false],
		['1.1.1.1', false],
	])('%s ⇒ %s', (ip, expected) => {
		expect(isBlockedIPv4(ip)).toBe(expected);
	});

	it.each(['256.1.1.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '1.2.3.-1', ''])(
		'malformed %j ⇒ blocked defensively',
		(ip) => {
			expect(isBlockedIPv4(ip)).toBe(true);
		},
	);
});

describe('ipv6ToBytes', () => {
	it('expands full form', () => {
		expect(ipv6ToBytes('2001:0db8:0000:0000:0000:ff00:0042:8329')).toEqual([
			0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0xff, 0x00, 0x00, 0x42, 0x83, 0x29,
		]);
	});

	it('expands :: compression', () => {
		expect(ipv6ToBytes('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
		expect(ipv6ToBytes('::')).toEqual(new Array(16).fill(0));
		expect(ipv6ToBytes('fe80::1')).toEqual([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
	});

	it('expands IPv4-mapped form (::ffff:a.b.c.d)', () => {
		expect(ipv6ToBytes('::ffff:127.0.0.1')).toEqual([
			0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1,
		]);
	});

	it('drops a zone id', () => {
		expect(ipv6ToBytes('fe80::1%eth0')).toEqual(ipv6ToBytes('fe80::1'));
	});

	it.each([':::', '1:2:3:4:5:6:7:8:9', 'gg::1', '::ffff:999.1.1.1', '1::2::3'])(
		'rejects malformed %j',
		(ip) => {
			expect(ipv6ToBytes(ip)).toBeNull();
		},
	);
});

describe('isBlockedAddress (IPv6)', () => {
	it.each([
		['::1', true], // loopback
		['::', true], // unspecified
		['::ffff:127.0.0.1', true], // v4-mapped loopback
		['::ffff:7f00:1', true], // v4-mapped loopback, hex spelling
		['::ffff:8.8.8.8', false], // v4-mapped public
		['64:ff9b::7f00:1', true], // NAT64-embedded 127.0.0.1
		['64:ff9b::808:808', false], // NAT64-embedded 8.8.8.8
		['fc00::1', true], // unique-local
		['fd00::1', true], // unique-local
		['fe80::1', true], // link-local
		['febf::1', true], // link-local (top edge of fe80::/10)
		['fec0::1', false], // outside fe80::/10 (deprecated site-local; guard does not block)
		['2606:4700:4700::1111', false], // Cloudflare DNS
	])('%s ⇒ %s', (ip, expected) => {
		expect(isBlockedAddress(ip)).toBe(expected);
	});

	it('blocks unparseable input defensively', () => {
		expect(isBlockedAddress('not-an-ip')).toBe(true);
	});
});

describe('assertPublicUrl', () => {
	it('rejects non-http(s) schemes', async () => {
		await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http and https/);
		await expect(assertPublicUrl('ftp://example.com/x')).rejects.toThrow(/http and https/);
		await expect(assertPublicUrl('gopher://example.com')).rejects.toThrow(/http and https/);
	});

	it('rejects invalid URLs', async () => {
		await expect(assertPublicUrl('not a url')).rejects.toThrow(/not a valid absolute URL/);
	});

	it('rejects loopback IP literals', async () => {
		await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow(/private\/loopback/);
		await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow(/private\/loopback/);
	});

	it('rejects the cloud metadata endpoint', async () => {
		await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
			/private\/loopback/,
		);
	});

	it('rejects RFC-1918 and CGNAT literals', async () => {
		await expect(assertPublicUrl('http://10.1.2.3/')).rejects.toThrow(/private\/loopback/);
		await expect(assertPublicUrl('http://192.168.1.1/')).rejects.toThrow(/private\/loopback/);
		await expect(assertPublicUrl('http://172.20.0.5/')).rejects.toThrow(/private\/loopback/);
		await expect(assertPublicUrl('http://100.100.0.1/')).rejects.toThrow(/private\/loopback/);
	});

	it('rejects IPv4-mapped IPv6 loopback however spelled', async () => {
		await expect(assertPublicUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/private\/loopback/);
		await expect(assertPublicUrl('http://[::ffff:7f00:1]/')).rejects.toThrow(/private\/loopback/);
	});

	it('allows public IP literals', async () => {
		await expect(assertPublicUrl('http://8.8.8.8/')).resolves.toBeUndefined();
		await expect(assertPublicUrl('https://1.1.1.1/path?q=1')).resolves.toBeUndefined();
	});

	it('rejects localhost (resolves to loopback via hosts file)', async () => {
		await expect(assertPublicUrl('http://localhost:4000/')).rejects.toThrow(/private\/loopback/);
	});

	it('allows unresolvable hostnames through (connection fails the same way)', async () => {
		// .invalid is reserved by RFC 2606 — guaranteed to never resolve.
		await expect(assertPublicUrl('http://definitely-not-real.invalid/')).resolves.toBeUndefined();
	});
});
