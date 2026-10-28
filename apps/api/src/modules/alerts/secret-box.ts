import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for stored webhook signing secrets (PRD §11.12: "encrypt secret signing
 * material if persisted"). Ciphertext format: `v1.<iv>.<tag>.<data>` (base64url parts). The key is
 * derived with HKDF from the configured key material, so the raw secret never sits in the
 * database.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    this.key = Buffer.from(hkdfSync('sha256', keyMaterial, 'aop-webhook-secrets', 'v1', 32));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), data]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

export const generateSigningSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/**
 * Signature header, Stripe-style: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "t.body")>`.
 * Including the timestamp lets receivers reject replays older than a few minutes.
 */
export function signPayload(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}
