import type { AttributeValue, Attributes } from './types.js';

export const MAX_ATTRIBUTES = 32;
export const MAX_ATTRIBUTE_VALUE_LENGTH = 1024;
export const MAX_MESSAGE_LENGTH = 8192;
const ATTRIBUTE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

function toAttributeValue(value: unknown): AttributeValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return truncate(value, MAX_ATTRIBUTE_VALUE_LENGTH);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      if (value instanceof Date) return value.toISOString();
      try {
        return truncate(JSON.stringify(value), MAX_ATTRIBUTE_VALUE_LENGTH);
      } catch {
        return '[unserializable]';
      }
  }
}

/**
 * Turns arbitrary user input into protocol-valid attributes: flat primitives only, bounded
 * count and size, safe key names. Errors are expanded to `error.name` / `error.message`.
 * Invalid entries are dropped rather than failing the log call.
 */
export function sanitizeAttributes(
  input: Record<string, unknown> | undefined,
): Attributes | undefined {
  if (!input) return undefined;
  const out: Attributes = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (count >= MAX_ATTRIBUTES) break;
    if (rawValue instanceof Error) {
      for (const [k, v] of [
        [`${rawKey}.name`, rawValue.name],
        [`${rawKey}.message`, rawValue.message],
      ] as const) {
        if (count < MAX_ATTRIBUTES && ATTRIBUTE_KEY.test(k)) {
          out[k] = truncate(v, MAX_ATTRIBUTE_VALUE_LENGTH);
          count++;
        }
      }
      continue;
    }
    const key = rawKey
      .replace(/[^A-Za-z0-9_.-]/g, '_')
      .replace(/^([^A-Za-z_])/, '_$1')
      .slice(0, 64);
    if (!ATTRIBUTE_KEY.test(key)) continue;
    const value = toAttributeValue(rawValue);
    if (value === undefined) continue;
    out[key] = value;
    count++;
  }
  return count > 0 ? out : undefined;
}

export const sanitizeMessage = (message: unknown): string => {
  const text = typeof message === 'string' ? message : String(message);
  return truncate(text.length > 0 ? text : '(empty message)', MAX_MESSAGE_LENGTH);
};
