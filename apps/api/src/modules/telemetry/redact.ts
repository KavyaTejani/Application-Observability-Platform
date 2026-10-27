export const REDACTED = '[REDACTED]';

/** Attribute names whose values are always secrets, whatever the value looks like. */
const SECRET_KEY =
  /(^|[_.-])(authorization|password|passwd|pwd|secret|token|api[_.-]?key|cookie|set-cookie|session)([_.-]|$)/i;

/** Credential shapes that must never reach log storage, even inside free-text messages. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/aop_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}/g, '[REDACTED_API_KEY]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    `$1$2${REDACTED}`,
  ],
];

export function redactText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    result = result.replace(pattern, replacement);
  return result;
}

export function redactAttributes(
  attributes: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (SECRET_KEY.test(key)) out[key] = REDACTED;
    else out[key] = typeof value === 'string' ? redactText(value) : value;
  }
  return out;
}
