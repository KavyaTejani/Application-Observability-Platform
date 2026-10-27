import { describe, expect, it } from 'vitest';
import { loginSchema, registerSchema } from './auth.js';
import { toFieldErrors } from './common.js';

const valid = { name: 'Ada', email: '  Ada@Example.COM ', password: 'correct horse battery' };

describe('registerSchema', () => {
  it('normalizes email to trimmed lowercase', () => {
    expect(registerSchema.parse(valid).email).toBe('ada@example.com');
  });

  it('rejects short, overlong, and common passwords', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, password: 'x'.repeat(129) }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, password: 'Password123' }).success).toBe(false);
  });

  it('rejects an invalid email and an empty name with field errors', () => {
    const result = registerSchema.safeParse({ ...valid, email: 'nope', name: '   ' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const fields = toFieldErrors(result.error);
    expect(fields.email).toMatch(/valid email/);
    expect(fields.name).toMatch(/required/);
  });

  it('ignores unknown fields such as a client-supplied organizationId or role', () => {
    const parsed = registerSchema.parse({ ...valid, organizationId: 'x', role: 'owner' });
    expect(parsed).not.toHaveProperty('organizationId');
    expect(parsed).not.toHaveProperty('role');
  });
});

describe('loginSchema', () => {
  it('does not apply password strength rules', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'old' }).success).toBe(true);
  });
});
