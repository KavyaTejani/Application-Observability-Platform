import { Link, useOutletContext, useParams } from 'react-router';
import { DeliveryStatusBadge, IncidentStatusBadge } from '../components/StatusBadge';
import { ArrowLeft, ArrowRight, Send } from 'lucide-react';
import { Alert, Card, EmptyState, Spinner, table } from '../components/ui';
import { errorMessage } from '../lib/api';
import { OPERATOR_TEXT, formatRuleValue, useDeliveries, useIncident } from '../lib/alerts';
import { formatDateTime } from '../lib/format';
import { IncidentTimes } from './AlertsPage';
import type { ProjectContext } from './ProjectPage';

export function IncidentPage() {
  const { org, project } = useOutletContext<ProjectContext>();
  const { incidentId = '' } = useParams();
  const incident = useIncident(incidentId);
  const deliveries = useDeliveries(incidentId);
  const back = `/orgs/${org.id}/projects/${project.id}/alerts`;

  if (incident.isPending) return <Spinner />;
  if (incident.isError) {
    return (
      <div className="space-y-3">
        <Alert>{errorMessage(incident.error)}</Alert>
        <Link to={back} className="text-sm underline">
          Back to alerts
        </Link>
      </div>
    );
  }
  const i = incident.data.incident;
  const snapshot = i.ruleSnapshot;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={back}
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" /> Alerts
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <IncidentStatusBadge status={i.status} />
          <h2 className="text-xl font-semibold tracking-tight text-fg">{i.title}</h2>
        </div>
      </div>

      <Card title="Details">
        <IncidentTimes startedAt={i.startedAt} resolvedAt={i.resolvedAt} />
        <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-y-2 text-sm [&>dd]:text-fg">
          <dt className="text-fg-muted">Last breach</dt>
          <dd>{formatDateTime(i.lastTriggeredAt)}</dd>
          <dt className="text-fg-muted">Latest value</dt>
          <dd>{formatRuleValue(snapshot.metricKey, i.lastValue)}</dd>
          <dt className="text-fg-muted">Condition</dt>
          <dd>
            {snapshot.metricKey === 'error_rate' ? 'Server error rate' : 'p95 latency'}{' '}
            {OPERATOR_TEXT[snapshot.operator]}{' '}
            {formatRuleValue(snapshot.metricKey, snapshot.threshold)} over{' '}
            {snapshot.windowSeconds / 60} min
          </dd>
          <dt className="text-fg-muted">Rule</dt>
          <dd>{i.rule ? i.rule.name : 'deleted'}</dd>
        </dl>
        <p className="mt-4 text-sm">
          <Link
            to={`/orgs/${org.id}/projects/${project.id}/logs?severity=ERROR,WARN`}
            className="inline-flex items-center gap-1 font-medium text-accent-text hover:underline"
          >
            Investigate recent errors in the log explorer
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </p>
      </Card>

      <Card
        title="Notification attempts"
        description="Every webhook attempt is recorded. A failed delivery never changes the incident."
        padded={false}
      >
        {deliveries.isPending && (
          <div className="p-5">
            <Spinner />
          </div>
        )}
        {deliveries.isError && (
          <div className="p-5">
            <Alert>{errorMessage(deliveries.error)}</Alert>
          </div>
        )}
        {deliveries.data?.deliveries.length === 0 && (
          <EmptyState icon={Send} title="No notifications sent">
            The rule may have no destination, or delivery is still queued.
          </EmptyState>
        )}
        {deliveries.data && deliveries.data.deliveries.length > 0 && (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Event</th>
                  <th className={table.th}>Attempt</th>
                  <th className={table.th}>Result</th>
                  <th className={table.th}>HTTP</th>
                  <th className={table.th}>When</th>
                  <th className={table.th}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.data.deliveries.map((d) => (
                  <tr key={d.id} className={table.row}>
                    <td className={`${table.td} font-medium text-fg`}>
                      {d.event === 'incident_firing' ? 'Firing' : 'Resolved'}
                    </td>
                    <td className={`${table.td} tabular-nums`}>{d.attempt}</td>
                    <td className={table.td}>
                      <DeliveryStatusBadge status={d.status} />
                    </td>
                    <td className={`${table.td} tabular-nums`}>{d.responseStatus ?? '—'}</td>
                    <td className={`${table.td} text-fg-secondary`}>
                      {formatDateTime(d.startedAt)}
                    </td>
                    <td className={`${table.td} text-fg-secondary`}>{d.errorSummary ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
