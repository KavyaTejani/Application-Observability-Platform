import { describe, expect, it } from 'vitest';
import { nextUtcMidnight, secondsUntilReset, utcDay } from './quota.service.js';

describe('UTC quota windows', () => {
  it('uses the UTC calendar day, whatever the local time zone', () => {
    expect(utcDay(new Date('2026-03-01T23:59:59.999Z'))).toBe('2026-03-01');
    expect(utcDay(new Date('2026-03-02T00:00:00.000Z'))).toBe('2026-03-02');
  });

  it('resets at the next UTC midnight, across month and year ends', () => {
    expect(nextUtcMidnight(new Date('2026-02-28T12:00:00Z')).toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );
    expect(nextUtcMidnight(new Date('2026-12-31T23:00:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('gives Retry-After as whole seconds until the reset, never zero', () => {
    expect(secondsUntilReset(new Date('2026-05-10T23:59:00Z'))).toBe(60);
    expect(secondsUntilReset(new Date('2026-05-10T23:59:59.500Z'))).toBe(1);
    expect(secondsUntilReset(new Date('2026-05-10T00:00:00Z'))).toBe(86_400);
  });
});
