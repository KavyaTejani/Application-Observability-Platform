import {
  SEVERITIES,
  TIME_RANGES,
  TIME_RANGE_SECONDS,
  type Severity,
  type TimeRange,
} from '@aop/validation';
import { useState, type FormEvent } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';
import { Alert, Button, Spinner, TextField } from '../components/ui';
import { ApiError, errorMessage } from '../lib/api';
import { formatDateTime, formatLogTime, timeZoneLabel } from '../lib/format';
import { useLogs, useServices, type LogEntry } from '../lib/telemetry';
import type { ProjectContext } from './ProjectPage';

/**
 * Severity is a state, so it uses the reserved status colours, always paired with the text label
 * (never colour alone).
 */
const SEVERITY_STYLE: Record<Severity, string> = {
  TRACE: 'bg-slate-100 text-slate-600',
  DEBUG: 'bg-slate-100 text-slate-600',
  INFO: 'bg-slate-200 text-slate-800',
  WARN: 'bg-[#fab219] text-[#0b0b0b]',
  ERROR: 'bg-[#d03b3b] text-white',
  FATAL: 'bg-[#8f1f1f] text-white',
};

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-block w-14 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold ${SEVERITY_STYLE[severity]}`}
    >
      {severity}
    </span>
  );
}

const isRange = (v: string | null): v is TimeRange => TIME_RANGES.includes(v as TimeRange);

export function LogsPage() {
  const { project } = useOutletContext<ProjectContext>();
  const [params, setParams] = useSearchParams();
  const services = useServices(project.id);

  // Filters live in the URL so a search can be shared and "show this request" is just a link.
  const range: TimeRange = isRange(params.get('range')) ? (params.get('range') as TimeRange) : '1h';
  const severity = (params.get('severity') ?? '')
    .split(',')
    .filter((s): s is Severity => SEVERITIES.includes(s as Severity));
  const service = params.get('service') ?? '';
  const requestId = params.get('requestId') ?? '';
  const contains = params.get('contains') ?? '';
  // The window is fixed when the search runs, so paging keeps a stable "to".
  const [searchedAt, setSearchedAt] = useState(() => Date.now());

  // No memo needed: TanStack Query compares query keys by value, not identity.
  const logs = useLogs(project.id, {
    from: new Date(searchedAt - TIME_RANGE_SECONDS[range] * 1000).toISOString(),
    to: new Date(searchedAt).toISOString(),
    severity: severity.length > 0 ? severity : undefined,
    service: service || undefined,
    requestId: requestId || undefined,
    contains: contains || undefined,
    limit: 50,
  });
  const entries = logs.data?.pages.flatMap((page) => page.entries) ?? [];

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next);
    setSearchedAt(Date.now());
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    update({
      range: String(form.get('range')),
      service: String(form.get('service') ?? ''),
      requestId: String(form.get('requestId') ?? '').trim(),
      contains: String(form.get('contains') ?? '').trim(),
      severity: SEVERITIES.filter((s) => form.get(`sev-${s}`) === 'on').join(','),
    });
  };

  const fieldErrors = logs.error instanceof ApiError ? logs.error.fieldErrors : {};
  const notConfigured =
    logs.error instanceof ApiError && logs.error.code === 'BACKEND_NOT_CONFIGURED';

  return (
    <div className="space-y-4">
      <form
        key={params.toString()}
        onSubmit={onSubmit}
        className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-4"
      >
        <label className="text-sm font-medium text-slate-700">
          Time range
          <select
            name="range"
            defaultValue={range}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
          >
            {TIME_RANGES.map((r) => (
              <option key={r} value={r}>
                Last {r}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Service
          <select
            name="service"
            defaultValue={service}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
          >
            <option value="">All services</option>
            {services.data?.services.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <TextField
          label="Request ID"
          name="requestId"
          defaultValue={requestId}
          placeholder="req_…"
          error={fieldErrors.requestId}
        />
        <TextField
          label="Message contains"
          name="contains"
          defaultValue={contains}
          placeholder="e.g. timeout"
          error={fieldErrors.contains}
        />
        <fieldset className="md:col-span-3">
          <legend className="text-sm font-medium text-slate-700">
            Severity (none selected = all)
          </legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {SEVERITIES.map((s) => (
              <label key={s} className="flex items-center gap-1 text-sm text-slate-700">
                <input type="checkbox" name={`sev-${s}`} defaultChecked={severity.includes(s)} />
                {s}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex items-end gap-2">
          <Button type="submit" className="flex-1">
            Search
          </Button>
          <Button variant="secondary" onClick={() => setParams(new URLSearchParams())}>
            Clear
          </Button>
        </div>
      </form>

      <p className="text-xs text-slate-500">
        Newest first · times in {timeZoneLabel} · searched{' '}
        {formatDateTime(new Date(searchedAt).toISOString())}
      </p>

      {notConfigured ? (
        <Alert tone="info">
          Log storage is not configured in this deployment. The full telemetry stack runs with
          Docker Compose (see the README).
        </Alert>
      ) : logs.isError ? (
        <Alert>{errorMessage(logs.error)}</Alert>
      ) : logs.isPending ? (
        <Spinner label="Searching logs…" />
      ) : entries.length === 0 ? (
        <Alert tone="info">No logs match these filters in the selected time range.</Alert>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <ul className="divide-y divide-slate-100">
            {entries.map((entry) => (
              <LogRow
                key={entry.id}
                entry={entry}
                onShowRequest={(id) => update({ requestId: id, contains: '', severity: '' })}
              />
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-slate-200 p-3 text-sm text-slate-600">
            <span>{entries.length} entries shown</span>
            {logs.hasNextPage ? (
              <Button
                variant="secondary"
                onClick={() => void logs.fetchNextPage()}
                disabled={logs.isFetchingNextPage}
              >
                {logs.isFetchingNextPage ? 'Loading…' : 'Load older'}
              </Button>
            ) : (
              <span>End of results</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LogRow({
  entry,
  onShowRequest,
}: {
  entry: LogEntry;
  onShowRequest: (requestId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const attributes = Object.entries(entry.attributes);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="grid w-full grid-cols-[auto_auto_1fr] items-start gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50 md:grid-cols-[11rem_auto_8rem_1fr]"
      >
        <span className="font-mono text-xs text-slate-500 tabular-nums">
          {formatLogTime(entry.timestamp)}
        </span>
        <SeverityBadge severity={entry.severity} />
        <span className="hidden truncate text-xs text-slate-500 md:block">{entry.service}</span>
        <span className="truncate text-slate-900">{entry.message}</span>
      </button>
      {open && (
        <div className="space-y-2 bg-slate-50 px-3 pb-3 text-sm">
          <p className="break-words whitespace-pre-wrap text-slate-900">{entry.message}</p>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-slate-500">Timestamp</dt>
            <dd className="font-mono">{entry.timestamp} (UTC)</dd>
            <dt className="text-slate-500">Service</dt>
            <dd>{entry.service}</dd>
            <dt className="text-slate-500">Environment</dt>
            <dd>{entry.environment}</dd>
            <dt className="text-slate-500">Request ID</dt>
            <dd>
              {entry.requestId ? (
                <>
                  <code>{entry.requestId}</code>{' '}
                  <button
                    type="button"
                    className="ml-2 underline"
                    onClick={() => onShowRequest(entry.requestId as string)}
                  >
                    Show all logs for this request
                  </button>
                </>
              ) : (
                '—'
              )}
            </dd>
            {attributes.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="truncate text-slate-500">{key}</dt>
                <dd className="font-mono break-all">{JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </li>
  );
}
