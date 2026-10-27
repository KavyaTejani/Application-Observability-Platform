import { hash, verify, type Options } from '@node-rs/argon2';

/** `Algorithm.Argon2id`. The library exports a const enum, which isolated modules cannot read. */
const ARGON2ID = 2;

/**
 * Argon2id with the OWASP Password Storage Cheat Sheet baseline (19 MiB memory, 2 iterations,
 * 1 lane). The parameters are embedded in each PHC hash string, so they can be raised later
 * without breaking existing hashes.
 */
const ARGON2_OPTIONS: Options = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2_OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // A malformed stored hash is treated as a failed verification, never as an exception path
    // that could reveal account state.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a full verification against a throwaway hash, so a login for an unknown email takes
 * about as long as one for a real account (mitigates user enumeration through timing).
 */
export async function burnPasswordVerification(password: string): Promise<void> {
  dummyHash ??= hashPassword('timing-equalization-placeholder');
  await verifyPassword(await dummyHash, password);
}
