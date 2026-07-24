import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

/**
 * Component/unit tests for the SvelteKit app. The sveltekit plugin resolves
 * $app/* and $lib/*; svelteTesting() adds the browser resolve conditions so
 * components compile for the client (not SSR) under vitest. jsdom provides
 * the DOM so browser-only paths (e.g. DOMPurify sanitization) execute.
 */
export default defineConfig({
	plugins: [sveltekit(), svelteTesting()],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'jsdom',
		globals: true,
	},
});
