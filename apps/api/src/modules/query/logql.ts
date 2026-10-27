import type { Severity } from '@aop/validation';
import { escapeLabelValue } from './promql.js';

/**
 * Server-side LogQL generation (PRD LOG-004, LOG-006, LOG-009). The tenant is not in the query at
 * all: it is the `X-Scope-OrgID` header, set from the authorized scope. The query always carries
 * a mandatory `project` matcher, so a user can only ever see their own project's streams within
 * their organization.
 */
export interface LogFilters {
  projectId: string;
  service?: string;
  severities?: Severity[];
  requestId?: string;
  contains?: string;
}

/** Escapes RE2 metacharacters so user text is matched literally. */
export const escapeRegex = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

export function buildLogQuery(filters: LogFilters): string {
  const matchers = [`project="${escapeLabelValue(filters.projectId)}"`];
  if (filters.service) matchers.push(`service="${escapeLabelValue(filters.service)}"`);
  if (filters.severities && filters.severities.length > 0) {
    // Severity labels are stored lower-case; values come from a fixed enum.
    const values = [...new Set(filters.severities.map((s) => s.toLowerCase()))].join('|');
    matchers.push(`severity=~"${values}"`);
  }

  let query = `{${matchers.join(', ')}}`;
  // The request ID is structured metadata, so it is filtered after stream selection rather than
  // indexed as a label.
  if (filters.requestId) query += ` | request_id="${escapeLabelValue(filters.requestId)}"`;
  // Case-insensitive literal match. The raw backtick string needs no further escaping, and the
  // validator rejects backticks in the input.
  if (filters.contains) query += ` |~ \`(?i)${escapeRegex(filters.contains)}\``;
  return query;
}
