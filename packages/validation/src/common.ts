import type { z } from 'zod';

/** MongoDB ObjectId as a 24-character hex string. */
export const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

/** Field-level messages keyed by dotted path, used in `VALIDATION_ERROR` responses and forms. */
export type FieldErrors = Record<string, string>;

/** Keeps the first message per field so forms can render one error under each input. */
export function toFieldErrors(error: z.ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_root';
    fields[key] ??= issue.message;
  }
  return fields;
}
