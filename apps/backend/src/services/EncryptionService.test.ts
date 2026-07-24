import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { EncryptionService } from './EncryptionService.js';

const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('hex');

describe('EncryptionService', () => {
	beforeEach(() => {
		vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', KEY_A);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('throws when the key is missing', () => {
		vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', '');
		delete process.env.CREDENTIAL_ENCRYPTION_KEY;
		expect(() => new EncryptionService()).toThrow(/not set/);
	});

	it('throws when the key is not 32 bytes hex', () => {
		vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', 'abcd'); // 2 bytes
		expect(() => new EncryptionService()).toThrow(/32-byte/);
	});

	it('encrypt → decrypt round-trips', () => {
		const svc = new EncryptionService();
		const secret = 'super-secret-api-token 🔑';
		expect(svc.decrypt(svc.encrypt(secret))).toBe(secret);
	});

	it('produces iv:tag:payload hex format', () => {
		const svc = new EncryptionService();
		const parts = svc.encrypt('x').split(':');
		expect(parts).toHaveLength(3);
		expect(parts[0]).toMatch(/^[0-9a-f]{32}$/); // 16-byte IV
		expect(parts[1]).toMatch(/^[0-9a-f]{32}$/); // 16-byte auth tag
		expect(parts[2]).toMatch(/^[0-9a-f]*$/);
	});

	it('uses a fresh IV per encryption (no nonce reuse)', () => {
		const svc = new EncryptionService();
		const a = svc.encrypt('same plaintext');
		const b = svc.encrypt('same plaintext');
		expect(a).not.toBe(b);
		expect(a.split(':')[0]).not.toBe(b.split(':')[0]);
	});

	it('rejects a tampered ciphertext (GCM auth tag)', () => {
		const svc = new EncryptionService();
		const [iv, tag, payload] = svc.encrypt('hello').split(':');
		// Flip one hex pair in the payload
		const tampered = `${iv}:${tag}:${payload.slice(0, -2)}${payload.endsWith('00') ? '01' : '00'}`;
		expect(() => svc.decrypt(tampered)).toThrow();
	});

	it('rejects a tampered auth tag', () => {
		const svc = new EncryptionService();
		const [iv, tag, payload] = svc.encrypt('hello').split(':');
		const badTag = tag.startsWith('00') ? `ff${tag.slice(2)}` : `00${tag.slice(2)}`;
		expect(() => svc.decrypt(`${iv}:${badTag}:${payload}`)).toThrow();
	});

	it('rejects decryption with a different key', () => {
		const svcA = new EncryptionService();
		const ciphertext = svcA.encrypt('hello');
		vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', KEY_B);
		const svcB = new EncryptionService();
		expect(() => svcB.decrypt(ciphertext)).toThrow();
	});

	it('rejects malformed ciphertext formats', () => {
		const svc = new EncryptionService();
		expect(() => svc.decrypt('no-colons')).toThrow(/format/);
		expect(() => svc.decrypt('a:b')).toThrow(/format/);
		expect(() => svc.decrypt('a:b:c:d')).toThrow(/format/);
		// Right shape, wrong IV length
		expect(() => svc.decrypt('aa:bbbb:cc')).toThrow(/IV length/);
	});
});
