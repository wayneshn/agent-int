import { describe, it } from 'vitest';

/**
 * PENDING FIX — security review finding C5a (agent-rendered links allow
 * `javascript:` URLs → click-triggered stored XSS in the app origin).
 *
 * The fix introduces a shared URL-scheme validator (allow https:, http:,
 * mailto: only) used by UiLink.svelte (href) and OpenUiBlock.svelte
 * (window.open on the OpenUrl builtin action). These todos are the
 * acceptance tests for that fix — implement them against the validator
 * and the two call sites when the fix lands.
 */
describe('URL scheme validation for agent-rendered UI (PENDING FIX C5a)', () => {
	it.todo('accepts https:, http:, and mailto: URLs');

	it.todo('rejects javascript:, data:, vbscript:, and file: URLs');

	it.todo('rejects scheme-relative and control-character-smuggling URLs (e.g. "java\tscript:")');

	it.todo('UiLink does not render a navigable href for a rejected scheme');

	it.todo('OpenUiBlock OpenUrl action does not call window.open for a rejected scheme');
});
