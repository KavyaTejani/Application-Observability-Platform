import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Ingestion key format: `aop_<keyId>.<secret>`
 *
 * - `keyId`: 16 hex chars (64 bits), public, used to find the key without scanning.
 * - `secret`: 32 random bytes as base64url (256 bits), never stored.
 *
 * Keys are high-entropy random values verified on every ingestion request, so a fast keyed hash
 * (HMAC-SHA-256 with a server-side pepper) is the right tool (PRD KEY-002). A slow password
 * hash would cap ingestion throughput and adds nothing against brute force of 256-bit secrets.
 */
const KEY_PATTERN = /^aop_([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;

export interface GeneratedApiKey {
  keyId: string;
  /** The full key, shown to the user exactly once. */
  plaintext: string;
  keyHash: string;
  prefix: string;
}

export function hashKeySecret(pepper: string, secret: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

export function generateApiKey(pepper: string): GeneratedApiKey {
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return {
    keyId,
    plaintext: `aop_${keyId}.${secret}`,
    keyHash: hashKeySecret(pepper, secret),
    prefix: `aop_${keyId}`,
  };
}

export function parseApiKey(raw: string): { keyId: string; secret: string } | null {
  const match = KEY_PATTERN.exec(raw);
  if (!match?.[1] || !match[2]) return null;
  return { keyId: match[1], secret: match[2] };
}

/** Constant-time comparison of the presented secret's HMAC with the stored hash. */
export function verifyKeySecret(pepper: string, secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashKeySecret(pepper, secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}
