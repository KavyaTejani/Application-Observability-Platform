import { z } from 'zod';

/** Upper bound on password length: Argon2 cost grows with input, so cap it to prevent abuse. */
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_MIN_LENGTH = 10;

/**
 * A short blocklist of the most common passwords that satisfy the length rule. Length is the
 * main control (NIST SP 800-63B); composition rules are deliberately not used.
 */
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '0123456789',
  'qwertyuiop',
  'password12',
  'password123',
  'password1234',
  'iloveyou123',
  'qwerty1234',
  '1q2w3e4r5t',
  'abcdefghij',
  'letmein123',
  'welcome123',
  'admin12345',
  'aaaaaaaaaa',
]);

export const emailSchema = z
  .string()
  .trim()
  .max(254, 'Email is too long')
  .pipe(z.email('Enter a valid email address'))
  .transform((email) => email.toLowerCase());

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((password) => !COMMON_PASSWORDS.has(password.toLowerCase()), {
    message: 'This password is too common; choose a less predictable one',
  });

const displayName = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`);

export const registerSchema = z.object({
  name: displayName('Name', 100),
  email: emailSchema,
  password: passwordSchema,
  organizationName: displayName('Organization name', 100).optional(),
});
export type RegisterInput = z.input<typeof registerSchema>;

/** Login validates shape only: password rules are not re-checked so old passwords still work. */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.input<typeof loginSchema>;
