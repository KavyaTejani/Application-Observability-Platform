import { useOutletContext } from 'react-router';
import { Alert, Card, Spinner } from '../components/ui';
import { errorMessage } from '../lib/api';
import { formatBytes, formatDateTime, formatNumber } from '../lib/format';
import type { OrganizationSummary } from '../lib/types';
import { useUsage, type Meter } from '../lib/usage';

const NEAR_LIMIT = 0.8;

/** Daily quota consumption against the plan (PRD QUOTA-005, §13 screen 8). */
export function UsagePage() {
  const org = useOutletContext<OrganizationSummary>();
  const usage = useUsage(org.id);

  if (usage.isPending) return <Spinner label="Loading usage…" />;
  if (usage.isError) return <Alert>{errorMessage(usage.error)}</Alert>;
  const u = usage.data.usage;
  const exhausted =
    u.quota.records.used >= u.quota.records.limit || u.quota.bytes.used >= u.quota.bytes.limit;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Usage</h1>
        <p className="mt-1 text-sm text-slate-600">
          Plan: <span className="font-medium text-slate-900">{u.plan.name}</span>. Counted per UTC
          day ({u.dayUtc}); resets at {formatDateTime(u.resetsAt)} (00:00 UTC).
        </p>
      </div>

      {(exhausted || u.rejected.quotaRecords > 0) && (
        <Alert tone={exhausted ? 'error' : 'info'}>
          <p className="font-medium">
            {exhausted ? 'Daily quota reached.' : 'Some telemetry was refused today.'}
          </p>
          <p className="mt-1">
            {formatNumber(u.rejected.quotaRecords)} records were refused with{' '}
            <code>429 QUOTA_EXCEEDED</code> because a batch would have gone over the limit. SDKs
            drop such batches instead of retrying; ingestion resumes automatically after the reset.
            Batches are admitted or refused whole, so a smaller batch may still fit.
          </p>
        </Alert>
      )}

      <Card title="Today's ingestion">
        <div className="grid gap-6 md:grid-cols-2">
          <QuotaMeter label="Telemetry records" meter={u.quota.records} format={formatNumber} />
          <QuotaMeter
            label="Ingested bytes (estimated)"
            meter={u.quota.bytes}
            format={formatBytes}
          />
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Only valid records count. Batches that fail to reach storage are not counted.
          {u.rejected.records > 0 &&
            ` ${formatNumber(u.rejected.records)} records were rejected today in total (invalid or over quota).`}
        </p>
      </Card>

      <Card title="By project (today)">
        {u.projects.length === 0 ? (
          <p className="text-sm text-slate-600">No projects yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Project</th>
                  <th className="py-2 pr-4 text-right font-medium">Accepted records</th>
                  <th className="py-2 pr-4 text-right font-medium">Accepted bytes</th>
                  <th className="py-2 pr-4 text-right font-medium">Rejected</th>
                  <th className="py-2 text-right font-medium">Over quota</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {u.projects.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2 pr-4">
                      <span className="font-medium text-slate-900">{p.name}</span>{' '}
                      <span className="text-xs text-slate-500">
                        {p.environment}
                        {p.deleted && ' · deleted'}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatNumber(p.acceptedRecords)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatBytes(p.acceptedBytes)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatNumber(p.rejectedRecords)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatNumber(p.quotaRejectedRecords)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Plan limits">
          <dl className="space-y-1 text-sm">
            <LimitRow label="Projects" meter={u.resources.projects} />
            <LimitRow label="Alert rules" meter={u.resources.alertRules} />
            <div className="flex justify-between">
              <dt className="text-slate-600">Retention</dt>
              <dd>
                metrics {u.retention.metricsDays} days · logs {u.retention.logsDays} days
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            Retention is set for the whole deployment and shown read-only.
          </p>
        </Card>

        <Card title="Last 7 days">
          {u.history.length === 0 ? (
            <p className="text-sm text-slate-600">No telemetry received yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-1 pr-4 font-medium">Day (UTC)</th>
                  <th className="py-1 pr-4 text-right font-medium">Records</th>
                  <th className="py-1 text-right font-medium">Bytes</th>
                </tr>
              </thead>
              <tbody>
                {u.history.map((h) => (
                  <tr key={h.dayUtc}>
                    <td className="py-1 pr-4">{h.dayUtc}</td>
                    <td className="py-1 pr-4 text-right tabular-nums">{formatNumber(h.records)}</td>
                    <td className="py-1 text-right tabular-nums">{formatBytes(h.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

function QuotaMeter({
  label,
  meter,
  format,
}: {
  label: string;
  meter: Meter;
  format: (n: number) => string;
}) {
  const ratio = meter.limit > 0 ? Math.min(1, meter.used / meter.limit) : 1;
  const state = ratio >= 1 ? 'full' : ratio >= NEAR_LIMIT ? 'near' : 'ok';
  const bar = { ok: 'bg-slate-700', near: 'bg-amber-500', full: 'bg-red-600' }[state];
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-slate-900">{label}</span>
        <span className="tabular-nums text-slate-700">
          {format(meter.used)} / {format(meter.limit)}
        </span>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={meter.limit}
        aria-valuenow={meter.used}
      >
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${ratio * 100}%` }} />
      </div>
      <p className="mt-1 text-xs text-slate-600">
        {Math.floor(ratio * 100)}% used
        {state === 'near' && ' · ▲ nearing the daily limit'}
        {state === 'full' && ' · ✕ limit reached'}
      </p>
    </div>
  );
}

function LimitRow({ label, meter }: { label: string; meter: Meter }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-600">{label}</dt>
      <dd className="tabular-nums">
        {meter.used} / {meter.limit}
      </dd>
    </div>
  );
}
