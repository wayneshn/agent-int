import { describe, it, expect } from 'vitest';
import { evalFilter, isUnaryOperator } from './filter.js';
import type { FilterCondition, FilterValue } from '@repo/types';

/** Identity resolver — templates are already concrete values in these tests. */
const id = (s: string): string => s;

function filter(combinator: 'and' | 'or', ...conditions: FilterCondition[]): FilterValue {
	return { combinator, conditions };
}

describe('isUnaryOperator', () => {
	it('marks unary operators', () => {
		for (const op of ['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse', 'exists', 'notExists'] as const) {
			expect(isUnaryOperator(op)).toBe(true);
		}
	});

	it('marks binary operators as non-unary', () => {
		for (const op of ['equals', 'contains', 'gt', 'lte'] as const) {
			expect(isUnaryOperator(op)).toBe(false);
		}
	});
});

describe('evalFilter', () => {
	it('empty conditions ⇒ true', () => {
		expect(evalFilter(filter('and'), id)).toBe(true);
		expect(evalFilter(filter('or'), id)).toBe(true);
	});

	it('AND combinator requires all conditions', () => {
		const f = filter(
			'and',
			{ left: 'a', operator: 'equals', right: 'a' },
			{ left: 'a', operator: 'equals', right: 'b' },
		);
		expect(evalFilter(f, id)).toBe(false);
	});

	it('OR combinator requires any condition', () => {
		const f = filter(
			'or',
			{ left: 'a', operator: 'equals', right: 'b' },
			{ left: 'a', operator: 'equals', right: 'a' },
		);
		expect(evalFilter(f, id)).toBe(true);
	});

	it('resolves templates through the resolver', () => {
		const resolve = (s: string): string => (s === '{{x}}' ? 'resolved' : s);
		const f = filter('and', { left: '{{x}}', operator: 'equals', right: 'resolved' });
		expect(evalFilter(f, resolve)).toBe(true);
	});
});

describe('operators', () => {
	const cases: Array<[FilterCondition['operator'], string, string | undefined, boolean]> = [
		['equals', 'a', 'a', true],
		['equals', 'a', 'b', false],
		['notEquals', 'a', 'b', true],
		['contains', 'hello world', 'world', true],
		['contains', 'hello', 'world', false],
		['notContains', 'hello', 'world', true],
		['gt', '5', '3', true],
		['gt', '3', '5', false],
		['gte', '5', '5', true],
		['lt', '3', '5', true],
		['lte', '5', '5', true],
		// NaN coerces to 0 on both sides
		['gt', 'not-a-number', '-1', true],
		['equals', '0', 'not-a-number', false],
		['isEmpty', '', undefined, true],
		['isEmpty', '   ', undefined, true],
		['isEmpty', 'x', undefined, false],
		['isNotEmpty', 'x', undefined, true],
		['isTrue', 'true', undefined, true],
		['isTrue', '1', undefined, true],
		['isTrue', 'false', undefined, false],
		['isFalse', 'false', undefined, true],
		['isFalse', '0', undefined, true],
		['isFalse', '', undefined, true],
		['isFalse', 'true', undefined, false],
		['exists', 'value', undefined, true],
		['exists', '', undefined, false],
		['exists', 'undefined', undefined, false],
		['exists', 'null', undefined, false],
		['notExists', 'undefined', undefined, true],
		['notExists', 'value', undefined, false],
	];

	it.each(cases)('%s(%j, %j) ⇒ %s', (operator, left, right, expected) => {
		const f = filter('and', { left, operator, right });
		expect(evalFilter(f, id)).toBe(expected);
	});

	it('unknown operator ⇒ false', () => {
		const f = filter('and', {
			left: 'a',
			operator: 'bogus' as FilterCondition['operator'],
			right: 'a',
		});
		expect(evalFilter(f, id)).toBe(false);
	});
});
