import { describe, it, expect } from 'vitest';
import { extractJsonValue } from './json-extract.js';

describe('extractJsonValue', () => {
	it('parses pure JSON objects', () => {
		expect(extractJsonValue('{"a": 1}')).toEqual({ a: 1 });
	});

	it('parses pure JSON arrays', () => {
		expect(extractJsonValue('[1, 2, 3]')).toEqual([1, 2, 3]);
	});

	it('parses JSON scalar values', () => {
		expect(extractJsonValue('"hello"')).toBe('hello');
		expect(extractJsonValue('42')).toBe(42);
		expect(extractJsonValue('true')).toBe(true);
		expect(extractJsonValue('null')).toBe(null);
	});

	it('strips a ```json fence', () => {
		const text = '```json\n{"a": 1}\n```';
		expect(extractJsonValue(text)).toEqual({ a: 1 });
	});

	it('strips a bare ``` fence', () => {
		const text = '```\n[1,2]\n```';
		expect(extractJsonValue(text)).toEqual([1, 2]);
	});

	it('recovers JSON embedded in prose', () => {
		const text = 'The script ran successfully. Now the result: {"status": "ok", "count": 3} hope that helps!';
		expect(extractJsonValue(text)).toEqual({ status: 'ok', count: 3 });
	});

	it('recovers a root array embedded in prose', () => {
		const text = 'Here you go: [1, {"x": true}] — done.';
		expect(extractJsonValue(text)).toEqual([1, { x: true }]);
	});

	it('handles braces inside string literals without shifting depth', () => {
		const text = 'prose {"s": "a } brace { inside"} tail';
		expect(extractJsonValue(text)).toEqual({ s: 'a } brace { inside' });
	});

	it('handles escaped quotes inside string literals', () => {
		const text = '{"s": "a \\" quoted } value"}';
		expect(extractJsonValue(text)).toEqual({ s: 'a " quoted } value' });
	});

	it('handles nested mixed brackets', () => {
		const text = 'noise {"arr": [{"deep": [1, 2]}], "n": 5} trailing';
		expect(extractJsonValue(text)).toEqual({ arr: [{ deep: [1, 2] }], n: 5 });
	});

	it('returns null for empty and whitespace-only input', () => {
		expect(extractJsonValue('')).toBe(null);
		expect(extractJsonValue('   \n  ')).toBe(null);
	});

	it('returns null when no JSON value exists', () => {
		expect(extractJsonValue('just some prose, no json here')).toBe(null);
	});

	it('returns null for unbalanced brackets', () => {
		expect(extractJsonValue('{"a": 1')).toBe(null);
	});

	it('returns null for invalid JSON inside balanced brackets', () => {
		expect(extractJsonValue('{not: valid}')).toBe(null);
	});

	it('returns null for non-string input', () => {
		expect(extractJsonValue(undefined as unknown as string)).toBe(null);
		expect(extractJsonValue(null as unknown as string)).toBe(null);
	});
});
