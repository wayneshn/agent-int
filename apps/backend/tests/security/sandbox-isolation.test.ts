import { describe, it } from 'vitest';

/**
 * PENDING FIXES — sandbox isolation findings from the security review.
 * Acceptance tests for fixes that change behavior not yet implemented.
 * Implement each in the same PR as its fix.
 */
describe('process driver fail-closed default (PENDING FIX C3)', () => {
	it.todo(
		'backend refuses to serve agent turns when AGENT_RUNTIME_DRIVER is unset/invalid ' +
			'and no explicit unsafe-process-driver opt-in is set',
	);
	it.todo(
		'AGENT_RUNTIME_DRIVER=process requires the explicit opt-in acknowledgement env var ' +
			'and logs a loud warning about the missing isolation',
	);
});

describe('workspace symlink containment (PENDING FIX C4)', () => {
	it.todo(
		'share_file rejects a workspace symlink whose target escapes the agent workspace ' +
			'(realpath-based containment, not just lexical prefix checks)',
	);
	it.todo(
		'read_file/write_file resolve symlinks and reject targets outside the workspace ' +
			'(plant link -> /etc/passwd in the workspace and expect rejection)',
	);
	it.todo(
		'cross-agent escape via link -> ../<other-agent-uuid>/file is rejected ' +
			'(all agents share one volume in docker mode)',
	);
});

describe('Notion webhook verification token (PENDING FIX M7)', () => {
	it.todo(
		'a verification_token is accepted only when none is stored yet ' +
			'(an anonymous caller must not overwrite the HMAC token after initial capture)',
	);
	it.todo(
		'events signed with an attacker-supplied token are rejected after the legitimate ' +
			'token was captured',
	);
});

describe('auth hardening (PENDING FIXES M1–M5)', () => {
	it.todo('login has a dedicated strict rate limit (429 after a handful of failures) — M1');
	it.todo('concurrent /v1/auth/setup requests create exactly one admin (transaction/unique) — M2');
	it.todo('passwords below the minimum length are rejected on setup/create/change — M3');
	it.todo('?token= query authentication is accepted only on the SSE stream route — M4');
	it.todo('password change invalidates previously issued tokens — M5');
});

describe('extractor resource limits (PENDING FIX M8)', () => {
	it.todo('a pathological OOXML file (zip bomb ratio) is rejected before full decompression');
	it.todo('xlsx extraction respects a row/cell cap instead of materializing unbounded sheets');
	it.todo('pdf extraction respects a page/time cap');
});

describe('response size + timeout bounds (PENDING FIX M9)', () => {
	it.todo('call_api responses above the size cap are truncated/rejected (backend memory bound)');
	it.todo('MCP tool results above the size cap are truncated/rejected');
});
