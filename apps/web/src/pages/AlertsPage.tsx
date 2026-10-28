import {
  ALERT_INTERVAL_SECONDS,
  ALERT_WINDOW_SECONDS,
  createAlertRuleSchema,
  toFieldErrors,
  type FieldErrors,
} from '@aop/validation';
import { useState, type FormEvent } from 'react';
import { Link, useOutletContext } from 'react-router';
import { IncidentStatusBadge, RuleStateBadge } from '../components/StatusBadge';
import { Alert, Button, Card, Spinner, TextField } from '../components/ui';
import { ApiError, errorMessage, hasFieldErrors } from '../lib/api';
import {
  OPERATOR_TEXT,
  formatRuleValue,
  useCreateRule,
  useDeleteRule,
  useDestinations,
  useIncidents,
  useRules,
  useUpdateRule,
  type AlertRule,
} from '../lib/alerts';
import { useMe } from '../lib/auth';
import { formatDateTime, formatRelative } from '../lib/format';
import type { ProjectContext } from './ProjectPage';

const minutes = (s: number) => (s < 60 ? `${s} s` : `${s / 60} min`);

export function AlertsPage() {
  const { org, project } = useOutletContext<ProjectContext>();
  const rules = useRules(project.id);
  const incidents = useIncidents(project.id);
  const destinations = useDestinations(org.id);
  const me = useMe();
  const userId = me.data?.user.id;

  const destinationName = (id: string | null) =>
    id ? (destinations.data?.destinations.find((d) => d.id === id)?.name ?? 'unknown') : 'none';

  return (
    <div className="space-y-6">
      <Card title="Incidents">
        {incidents.isPending && <Spinner />}
        {incidents.isError && <Alert>{errorMessage(incidents.error)}</Alert>}
        {incidents.data?.incidents.length === 0 && (
          <p className="text-sm text-slate-600">
            No incidents. They appear here when a rule fires.
          </p>
        )}
        {incidents.data && incidents.data.incidents.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {incidents.data.incidents.map((incident) => (
              <li key={incident.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <IncidentStatusBadge status={incident.status} />
                <Link
                  to={`/orgs/${org.id}/projects/${project.id}/alerts/incidents/${incident.id}`}
                  className="min-w-0 flex-1 truncate font-medium text-slate-900 underline-offset-2 hover:underline"
                >
                  {incident.title}
                </Link>
                <span className="text-xs text-slate-500">
                  started {formatRelative(incident.startedAt)}
                  {incident.resolvedAt && ` · resolved ${formatRelative(incident.resolvedAt)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Alert rules">
        {rules.isPending && <Spinner />}
        {rules.isError && <Alert>{errorMessage(rules.error)}</Alert>}
        {rules.data?.rules.length === 0 && (
          <p className="text-sm text-slate-600">No alert rules yet.</p>
        )}
        {rules.data && rules.data.rules.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {rules.data.rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                projectId={project.id}
                destination={destinationName(rule.notificationDestinationId)}
                canManage={org.role === 'owner' || rule.createdBy === userId}
              />
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Rules are evaluated in the background. A window with no requests counts as “no data” and
          never fires. A failed metrics query sets the rule to “Error” without changing incidents.
        </p>
      </Card>

      <CreateRuleForm projectId={project.id} orgId={org.id} isOwner={org.role === 'owner'} />
    </div>
  );
}

function RuleRow({
  rule,
  projectId,
  destination,
  canManage,
}: {
  rule: AlertRule;
  projectId: string;
  destination: string;
  canManage: boolean;
}) {
  const update = useUpdateRule(projectId);
  const remove = useDeleteRule(projectId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const metric = rule.metricKey === 'error_rate' ? 'Error rate (5xx)' : 'p95 latency';

  return (
    <li className="space-y-1 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <RuleStateBadge state={rule.lastState} enabled={rule.enabled} />
        <span className="font-medium text-slate-900">{rule.name}</span>
        <span className="text-slate-600">
          {metric} {OPERATOR_TEXT[rule.operator]} {formatRuleValue(rule.metricKey, rule.threshold)}{' '}
          over {minutes(rule.windowSeconds)}
          {rule.serviceName && ` · service ${rule.serviceName}`}
        </span>
      </div>
      <div className="text-xs text-slate-500">
        Last value: {formatRuleValue(rule.metricKey, rule.lastValue)} · evaluated{' '}
        {rule.lastEvaluatedAt ? formatRelative(rule.lastEvaluatedAt) : 'not yet'} · every{' '}
        {minutes(rule.evaluationIntervalSeconds)} · fires after {rule.forEvaluations}, resolves
        after {rule.resolveAfterEvaluations} checks · notifies: {destination}
      </div>
      {rule.lastState === 'error' && rule.lastError && (
        <div className="text-xs text-[#a34a23]">Last error: {rule.lastError}</div>
      )}
      {canManage && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            variant="secondary"
            disabled={update.isPending}
            onClick={() => update.mutate({ id: rule.id, input: { enabled: !rule.enabled } })}
          >
            {rule.enabled ? 'Disable' : 'Enable'}
          </Button>
          {!confirmDelete ? (
            <Button variant="secondary" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          ) : (
            <>
              <Button onClick={() => remove.mutate(rule.id)} disabled={remove.isPending}>
                Confirm delete
              </Button>
              <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
      {(update.error ?? remove.error) && (
        <p className="text-xs text-red-700">{errorMessage(update.error ?? remove.error)}</p>
      )}
    </li>
  );
}

function CreateRuleForm({
  projectId,
  orgId,
  isOwner,
}: {
  projectId: string;
  orgId: string;
  isOwner: boolean;
}) {
  const create = useCreateRule(projectId);
  const destinations = useDestinations(orgId);
  const [fields, setFields] = useState<FieldErrors>({});
  const [metricKey, setMetricKey] = useState<'error_rate' | 'p95_latency'>('error_rate');

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const rawThreshold = Number(form.get('threshold'));
    const destination = String(form.get('destination') ?? '');
    const service = String(form.get('serviceName') ?? '').trim();
    const parsed = createAlertRuleSchema.safeParse({
      name: form.get('name'),
      metricKey,
      operator: form.get('operator'),
      // The UI takes percent for error rate; the API stores a ratio.
      threshold: metricKey === 'error_rate' ? rawThreshold / 100 : rawThreshold,
      windowSeconds: Number(form.get('windowSeconds')),
      evaluationIntervalSeconds: Number(form.get('evaluationIntervalSeconds')),
      forEvaluations: Number(form.get('forEvaluations')),
      resolveAfterEvaluations: Number(form.get('resolveAfterEvaluations')),
      ...(service ? { serviceName: service } : {}),
      ...(destination ? { notificationDestinationId: destination } : {}),
    });
    if (!parsed.success) {
      setFields(toFieldErrors(parsed.error));
      return;
    }
    setFields({});
    create.mutate(parsed.data, {
      onSuccess: () => formElement.reset(),
      onError: (error) => error instanceof ApiError && setFields(error.fieldErrors),
    });
  };

  const select = 'mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm';
  return (
    <Card title="Create an alert rule">
      <form onSubmit={onSubmit} noValidate className="grid gap-4 md:grid-cols-3">
        <TextField
          label="Name"
          name="name"
          placeholder="e.g. Checkout errors"
          error={fields.name}
        />
        <label className="text-sm font-medium text-slate-700">
          Metric
          <select
            value={metricKey}
            onChange={(e) => setMetricKey(e.target.value as typeof metricKey)}
            className={select}
          >
            <option value="error_rate">Server error rate (5xx)</option>
            <option value="p95_latency">p95 latency</option>
          </select>
        </label>
        <div className="grid grid-cols-[auto_1fr] gap-2">
          <label className="text-sm font-medium text-slate-700">
            Condition
            <select name="operator" defaultValue="gt" className={select}>
              <option value="gt">above (&gt;)</option>
              <option value="gte">at or above (≥)</option>
            </select>
          </label>
          <TextField
            label={metricKey === 'error_rate' ? 'Threshold (%)' : 'Threshold (ms)'}
            name="threshold"
            type="number"
            step="any"
            defaultValue={metricKey === 'error_rate' ? '5' : '500'}
            key={metricKey}
            error={fields.threshold}
          />
        </div>
        <label className="text-sm font-medium text-slate-700">
          Window
          <select name="windowSeconds" defaultValue="300" className={select}>
            {ALERT_WINDOW_SECONDS.map((s) => (
              <option key={s} value={s}>
                {minutes(s)}
              </option>
            ))}
          </select>
          {fields.windowSeconds && (
            <span className="mt-1 block text-sm text-red-700">{fields.windowSeconds}</span>
          )}
        </label>
        <label className="text-sm font-medium text-slate-700">
          Evaluate every
          <select name="evaluationIntervalSeconds" defaultValue="60" className={select}>
            {ALERT_INTERVAL_SECONDS.map((s) => (
              <option key={s} value={s}>
                {minutes(s)}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <TextField
            label="Fire after (checks)"
            name="forEvaluations"
            type="number"
            min={1}
            max={10}
            defaultValue="2"
            error={fields.forEvaluations}
          />
          <TextField
            label="Resolve after (checks)"
            name="resolveAfterEvaluations"
            type="number"
            min={1}
            max={10}
            defaultValue="2"
            error={fields.resolveAfterEvaluations}
          />
        </div>
        <TextField
          label="Service (optional)"
          name="serviceName"
          placeholder="all services"
          error={fields.serviceName}
        />
        <label className="text-sm font-medium text-slate-700">
          Notify
          <select name="destination" defaultValue="" className={select}>
            <option value="">No notification</option>
            {destinations.data?.destinations
              .filter((d) => d.enabled && (!d.projectId || d.projectId === projectId))
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.urlPreview})
                </option>
              ))}
          </select>
          {fields.notificationDestinationId && (
            <span className="mt-1 block text-sm text-red-700">
              {fields.notificationDestinationId}
            </span>
          )}
          <span className="mt-1 block text-xs font-normal text-slate-500">
            {isOwner ? (
              <Link to={`/orgs/${orgId}/notifications`} className="underline">
                Manage webhook destinations
              </Link>
            ) : (
              'Owners manage webhook destinations.'
            )}
          </span>
        </label>
        <div className="flex items-end">
          <Button type="submit" className="w-full" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create rule'}
          </Button>
        </div>
      </form>
      {create.isError && !hasFieldErrors(create.error) && (
        <div className="mt-3">
          <Alert>{errorMessage(create.error)}</Alert>
        </div>
      )}
      {create.isSuccess && (
        <div className="mt-3">
          <Alert tone="success">
            Rule “{create.data.rule.name}” created; it is evaluated within a minute.
          </Alert>
        </div>
      )}
    </Card>
  );
}

export function IncidentTimes({
  startedAt,
  resolvedAt,
}: {
  startedAt: string;
  resolvedAt: string | null;
}) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
      <dt className="text-slate-500">Started</dt>
      <dd>{formatDateTime(startedAt)}</dd>
      <dt className="text-slate-500">Resolved</dt>
      <dd>{resolvedAt ? formatDateTime(resolvedAt) : 'still firing'}</dd>
    </dl>
  );
}
