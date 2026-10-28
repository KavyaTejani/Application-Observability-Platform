import { Link, useOutletContext, useParams } from 'react-router';
import { DeliveryStatusBadge, IncidentStatusBadge } from '../components/StatusBadge';
import { Alert, Card, Spinner } from '../components/ui';
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
        <Link to={back} className="text-sm text-slate-600 underline">
          ← Alerts
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <IncidentStatusBadge status={i.status} />
          <h2 className="text-xl font-semibold text-slate-900">{i.title}</h2>
        </div>
      </div>

      <Card title="Details">
        <IncidentTimes startedAt={i.startedAt} resolvedAt={i.resolvedAt} />
        <dl className="mt-1 grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-slate-500">Last breach</dt>
          <dd>{formatDateTime(i.lastTriggeredAt)}</dd>
          <dt className="text-slate-500">Latest value</dt>
          <dd>{formatRuleValue(snapshot.metricKey, i.lastValue)}</dd>
          <dt className="text-slate-500">Condition</dt>
          <dd>
            {snapshot.metricKey === 'error_rate' ? 'Server error rate' : 'p95 latency'}{' '}
            {OPERATOR_TEXT[snapshot.operator]}{' '}
            {formatRuleValue(snapshot.metricKey, snapshot.threshold)} over{' '}
            {snapshot.windowSeconds / 60} min
          </dd>
          <dt className="text-slate-500">Rule</dt>
          <dd>{i.rule ? i.rule.name : 'deleted'}</dd>
        </dl>
        <p className="mt-3 text-sm">
          <Link
            to={`/orgs/${org.id}/projects/${project.id}/logs?severity=ERROR,WARN`}
            className="underline"
          >
            Investigate recent errors in the log explorer →
          </Link>
        </p>
      </Card>

      <Card title="Notification attempts">
        {deliveries.isPending && <Spinner />}
        {deliveries.isError && <Alert>{errorMessage(deliveries.error)}</Alert>}
        {deliveries.data?.deliveries.length === 0 && (
          <p className="text-sm text-slate-600">
            No notifications were sent for this incident. The rule may have no destination, or
            delivery is still queued.
          </p>
        )}
        {deliveries.data && deliveries.data.deliveries.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Event</th>
                  <th className="py-2 pr-4 font-medium">Attempt</th>
                  <th className="py-2 pr-4 font-medium">Result</th>
                  <th className="py-2 pr-4 font-medium">HTTP</th>
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {deliveries.data.deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="py-2 pr-4">
                      {d.event === 'incident_firing' ? 'Firing' : 'Resolved'}
                    </td>
                    <td className="py-2 pr-4">{d.attempt}</td>
                    <td className="py-2 pr-4">
                      <DeliveryStatusBadge status={d.status} />
                    </td>
                    <td className="py-2 pr-4">{d.responseStatus ?? '—'}</td>
                    <td className="py-2 pr-4 text-slate-600">{formatDateTime(d.startedAt)}</td>
                    <td className="py-2 text-slate-600">{d.errorSummary ?? '—'}</td>
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
