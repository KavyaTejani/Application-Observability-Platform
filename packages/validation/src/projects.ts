import { z } from 'zod';

export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const projectName = z
  .string()
  .trim()
  .min(1, 'Project name is required')
  .max(60, 'Project name must be at most 60 characters')
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u,
    'Use letters, numbers, spaces, dots, dashes, or underscores',
  );

export const createProjectSchema = z.object({
  name: projectName,
  environment: z.enum(ENVIRONMENTS, { error: 'Choose development, staging, or production' }),
});
export type CreateProjectInput = z.input<typeof createProjectSchema>;

/**
 * Only the name can change. The environment is fixed at creation because it is stamped on
 * every telemetry record and must stay consistent for a project's whole history.
 */
export const updateProjectSchema = z.object({ name: projectName });
export type UpdateProjectInput = z.input<typeof updateProjectSchema>;

const keyName = z
  .string()
  .trim()
  .min(1, 'Key name is required')
  .max(60, 'Key name must be at most 60 characters');

export const createApiKeySchema = z.object({ name: keyName });
export type CreateApiKeyInput = z.input<typeof createApiKeySchema>;

export const MAX_ROTATION_GRACE_HOURS = 24;

export const rotateApiKeySchema = z.object({
  /** Hours the old key keeps working after rotation; 0 revokes it immediately. */
  gracePeriodHours: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_ROTATION_GRACE_HOURS, `Grace period is at most ${MAX_ROTATION_GRACE_HOURS} hours`)
    .default(0),
});
export type RotateApiKeyInput = z.input<typeof rotateApiKeySchema>;
