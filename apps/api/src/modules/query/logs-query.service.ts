import { createHash } from 'node:crypto';
import {
  MAX_LOG_LOOKBACK_MS,
  MAX_LOG_QUERY_SPAN_MS,
  type LogQuery,
  type Severity,
} from '@aop/validation';
import { AppError } from '../../lib/errors.js';
import type { ProjectScope } from '../authz/tenant-scope.js';
import type { LokiQueryApi } from './backend-clients.js';
import { buildLogQuery } from './logql.js';

export interface LogEntry {
  /** Stable ID of the entry (hash of timestamp + line), for UI keys and pagination. */
  id: string;
  timestamp: string;
  severity: Severity;
  service: string;
  environment: string;
  message: string;
  requestId: string | null;
  attributes: Record<string, unknown>;
}

export interface LogQueryResult {
  entries: LogEntry[];
  /** Opaque cursor for the next (older) page, or null when there is no more data. */
  nextCursor: string | null;
  from: string;
  to: string;
}

const ONE_HOUR_MS = 3_600_000;
const NS_PER_MS = 1_000_000n;

interface Cursor {
  /** Nanosecond timestamp of the oldest entry already returned. */
  endNs: string;
  /** IDs of returned entries that share exactly that timestamp (to skip on the next page). */
  seen: string[];
}

const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (
      typeof parsed.endNs === 'string' &&
      /^\d{1,20}$/.test(parsed.endNs) &&
      Array.isArray(parsed.seen) &&
      parsed.seen.length <= 1000 &&
      parsed.seen.every((id) => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id))
    ) {
      return parsed;
    }
  } catch {
    // Fall through to the error below.
  }
  throw new AppError(
    400,
    'INVALID_CURSOR',
    'The pagination cursor is invalid. Start a new search.',
  );
}

const entryId = (ns: string, line: string) =>
  createHash('sha256').update(ns).update('\0').update(line).digest('hex').slice(0, 16);

export class LogsQueryService {
  constructor(
    private readonly loki: LokiQueryApi | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private client(): LokiQueryApi {
    if (!this.loki) {
      throw new AppError(
        503,
        'BACKEND_NOT_CONFIGURED',
        'Log storage is not configured in this deployment.',
        {
          retryable: false,
        },
      );
    }
    return this.loki;
  }

  /** Validates and bounds the time window (PRD LOG-006). */
  private window(query: LogQuery): { fromMs: number; toMs: number } {
    const now = this.now().getTime();
    const toMs = query.to ? Date.parse(query.to) : now;
    const fromMs = query.from ? Date.parse(query.from) : toMs - ONE_HOUR_MS;
    if (fromMs >= toMs) throw rangeError('"from" must be before "to".');
    if (toMs - fromMs > MAX_LOG_QUERY_SPAN_MS)
      throw rangeError('A log search can span at most 24 hours.');
    if (fromMs < now - MAX_LOG_LOOKBACK_MS)
      throw rangeError('Logs are retained for 7 days; choose a later start.');
    return { fromMs, toMs };
  }

  async search(scope: ProjectScope, query: LogQuery): Promise<LogQueryResult> {
    const loki = this.client();
    const { fromMs, toMs } = this.window(query);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    const startNs = BigInt(fromMs) * NS_PER_MS;
    const windowEndNs = BigInt(toMs) * NS_PER_MS;
    // Resume at (last returned timestamp + 1 ns) and skip entries already seen at that timestamp.
    // This is correct whether the backend treats `end` as inclusive or exclusive, so entries
    // sharing one nanosecond across a page boundary are neither lost nor duplicated.
    const endNs = cursor ? minBig(BigInt(cursor.endNs) + 1n, windowEndNs) : windowEndNs;
    const seen = new Set(cursor?.seen ?? []);

    const logQuery = buildLogQuery({
      projectId: scope.projectId.toHexString(),
      service: query.service,
      severities: query.severity,
      requestId: query.requestId,
      contains: query.contains,
    });
    // Ask for one extra entry so we know whether another page exists, plus the skipped ones.
    const fetchLimit = query.limit + 1 + seen.size;
    const streams = await loki.queryRange(scope.organizationId.toHexString(), logQuery, {
      startNs,
      endNs,
      limit: fetchLimit,
    });

    const all = streams
      .flatMap((stream) =>
        stream.values.map(([ns, line]) => ({
          ns,
          line,
          labels: stream.stream,
          id: entryId(ns, line),
        })),
      )
      .filter((entry) => !seen.has(entry.id))
      .sort((a, b) =>
        BigInt(b.ns) > BigInt(a.ns)
          ? 1
          : BigInt(b.ns) < BigInt(a.ns)
            ? -1
            : a.id.localeCompare(b.id),
      );

    const page = all.slice(0, query.limit);
    const hasMore = all.length > query.limit;
    let nextCursor: string | null = null;
    const last = page.at(-1);
    if (hasMore && last) {
      const atBoundary = page.filter((e) => e.ns === last.ns).map((e) => e.id);
      // Entries at the boundary timestamp that were already returned on earlier pages must stay
      // skipped too.
      const carried = cursor && cursor.endNs === last.ns ? cursor.seen : [];
      nextCursor = encodeCursor({
        endNs: last.ns,
        seen: [...new Set([...carried, ...atBoundary])],
      });
    }

    return {
      entries: page.map((e) => toEntry(e.id, e.ns, e.line, e.labels)),
      nextCursor,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    };
  }

  /** Services that wrote logs for this project in the last 7 days (filter options). */
  async services(scope: ProjectScope): Promise<string[]> {
    if (!this.loki) return [];
    const now = BigInt(this.now().getTime()) * NS_PER_MS;
    return this.loki.labelValues(
      scope.organizationId.toHexString(),
      'service',
      buildLogQuery({ projectId: scope.projectId.toHexString() }),
      now - BigInt(MAX_LOG_LOOKBACK_MS) * NS_PER_MS,
      now,
    );
  }
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
const rangeError = (message: string) => new AppError(400, 'INVALID_TIME_RANGE', message);

function toEntry(id: string, ns: string, line: string, labels: Record<string, string>): LogEntry {
  let parsed: { message?: unknown; requestId?: unknown; attributes?: unknown } = {};
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === 'object') parsed = value;
  } catch {
    // A line not written by this platform's gateway: show it raw.
  }
  return {
    id,
    timestamp: new Date(Number(BigInt(ns) / NS_PER_MS)).toISOString(),
    severity: (labels.severity ?? 'info').toUpperCase() as Severity,
    service: labels.service ?? '',
    environment: labels.environment ?? '',
    message: typeof parsed.message === 'string' ? parsed.message : line,
    requestId: typeof parsed.requestId === 'string' ? parsed.requestId : null,
    attributes:
      parsed.attributes && typeof parsed.attributes === 'object'
        ? (parsed.attributes as Record<string, unknown>)
        : {},
  };
}
