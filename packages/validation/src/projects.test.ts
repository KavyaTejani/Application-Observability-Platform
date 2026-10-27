import { describe, expect, it } from 'vitest';
import { createProjectSchema, rotateApiKeySchema, updateProjectSchema } from './projects.js';

describe('createProjectSchema', () => {
  it('accepts a valid project', () => {
    expect(createProjectSchema.parse({ name: ' Shop API ', environment: 'production' })).toEqual({
      name: 'Shop API',
      environment: 'production',
    });
  });

  it('rejects unknown environments and unsafe names', () => {
    expect(createProjectSchema.safeParse({ name: 'x', environment: 'prod' }).success).toBe(false);
    expect(
      createProjectSchema.safeParse({ name: '<script>', environment: 'staging' }).success,
    ).toBe(false);
    expect(createProjectSchema.safeParse({ name: '', environment: 'staging' }).success).toBe(false);
  });
});

describe('updateProjectSchema', () => {
  it('drops attempts to change the environment', () => {
    const parsed = updateProjectSchema.parse({ name: 'Renamed', environment: 'production' });
    expect(parsed).toEqual({ name: 'Renamed' });
  });
});

describe('rotateApiKeySchema', () => {
  it('defaults to immediate revocation and caps the grace period at 24 hours', () => {
    expect(rotateApiKeySchema.parse({})).toEqual({ gracePeriodHours: 0 });
    expect(rotateApiKeySchema.safeParse({ gracePeriodHours: 25 }).success).toBe(false);
    expect(rotateApiKeySchema.safeParse({ gracePeriodHours: -1 }).success).toBe(false);
  });
});
