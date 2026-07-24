import { describe, it, expect } from 'vitest';
import { EMAIL_REGEX, normalizeEmail, isValidEmail } from './validation.js';

describe('normalizeEmail', () => {
	it('lowercases and trims', () => {
		expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
	});

	it('is idempotent', () => {
		const once = normalizeEmail('Bob@Test.dev');
		expect(normalizeEmail(once)).toBe(once);
	});
});

describe('isValidEmail', () => {
	it.each([
		'user@example.com',
		'first.last@sub.domain.co',
		'user+tag@example.io',
	])('accepts %s', (email) => {
		expect(isValidEmail(email)).toBe(true);
	});

	it.each([
		'',
		'plainaddress',
		'@missing-local.com',
		'missing-at.com',
		'a@b', // no dot in domain
		'spaces in@address.com',
		'user@exam ple.com',
	])('rejects %s', (email) => {
		expect(isValidEmail(email)).toBe(false);
	});

	it('tolerates surrounding whitespace', () => {
		expect(isValidEmail('  user@example.com  ')).toBe(true);
	});

	it('EMAIL_REGEX matches the function behavior', () => {
		for (const email of ['user@example.com', 'nope', 'a@b.co']) {
			expect(EMAIL_REGEX.test(email)).toBe(isValidEmail(email));
		}
	});
});
