import { isIP } from 'net';
import { lookup as dnsLookup } from 'dns/promises';

/**
 * Shared SSRF guard for outbound connections the backend makes on behalf of an
 * agent (MCP servers, the headless browser). Refuses non-http(s) schemes and any
 * host that resolves to a loopback, link-local (incl. the 169.254.169.254 cloud
 * metadata endpoint), RFC-1918 private, CGNAT, or IPv6 unique-local/transition
 * address — the classic SSRF targets.
 *
 * The address check is byte-based (see `ipv6ToBytes`), so an IPv4-mapped or
 * NAT64-embedded IPv4 address is caught no matter how the WHATWG URL parser spells
 * it (e.g. `::ffff:127.0.0.1` normalizes to the hex form `::ffff:7f00:1`).
 *
 * Hostnames are DNS-resolved and EVERY resolved address is checked. This is
 * best-effort against DNS rebinding — the address the transport later dials is not
 * pinned, so a rebinding host can still swap the answer between this check and the
 * connect. That gap is tracked separately.
 */

/**
 * Refuse a URL that is non-http(s) or resolves to a blocked (private/loopback/…)
 * address. Throws with an actionable message; resolves when the URL is allowed.
 * Unresolvable hostnames are allowed through — the connection attempt fails the
 * same way, and we do not want DNS flakiness to look like a policy block.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`"${rawUrl}" is not a valid absolute URL`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('Only http and https URLs are allowed');
	}
	const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
	let addresses: string[];
	if (isIP(hostname) !== 0) {
		addresses = [hostname];
	} else {
		try {
			addresses = (await dnsLookup(hostname, { all: true })).map((r) => r.address);
		} catch {
			return; // unresolvable — the connection attempt will fail the same way
		}
	}
	for (const addr of addresses) {
		if (isBlockedAddress(addr)) {
			throw new Error(
				`URL host "${parsed.hostname}" resolves to a private/loopback address (${addr})`,
			);
		}
	}
}

/**
 * True for a loopback / private / link-local / unique-local / CGNAT /
 * unspecified/"this-network" address — for both IPv4 and IPv6 (incl. IPv4-mapped
 * and NAT64-embedded IPv4).
 */
export function isBlockedAddress(ip: string): boolean {
	const fam = isIP(ip);
	if (fam === 4) return isBlockedIPv4(ip);
	if (fam === 6) {
		const bytes = ipv6ToBytes(ip.toLowerCase());
		if (!bytes) return true; // unparseable → block defensively
		// IPv4-mapped (::ffff:a.b.c.d, however the URL parser spelled it) — the
		// embedded v4 is what actually gets dialled on a dual-stack host.
		if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
			return isBlockedIPv4(bytes.slice(12).join('.'));
		}
		// NAT64 (64:ff9b::/96) — the well-known prefix re-embeds an IPv4 address in
		// the low 32 bits; on a NAT64-enabled host it forwards to that IPv4.
		if (
			bytes[0] === 0x00 &&
			bytes[1] === 0x64 &&
			bytes[2] === 0xff &&
			bytes[3] === 0x9b &&
			bytes.slice(4, 12).every((b) => b === 0)
		) {
			return isBlockedIPv4(bytes.slice(12).join('.'));
		}
		// ::, ::1, and IPv4-compatible ::a.b.c.d (all start with 12 zero bytes).
		if (bytes.slice(0, 12).every((b) => b === 0)) return true;
		if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
		if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
		return false;
	}
	return true; // not parseable as an IP → block defensively
}

/** Expand an IPv6 literal (incl. `::` compression and trailing dotted IPv4) to 16 bytes, or null. */
export function ipv6ToBytes(ip: string): number[] | null {
	const raw = ip.split('%')[0]; // drop any zone id
	let head = raw;
	const dotted = raw.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (dotted) {
		const v4 = dotted.slice(1).map(Number);
		if (v4.some((n) => n > 255)) return null;
		const h1 = ((v4[0] << 8) | v4[1]).toString(16);
		const h2 = ((v4[2] << 8) | v4[3]).toString(16);
		head = raw.slice(0, raw.length - dotted[0].length) + h1 + ':' + h2;
	}
	const halves = head.split('::');
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(':') : [];
	const right = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
	let groups: string[];
	if (right === null) {
		groups = left;
	} else {
		const missing = 8 - (left.length + right.length);
		if (missing < 0) return null;
		groups = [...left, ...Array<string>(missing).fill('0'), ...right];
	}
	if (groups.length !== 8) return null;
	const bytes: number[] = [];
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
		const v = parseInt(g, 16);
		bytes.push((v >> 8) & 0xff, v & 0xff);
	}
	return bytes;
}

/** True for loopback / private / link-local / CGNAT / unspecified IPv4 addresses. */
export function isBlockedIPv4(ip: string): boolean {
	const parts = ip.split('.').map((p) => Number(p));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return true; // malformed → block defensively
	}
	const [a, b] = parts;
	if (a === 0) return true; // 0.0.0.0/8 "this" network
	if (a === 127) return true; // loopback
	if (a === 10) return true; // private
	if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 168) return true; // private
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64.0.0/10)
	return false;
}
