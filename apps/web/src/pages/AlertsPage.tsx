import {
  ALERT_INTERVAL_SECONDS,
  ALERT_WINDOW_SECONDS,
  createAlertRuleSchema,
  toFieldErrors,
  updateAlertRuleSchema,
  type FieldErrors,
} from '@aop/validation';
import { BellRing, ChevronRight, Pencil, Plus, Power, Siren, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useOutletContext } from 'react-router';
import { IncidentStatusBadge, RuleStateBadge } from '../components/StatusBadge';
import { Alert, Button, Card, EmptyState, SelectField, Spinner, TextField } from '../components/ui';
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
const metricLabel = (key: AlertRule['metricKey']) =>
  key === 'error_rate' ? 'Error rate (5xx)' : 'p95 latency';

export function AlertsPage() {
  const { org, project } = useOutletContext<ProjectContext>();
  const rules = useRules(project.id);
  const incidents = useIncidents(project.id);
  const destinations = useDestinations(org.id);
  const me = useMe();
  const userId = me.data?.user.id;
  const [creating, setCreating] = useState(false);

  const destinationName = (id: string | null) =>
    id ? (destinations.data?.destinations.find((d) => d.id === id)?.name ?? 'unknown') : 'none';
  const firing = incidents.data?.incidents.filter((i) => i.status === 'firing').length ?? 0;

  return (
    <div className="space-y-6">
      <Card
        title={
          <span className="flex items-center gap-2">
            Incidents
            {firing > 0 && (
              <span className="rounded-full bg-[#d03b3b] px-2 py-0.5 text-xs font-semibold text-white">
                {firing} firing
              </span>
            )}
          </span>
        }
        description="One incident per continuous breach. Click one for its timeline and notifications."
        padded={false}
      >
        {incidents.isPending && (
          <div className="p-5">
            <Spinner />
          </div>
        )}
        {incidents.isError && (
          <div className="p-5">
            <Alert>{errorMessage(incidents.error)}</Alert>
          </div>
        )}
        {incidents.data?.incidents.length === 0 && (
          <EmptyState icon={Siren} title="No incidents">
            Incidents appear here when a rule fires.
          </EmptyState>
        )}
        {incidents.data && incidents.data.incidents.length > 0 && (
          <ul className="divide-y divide-divider">
            {incidents.data.incidents.map((incident) => (
              <li key={incident.id}>
                <Link
                  to={`/orgs/${org.id}/projects/${project.id}/alerts/incidents/${incident.id}`}
                  className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm hover:bg-subtle/50"
                >
                  <IncidentStatusBadge status={incident.status} />
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">
                    {incident.title}
                  </span>
                  <span className="text-xs text-fg-muted">
                    started {formatRelative(incident.startedAt)}
                    {incident.resolvedAt && ` · resolved ${formatRelative(incident.resolvedAt)}`}
                  </span>
                  <ChevronRight className="size-4 text-fg-muted" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Alert rules"
        description="Evaluated in the background. A window with no requests is “no data” and never fires; a failed metrics query sets the rule to “Error” without touching incidents."
        actions={
          !creating && (
            <Button icon={Plus} onClick={() => setCreating(true)}>
              New rule
            </Button>
          )
        }
        padded={false}
      >
        {creating && (
          <div className="bw-b border-line bg-subtle/40 p-5">
            <RuleForm
              mode="create"
              projectId={project.id}
              orgId={org.id}
              isOwner={org.role === 'owner'}
              onDone={() => setCreating(false)}
            />
          </div>
        )}
        {rules.isPending && (
          <div className="p-5">
            <Spinner />
          </div>
        )}
        {rules.isError && (
          <div className="p-5">
            <Alert>{errorMessage(rules.error)}</Alert>
          </div>
        )}
        {rules.data?.rules.length === 0 && !creating && (
          <EmptyState
            icon={BellRing}
            title="No alert rules yet"
            action={
              <Button icon={Plus} onClick={() => setCreating(true)}>
                Create a rule
              </Button>
            }
          >
            Get notified when the error rate or p95 latency crosses a threshold.
          </EmptyState>
        )}
        {rules.data && rules.data.rules.length > 0 && (
          <ul className="divide-y divide-divider">
            {rules.data.rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                projectId={project.id}
                orgId={org.id}
                isOwner={org.role === 'owner'}
                destination={destinationName(rule.notificationDestinationId)}
                canManage={org.role === 'owner' || rule.createdBy === userId}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function RuleRow({
  rule,
  projectId,
  orgId,
  isOwner,
  destination,
  canManage,
}: {
  rule: AlertRule;
  projectId: string;
  orgId: string;
  isOwner: boolean;
  destination: string;
  canManage: boolean;
}) {
  const update = useUpdateRule(projectId);
  const remove = useDeleteRule(projectId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);

  return (
    <li className="px-5 py-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <RuleStateBadge state={rule.lastState} enabled={rule.enabled} />
            <span className="font-semibold text-fg">{rule.name}</span>
          </div>
          <p className="text-fg-secondary">
            {metricLabel(rule.metricKey)} {OPERATOR_TEXT[rule.operator]}{' '}
            <strong className="font-semibold text-fg">
              {formatRuleValue(rule.metricKey, rule.threshold)}
            </strong>{' '}
            over {minutes(rule.windowSeconds)}
            {rule.serviceName && ` · service ${rule.serviceName}`}
          </p>
          <p className="text-xs text-fg-muted">
            Last value {formatRuleValue(rule.metricKey, rule.lastValue)} · evaluated{' '}
            {rule.lastEvaluatedAt ? formatRelative(rule.lastEvaluatedAt) : 'not yet'} · every{' '}
            {minutes(rule.evaluationIntervalSeconds)} · fires after {rule.forEvaluations}, resolves
            after {rule.resolveAfterEvaluations} checks · notifies {destination}
          </p>
          {rule.lastState === 'error' && rule.lastError && (
            <p className="text-xs text-danger">Last error: {rule.lastError}</p>
          )}
        </div>
        {canManage && !editing && (
          <div className="flex flex-wrap gap-1.5">
            <Button variant="secondary" size="sm" icon={Pencil} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={Power}
              disabled={update.isPending}
              onClick={() => update.mutate({ id: rule.id, input: { enabled: !rule.enabled } })}
            >
              {rule.enabled ? 'Disable' : 'Enable'}
            </Button>
            {!confirmDelete ? (
              <Button
                variant="ghost"
                size="sm"
                icon={Trash2}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            ) : (
              <>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => remove.mutate(rule.id)}
                  disabled={remove.isPending}
                >
                  Confirm delete
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {(update.error ?? remove.error) && (
        <p className="mt-2 text-xs text-danger">{errorMessage(update.error ?? remove.error)}</p>
      )}
      {editing && (
        <div className="mt-4 rounded-lg bw border-line bg-subtle/40 p-4">
          <RuleForm
            mode="edit"
            rule={rule}
            projectId={projectId}
            orgId={orgId}
            isOwner={isOwner}
            onDone={() => setEditing(false)}
          />
        </div>
      )}
    </li>
  );
}

/**
 * Create or edit a rule. The metric and the operator are fixed once a rule exists (they define
 * what the rule measures); everything else can be edited.
 */
function RuleForm({
  mode,
  rule,
  projectId,
  orgId,
  isOwner,
  onDone,
}: {
  mode: 'create' | 'edit';
  rule?: AlertRule;
  projectId: string;
  orgId: string;
  isOwner: boolean;
  onDone: () => void;
}) {
  const create = useCreateRule(projectId);
  const update = useUpdateRule(projectId);
  const mutation = mode === 'create' ? create : update;
  const destinations = useDestinations(orgId);
  const [fields, setFields] = useState<FieldErrors>({});
  const [metricKey, setMetricKey] = useState<'error_rate' | 'p95_latency'>(
    rule?.metricKey ?? 'error_rate',
  );
  const isPercent = metricKey === 'error_rate';
  const thresholdDefault = rule
    ? String(isPercent ? +(rule.threshold * 100).toFixed(4) : rule.threshold)
    : isPercent
      ? '5'
      : '500';

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rawThreshold = Number(form.get('threshold'));
    const destination = String(form.get('destination') ?? '');
    const service = String(form.get('serviceName') ?? '').trim();
    const common = {
      name: form.get('name'),
      // The UI takes percent for error rate; the API stores a ratio.
      threshold: isPercent ? rawThreshold / 100 : rawThreshold,
      windowSeconds: Number(form.get('windowSeconds')),
      evaluationIntervalSeconds: Number(form.get('evaluationIntervalSeconds')),
      forEvaluations: Number(form.get('forEvaluations')),
      resolveAfterEvaluations: Number(form.get('resolveAfterEvaluations')),
    };
    const onError = (error: unknown) => error instanceof ApiError && setFields(error.fieldErrors);

    if (mode === 'create') {
      const parsed = createAlertRuleSchema.safeParse({
        ...common,
        metricKey,
        operator: form.get('operator'),
        ...(service ? { serviceName: service } : {}),
        ...(destination ? { notificationDestinationId: destination } : {}),
      });
      if (!parsed.success) return setFields(toFieldErrors(parsed.error));
      setFields({});
      create.mutate(parsed.data, { onSuccess: onDone, onError });
    } else if (rule) {
      const parsed = updateAlertRuleSchema.safeParse({
        ...common,
        // null clears the field on the server.
        serviceName: service || null,
        notificationDestinationId: destination || null,
      });
      if (!parsed.success) return setFields(toFieldErrors(parsed.error));
      setFields({});
      update.mutate({ id: rule.id, input: parsed.data }, { onSuccess: onDone, onError });
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <p className="text-sm font-semibold text-fg">
        {mode === 'create' ? 'New alert rule' : `Edit “${rule?.name}”`}
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        <TextField
          label="Name"
          name="name"
          placeholder="e.g. Checkout errors"
          defaultValue={rule?.name}
          error={fields.name}
        />
        {mode === 'create' ? (
          <SelectField
            label="Metric"
            value={metricKey}
            onChange={(e) => setMetricKey(e.target.value as typeof metricKey)}
          >
            <option value="error_rate">Server error rate (5xx)</option>
            <option value="p95_latency">p95 latency</option>
          </SelectField>
        ) : (
          <div>
            <p className="text-sm font-medium text-fg">Condition</p>
            <p className="mt-1.5 rounded-lg bw border-line bg-subtle px-3 py-2 text-sm text-fg-secondary">
              {metricLabel(metricKey)} {OPERATOR_TEXT[rule?.operator ?? 'gt']} threshold
            </p>
          </div>
        )}
        <div className="grid grid-cols-[auto_1fr] gap-2">
          {mode === 'create' && (
            <SelectField label="Condition" name="operator" defaultValue="gt">
              <option value="gt">above (&gt;)</option>
              <option value="gte">at or above (≥)</option>
            </SelectField>
          )}
          <div className={mode === 'edit' ? 'col-span-2' : ''}>
            <TextField
              label={isPercent ? 'Threshold (%)' : 'Threshold (ms)'}
              name="threshold"
              type="number"
              step="any"
              defaultValue={thresholdDefault}
              key={metricKey}
              error={fields.threshold}
            />
          </div>
        </div>
        <SelectField
          label="Window"
          name="windowSeconds"
          defaultValue={String(rule?.windowSeconds ?? 300)}
          error={fields.windowSeconds}
        >
          {ALERT_WINDOW_SECONDS.map((s) => (
            <option key={s} value={s}>
              {minutes(s)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Evaluate every"
          name="evaluationIntervalSeconds"
          defaultValue={String(rule?.evaluationIntervalSeconds ?? 60)}
        >
          {ALERT_INTERVAL_SECONDS.map((s) => (
            <option key={s} value={s}>
              {minutes(s)}
            </option>
          ))}
        </SelectField>
        <div className="grid grid-cols-2 gap-2">
          <TextField
            label="Fire after"
            name="forEvaluations"
            type="number"
            min={1}
            max={10}
            defaultValue={String(rule?.forEvaluations ?? 2)}
            error={fields.forEvaluations}
            hint="checks"
          />
          <TextField
            label="Resolve after"
            name="resolveAfterEvaluations"
            type="number"
            min={1}
            max={10}
            defaultValue={String(rule?.resolveAfterEvaluations ?? 2)}
            error={fields.resolveAfterEvaluations}
            hint="checks"
          />
        </div>
        <TextField
          label="Service (optional)"
          name="serviceName"
          placeholder="all services"
          defaultValue={rule?.serviceName ?? ''}
          error={fields.serviceName}
        />
        <SelectField
          label="Notify"
          name="destination"
          defaultValue={rule?.notificationDestinationId ?? ''}
          error={fields.notificationDestinationId}
        >
          <option value="">No notification</option>
          {destinations.data?.destinations
            .filter((d) => d.enabled && (!d.projectId || d.projectId === projectId))
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.urlPreview})
              </option>
            ))}
        </SelectField>
        <p className="self-end text-xs text-fg-muted md:col-span-1">
          {isOwner ? (
            <Link to={`/orgs/${orgId}/notifications`} className="text-accent-text hover:underline">
              Manage webhook destinations
            </Link>
          ) : (
            'Owners manage webhook destinations.'
          )}
        </p>
      </div>
      {mutation.isError && !hasFieldErrors(mutation.error) && (
        <Alert>{errorMessage(mutation.error)}</Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : mode === 'create' ? 'Create rule' : 'Save changes'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
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
    <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
      <dt className="text-fg-muted">Started</dt>
      <dd className="text-fg">{formatDateTime(startedAt)}</dd>
      <dt className="text-fg-muted">Resolved</dt>
      <dd className="text-fg">{resolvedAt ? formatDateTime(resolvedAt) : 'still firing'}</dd>
    </dl>
  );
}
