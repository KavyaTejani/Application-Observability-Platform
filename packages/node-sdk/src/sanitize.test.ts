import { describe, expect, it } from 'vitest';
import { MAX_ATTRIBUTES, sanitizeAttributes, sanitizeMessage } from './sanitize.js';

describe('sanitizeAttributes', () => {
  it('keeps primitives and serializes objects, dates, and errors safely', () => {
    const out = sanitizeAttributes({
      s: 'x',
      n: 1,
      b: true,
      z: null,
      d: new Date('2026-01-01T00:00:00Z'),
      o: { nested: { deep: 1 } },
      err: new TypeError('boom'),
      u: undefined,
      f: () => 1,
      inf: Infinity,
    });
    expect(out).toEqual({
      s: 'x',
      n: 1,
      b: true,
      z: null,
      d: '2026-01-01T00:00:00.000Z',
      o: '{"nested":{"deep":1}}',
      'err.name': 'TypeError',
      'err.message': 'boom',
      inf: 'Infinity',
    });
  });

  it('caps the attribute count and value length, and fixes unsafe keys', () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeAttributes(many)!)).toHaveLength(MAX_ATTRIBUTES);
    expect((sanitizeAttributes({ long: 'x'.repeat(5000) })!.long as string).length).toBe(1024);
    expect(sanitizeAttributes({ 'user id': 1, '9lives': 2 })).toEqual({ user_id: 1, _9lives: 2 });
  });

  it('survives circular structures', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(sanitizeAttributes({ c: circular })).toEqual({ c: '[unserializable]' });
  });
});

describe('sanitizeMessage', () => {
  it('stringifies, never returns empty, and truncates', () => {
    expect(sanitizeMessage(42)).toBe('42');
    expect(sanitizeMessage('')).toBe('(empty message)');
    expect(sanitizeMessage('x'.repeat(10_000))).toHaveLength(8192);
  });
});
