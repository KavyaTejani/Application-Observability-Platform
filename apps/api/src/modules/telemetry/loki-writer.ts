import type { Severity } from '@aop/validation';

export interface LokiLogEntry {
  timestampMs: number;
  severity: Severity;
  message: string;
  requestId?: string;
  attributes?: Record<string, string | number | boolean | null>;
}

export interface LokiStreamLabels {
  projectId: string;
  service: string;
  environment: string;
}

export class LokiWriteError extends Error {
  constructor(
    message: string,
    /** True when retrying later may succeed (network failure, 429, 5xx). */
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LokiWriteError';
  }
}

/** Abstraction used by ingestion, so tests can substitute a fake. */
export interface LogWriter {
  write(tenantId: string, labels: LokiStreamLabels, entries: LokiLogEntry[]): Promise<void>;
}

/**
 * Writes logs to Loki's push API as the **trusted gateway**. `X-Scope-OrgID` is set here, from the
 * verified tenant, on every request. No caller-supplied header is ever forwarded (PRD LOG-002).
 *
 * Labels are kept low-cardinality: project, service, environment, severity (LOG-009). The request
 * ID travels as structured metadata and inside the JSON line, so it can be filtered at query time
 * without creating a stream per request.
 */
export class LokiWriter implements LogWriter {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async write(tenantId: string, labels: LokiStreamLabels, entries: LokiLogEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // One stream per severity: severity is a label, and everything else is shared.
    const bySeverity = new Map<Severity, LokiLogEntry[]>();
    for (const entry of entries) {
      const list = bySeverity.get(entry.severity) ?? [];
      list.push(entry);
      bySeverity.set(entry.severity, list);
    }

    const body = {
      streams: [...bySeverity].map(([severity, group]) => ({
        stream: {
          project: labels.projectId,
          service: labels.service,
          environment: labels.environment,
          severity: severity.toLowerCase(),
        },
        values: group.map((entry) => {
          const line = JSON.stringify({
            message: entry.message,
            ...(entry.requestId ? { requestId: entry.requestId } : {}),
            ...(entry.attributes && Object.keys(entry.attributes).length > 0
              ? { attributes: entry.attributes }
              : {}),
          });
          const value: [string, string, Record<string, string>?] = [
            `${BigInt(Math.trunc(entry.timestampMs)) * 1_000_000n}`,
            line,
          ];
          if (entry.requestId) value.push({ request_id: entry.requestId });
          return value;
        }),
      })),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/loki/api/v1/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scope-OrgID': tenantId },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new LokiWriteError(`Loki push failed: ${(error as Error).message}`, true);
    }
    if (!response.ok) {
      // Read only a bounded prefix of the body for diagnostics. It may echo entries.
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      const retryable = response.status === 429 || response.status >= 500;
      throw new LokiWriteError(`Loki push returned HTTP ${response.status}: ${detail}`, retryable);
    }
    await response.arrayBuffer().catch(() => undefined);
  }
}
