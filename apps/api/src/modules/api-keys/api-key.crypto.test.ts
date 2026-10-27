import { describe, expect, it } from 'vitest';
import { generateApiKey, hashKeySecret, parseApiKey, verifyKeySecret } from './api-key.crypto.js';

const PEPPER = 'p'.repeat(32);

describe('ingestion key crypto', () => {
  it('generates keys in the documented format with a non-secret prefix', () => {
    const key = generateApiKey(PEPPER);
    expect(key.plaintext).toMatch(/^aop_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(key.prefix).toBe(`aop_${key.keyId}`);
    expect(key.plaintext.startsWith(key.prefix)).toBe(true);
    // The stored material must not contain the secret.
    const secret = key.plaintext.split('.')[1]!;
    expect(key.keyHash).not.toContain(secret);
    expect(key.prefix).not.toContain(secret);
  });

  it('uses cryptographically random, unique values', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey(PEPPER).plaintext));
    expect(keys.size).toBe(200);
  });

  it('round-trips parse and verify', () => {
    const key = generateApiKey(PEPPER);
    const parsed = parseApiKey(key.plaintext);
    expect(parsed?.keyId).toBe(key.keyId);
    expect(verifyKeySecret(PEPPER, parsed!.secret, key.keyHash)).toBe(true);
  });

  it('rejects a wrong secret, a different pepper, and malformed keys', () => {
    const key = generateApiKey(PEPPER);
    const { secret } = parseApiKey(key.plaintext)!;
    const tampered = `${secret[0] === 'A' ? 'B' : 'A'}${secret.slice(1)}`;
    expect(verifyKeySecret(PEPPER, tampered, key.keyHash)).toBe(false);
    expect(verifyKeySecret('q'.repeat(32), secret, key.keyHash)).toBe(false);
    expect(verifyKeySecret(PEPPER, secret, 'not-hex')).toBe(false);
    for (const bad of [
      '',
      'aop_',
      'aop_xyz.abc',
      `${key.plaintext}x`,
      key.plaintext.toUpperCase(),
    ]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it('hashes deterministically for a given pepper', () => {
    expect(hashKeySecret(PEPPER, 'abc')).toBe(hashKeySecret(PEPPER, 'abc'));
    expect(hashKeySecret(PEPPER, 'abc')).not.toBe(hashKeySecret('z'.repeat(32), 'abc'));
  });
});
