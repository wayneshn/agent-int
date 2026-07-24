import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import MarkdownRenderer from './MarkdownRenderer.svelte';

/**
 * The agent's streamed output is rendered as sanitized HTML. These tests pin
 * the XSS posture of that pipeline (marked → DOMPurify, USE_PROFILES html).
 * Runs under jsdom so `browser` is true and the sanitize path executes.
 */
describe('MarkdownRenderer sanitization', () => {
	it('renders basic markdown', () => {
		const { container } = render(MarkdownRenderer, { content: '**bold** and _italic_' });
		expect(container.querySelector('strong')?.textContent).toBe('bold');
		expect(container.querySelector('em')?.textContent).toBe('italic');
	});

	it('strips <script> tags from the content', () => {
		const { container } = render(MarkdownRenderer, {
			content: 'hello <script>window.pwned = true</script> world',
		});
		expect(container.querySelector('script')).toBeNull();
		expect(container.innerHTML).not.toContain('window.pwned');
		expect(container.textContent).toContain('hello');
	});

	it('strips event-handler attributes (img onerror)', () => {
		const { container } = render(MarkdownRenderer, {
			content: '<img src="https://example.com/x.png" onerror="alert(1)">',
		});
		const img = container.querySelector('img');
		expect(img).not.toBeNull();
		expect(img!.getAttribute('onerror')).toBeNull();
		expect(container.innerHTML).not.toContain('onerror');
	});

	it('neutralizes javascript: hrefs in markdown links', () => {
		const { container } = render(MarkdownRenderer, {
			content: '[click me](javascript:alert(document.cookie))',
		});
		const anchor = container.querySelector('a');
		expect(anchor).not.toBeNull();
		expect(anchor!.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
		expect(container.innerHTML).not.toContain('javascript:');
	});

	it('opens links in a new tab with safe rel', () => {
		const { container } = render(MarkdownRenderer, {
			content: '[site](https://example.com)',
		});
		const anchor = container.querySelector('a');
		expect(anchor!.getAttribute('target')).toBe('_blank');
		expect(anchor!.getAttribute('rel')).toContain('noopener');
		expect(anchor!.getAttribute('rel')).toContain('noreferrer');
	});

	it('strips iframe embeds', () => {
		const { container } = render(MarkdownRenderer, {
			content: '<iframe src="https://evil.example"></iframe>',
		});
		expect(container.querySelector('iframe')).toBeNull();
	});
});
