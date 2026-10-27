import { toFieldErrors } from '@aop/validation';
import type { z } from 'zod';
import { AppError } from './errors.js';

/** Parses untrusted input or throws 400 VALIDATION_ERROR with per-field messages. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', {
      fields: toFieldErrors(result.error),
    });
  }
  return result.data;
}
