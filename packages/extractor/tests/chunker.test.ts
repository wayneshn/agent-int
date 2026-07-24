import { describe, it, expect } from 'vitest';
import { chunkSegments } from '../src/chunker.js';
import type { ExtractedSegment } from '@repo/types';

function segment(text: string, page = 1): ExtractedSegment {
	return { location: { type: 'page', label: `Page ${page}`, page }, text };
}

function words(n: number, word = 'w'): string {
	return Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
}

describe('chunkSegments', () => {
	it('packs a small segment into a single chunk', () => {
		const chunks = chunkSegments([segment('hello world')]);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].content).toBe('hello world');
		expect(chunks[0].location.page).toBe(1);
		expect(chunks[0].index).toBe(0);
	});

	it('packs paragraphs greedily up to targetWords', () => {
		const text = `${words(300, 'a')}\n\n${words(300, 'b')}\n\n${words(300, 'c')}`;
		const chunks = chunkSegments([segment(text)], { targetWords: 400, maxWords: 600, minWords: 1 });
		// 300 fits; 300+300 exceeds target ⇒ new chunk; same for the third
		expect(chunks.length).toBe(3);
	});

	it('never crosses segment boundaries', () => {
		const chunks = chunkSegments([segment('first page text', 1), segment('second page text', 2)]);
		expect(chunks).toHaveLength(2);
		expect(chunks[0].location.page).toBe(1);
		expect(chunks[1].location.page).toBe(2);
		// Global monotonic index
		expect(chunks.map((c) => c.index)).toEqual([0, 1]);
	});

	it('hard-splits a paragraph exceeding maxWords', () => {
		const text = words(1300, 'x');
		const chunks = chunkSegments([segment(text)], { targetWords: 400, maxWords: 600, minWords: 1 });
		for (const chunk of chunks) {
			expect(chunk.content.split(/\s+/).length).toBeLessThanOrEqual(600);
		}
		expect(chunks.length).toBeGreaterThanOrEqual(3);
	});

	it('splits an oversize paragraph on sentence boundaries when possible', () => {
		const sentence = `${words(200, 's')}.`;
		const text = `${sentence} ${sentence} ${sentence} ${sentence}`;
		const chunks = chunkSegments([segment(text)], { targetWords: 450, maxWords: 600, minWords: 1 });
		// 4 × 200-word sentences; 200+200 ≤ 450 packs, adding a third exceeds target
		expect(chunks.length).toBe(2);
		// Sentence-boundary split (not the hard word cut) ⇒ each chunk holds whole sentences
		expect(chunks[0].content.trim().endsWith('.')).toBe(true);
	});

	it('merges an undersized tail chunk into the previous one (same segment)', () => {
		const text = `${words(350, 'a')}\n\n${words(10, 'b')}`;
		const chunks = chunkSegments([segment(text)], { targetWords: 300, maxWords: 600, minWords: 40 });
		// Tail (10 words < minWords) merges: 350 + 10 <= maxWords
		expect(chunks).toHaveLength(1);
		expect(chunks[0].content).toContain('b0');
	});

	it('skips empty segments', () => {
		const chunks = chunkSegments([segment('   '), segment('real content')]);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].content).toBe('real content');
	});
});
