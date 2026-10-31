import { MAX_ROTATION_GRACE_HOURS } from '@aop/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { BellRing, ChevronRight, Gauge, KeyRound, ScrollText } from 'lucide-react';
import { FreshnessBadge } from '../components/StatusBadge';
import { Alert, Button, Card, Pill, Spinner, TextField, inputClass, table } from '../components/ui';
import { api, errorMessage, hasFieldErrors, ApiError } from '../lib/api';
import { formatRelative } from '../lib/format';
import type { ApiKeySummary, CreatedApiKey, OrganizationSummary, Project } from '../lib/types';
import { projectsKey, rememberProject } from '../lib/projects';

const formatDateTime = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(iso),
      )
    : '—';

const keysKey = (projectId: string) => ['projects', projectId, 'keys'];

export interface ProjectContext {
  org: OrganizationSummary;
  project: Project;
}

/**
 * Shell for one project: header, freshness, and tabs (dashboard, logs, keys and settings). The
 * project is loaded once here and shared with the tabs through the outlet context.
 */
export function ProjectLayout() {
  const org = useOutletContext<OrganizationSummary>();
  const { projectId = '' } = useParams();

  const project = useQuery({
    queryKey: ['projects', projectId],
    queryFn: ({ signal }) => api<{ project: Project }>(`/projects/${projectId}`, { signal }),
    refetchInterval: 60_000,
  });

  // The sidebar's Metrics / Logs / Alerts links reopen the project used last.
  useEffect(() => {
    if (project.data) rememberProject(org.id, project.data.project.id);
  }, [org.id, project.data]);

  if (project.isPending) return <Spinner />;
  if (project.isError) {
    return (
      <div className="space-y-4">
        <Alert>{errorMessage(project.error)}</Alert>
        <Link to={`/orgs/${org.id}/projects`} className="text-sm underline">
          Back to projects
        </Link>
      </div>
    );
  }

  const { project: p } = project.data;
  const base = `/orgs/${org.id}/projects/${p.id}`;
  const tab = ({ isActive }: { isActive: boolean }) =>
    `inline-flex items-center gap-1.5 rounded-t-lg px-3 py-2 font-display text-sm font-semibold transition-colors ${
      isActive
        ? '-mb-[var(--b-w)] bw border-b-0 border-ink bg-accent text-accent-fg'
        : 'text-fg-muted hover:text-fg'
    }`;

  return (
    <div className="space-y-6">
      <div>
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-fg-muted">
          <Link to={`/orgs/${org.id}/projects`} className="hover:text-fg">
            Projects
          </Link>
          <ChevronRight className="size-3.5" aria-hidden="true" />
          <span className="text-fg-secondary">{p.name}</span>
        </nav>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{p.name}</h1>
          <Pill>{p.environment}</Pill>
          <FreshnessBadge lastTelemetryAt={p.lastTelemetryAt} />
        </div>
        <p className="mt-1 text-sm text-fg-muted">
          Last data received{' '}
          <span className="text-fg-secondary" title={p.lastTelemetryAt ?? undefined}>
            {formatRelative(p.lastTelemetryAt)}
          </span>
        </p>
      </div>
      <nav aria-label="Project" className="flex gap-1 overflow-x-auto bw-b border-line select-none">
        <NavLink to={base} end className={tab}>
          <Gauge className="size-4" aria-hidden="true" /> Metrics
        </NavLink>
        <NavLink to={`${base}/logs`} className={tab}>
          <ScrollText className="size-4" aria-hidden="true" /> Logs
        </NavLink>
        <NavLink to={`${base}/alerts`} className={tab}>
          <BellRing className="size-4" aria-hidden="true" /> Alerts
        </NavLink>
        <NavLink to={`${base}/settings`} className={tab}>
          <KeyRound className="size-4" aria-hidden="true" /> Keys &amp; setup
        </NavLink>
      </nav>
      <Outlet context={{ org, project: p } satisfies ProjectContext} />
    </div>
  );
}

export function ProjectSettingsPage() {
  const { org, project } = useOutletContext<ProjectContext>();
  const isOwner = org.role === 'owner';
  return (
    <div className="space-y-6">
      <ApiKeysCard projectId={project.id} canManage={isOwner} />
      <SdkSetupCard project={project} />
      {isOwner && <DangerZone organizationId={org.id} project={project} />}
    </div>
  );
}

function ApiKeysCard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<CreatedApiKey | null>(null);
  const keys = useQuery({
    queryKey: keysKey(projectId),
    queryFn: ({ signal }) =>
      api<{ keys: ApiKeySummary[] }>(`/projects/${projectId}/keys`, { signal }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: keysKey(projectId) });

  const create = useMutation({
    mutationFn: (name: string) =>
      api<CreatedApiKey>(`/projects/${projectId}/keys`, { method: 'POST', body: { name } }),
    onSuccess: (created) => {
      setRevealed(created);
      void refresh();
    },
  });

  const onCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const name = String(new FormData(formElement).get('name') ?? '').trim();
    create.mutate(name || 'Default key', { onSuccess: () => formElement.reset() });
  };

  return (
    <Card
      title="Ingestion API keys"
      description="Keys let a service send telemetry to this project. They can only write telemetry; they cannot read data or manage your account."
    >
      {revealed && <RevealedKey created={revealed} onDismiss={() => setRevealed(null)} />}

      {keys.isPending && <Spinner />}
      {keys.isError && <Alert>{errorMessage(keys.error)}</Alert>}
      {keys.data?.keys.length === 0 && <p className="text-sm text-fg-secondary">No keys yet.</p>}
      {keys.data && keys.data.keys.length > 0 && (
        <div className={`${table.wrap} -mx-5 bw-b border-line ${revealed ? 'bw-t' : '-mt-5'}`}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Name</th>
                <th className={table.th}>Key</th>
                <th className={table.th}>Status</th>
                <th className={table.th}>Last used</th>
                {canManage && <th className={table.th}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {keys.data.keys.map((key) => (
                <KeyRow
                  key={key.keyId}
                  apiKey={key}
                  projectId={projectId}
                  canManage={canManage}
                  onRotated={(created) => {
                    setRevealed(created);
                    void refresh();
                  }}
                  onChanged={() => void refresh()}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <form onSubmit={onCreate} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <TextField label="New key name" name="name" placeholder="e.g. production server" />
          </div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create key'}
          </Button>
        </form>
      )}
      {create.isError && (
        <div className="mt-3">
          <Alert>{errorMessage(create.error)}</Alert>
        </div>
      )}
    </Card>
  );
}

const STATE_LABEL: Record<ApiKeySummary['state'], { text: string; dot: string }> = {
  active: { text: 'Active', dot: 'bg-[#0ca30c]' },
  expiring: { text: 'Expiring', dot: 'bg-[#fab219]' },
  revoked: { text: 'Revoked', dot: 'bg-fg-muted' },
};

function KeyRow({
  apiKey,
  projectId,
  canManage,
  onRotated,
  onChanged,
}: {
  apiKey: ApiKeySummary;
  projectId: string;
  canManage: boolean;
  onRotated: (created: CreatedApiKey) => void;
  onChanged: () => void;
}) {
  const [confirm, setConfirm] = useState<'revoke' | 'rotate' | null>(null);
  const [graceHours, setGraceHours] = useState(0);
  const base = `/projects/${projectId}/keys/${apiKey.keyId}`;

  const revoke = useMutation({
    mutationFn: () => api(`${base}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      setConfirm(null);
      onChanged();
    },
  });
  const rotate = useMutation({
    mutationFn: () =>
      api<{ replacement: CreatedApiKey }>(`${base}/rotate`, {
        method: 'POST',
        body: { gracePeriodHours: graceHours },
      }),
    onSuccess: (result) => {
      setConfirm(null);
      onRotated(result.replacement);
    },
  });

  const error = revoke.error ?? rotate.error;
  return (
    <tr className={`${table.row} align-top`}>
      <td className={`${table.td} font-medium text-fg`}>{apiKey.name}</td>
      <td className={`${table.td} font-mono text-xs text-fg-secondary`}>{apiKey.prefix}.••••</td>
      <td className={table.td}>
        <span className="inline-flex items-center gap-1.5 text-fg-secondary">
          <span
            className={`size-2 rounded-full ${STATE_LABEL[apiKey.state].dot}`}
            aria-hidden="true"
          />
          {STATE_LABEL[apiKey.state].text}
        </span>
        {apiKey.state === 'expiring' && (
          <div className="text-xs text-fg-muted">until {formatDateTime(apiKey.expiresAt)}</div>
        )}
      </td>
      <td className={`${table.td} text-fg-secondary`}>{formatDateTime(apiKey.lastUsedAt)}</td>
      {canManage && (
        <td className={table.td}>
          {apiKey.state === 'active' && confirm === null && (
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirm('rotate')}>
                Rotate
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirm('revoke')}>
                Revoke
              </Button>
            </div>
          )}
          {apiKey.state === 'expiring' && confirm === null && (
            <Button variant="ghost" size="sm" onClick={() => setConfirm('revoke')}>
              Revoke now
            </Button>
          )}
          {confirm === 'revoke' && (
            <div className="space-y-2">
              <p className="text-xs text-fg-secondary">
                Services using this key will stop sending data.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => revoke.mutate()}
                  disabled={revoke.isPending}
                >
                  {revoke.isPending ? 'Revoking…' : 'Confirm revoke'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {confirm === 'rotate' && (
            <div className="space-y-2">
              <label className="block text-xs text-fg-secondary">
                Keep the old key working for
                <select
                  value={graceHours}
                  onChange={(event) => setGraceHours(Number(event.target.value))}
                  className={`ml-2 ${inputClass} py-1 text-xs`}
                >
                  {[0, 1, 6, 12, MAX_ROTATION_GRACE_HOURS].map((h) => (
                    <option key={h} value={h}>
                      {h === 0 ? 'no time (revoke now)' : `${h} hours`}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
                  {rotate.isPending ? 'Rotating…' : 'Confirm rotate'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {error && <p className="mt-1 text-xs text-danger">{errorMessage(error)}</p>}
        </td>
      )}
    </tr>
  );
}

/** One-time display of a new key's secret. It is never retrievable again. */
function RevealedKey({ created, onDismiss }: { created: CreatedApiKey; onDismiss: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div
      className="mb-5 rounded-xl bw border-l-[6px] border-warn-line border-l-pink bg-warn-soft p-4 shadow-control"
      role="status"
    >
      <p className="text-sm font-semibold text-warn">
        Copy your new key “{created.key.name}” now. It will not be shown again.
      </p>
      <p className="mt-1 text-xs text-warn">
        Store it in your service's environment (e.g. <code>AOP_API_KEY</code>), never in source
        control.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="block max-w-full overflow-x-auto rounded bg-surface px-2 py-1 font-mono text-xs break-all text-fg select-all">
          {created.secret}
        </code>
        <Button variant="secondary" onClick={() => void copy()}>
          {copied === 'copied' ? 'Copied ✔' : 'Copy'}
        </Button>
        <Button variant="secondary" onClick={onDismiss}>
          I've stored it
        </Button>
      </div>
      {copied === 'failed' && (
        <p className="mt-2 text-xs text-danger">
          Copy failed; select the key and copy it manually.
        </p>
      )}
    </div>
  );
}

function SdkSetupCard({ project }: { project: Project }) {
  const origin = window.location.origin;
  return (
    <Card
      title="Connect a service"
      description="Set these environment variables in the service you want to monitor, then verify the connection."
    >
      <pre className="overflow-x-auto rounded-lg bw border-ink bg-[#111111] p-4 select-all font-mono text-xs leading-relaxed text-[#f2ede2] dark:bg-[#0c0b10]">
        {`AOP_ENDPOINT=${origin}
AOP_API_KEY=<your key>
AOP_SERVICE_NAME=${project.slug}
AOP_ENVIRONMENT=${project.environment}

curl -X POST ${origin}/v1/telemetry/test \\
  -H "Authorization: Bearer $AOP_API_KEY"`}
      </pre>
    </Card>
  );
}

function DangerZone({ organizationId, project }: { organizationId: string; project: Project }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [renameError, setRenameError] = useState<string>();

  const rename = useMutation({
    mutationFn: (name: string) =>
      api<{ project: Project }>(`/projects/${project.id}`, { method: 'PATCH', body: { name } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', project.id] });
      void queryClient.invalidateQueries({ queryKey: projectsKey(organizationId) });
    },
    onError: (error) =>
      setRenameError(
        error instanceof ApiError ? (error.fieldErrors.name ?? error.message) : undefined,
      ),
  });
  const remove = useMutation({
    mutationFn: () => api(`/projects/${project.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectsKey(organizationId) });
      navigate(`/orgs/${organizationId}/projects`, { replace: true });
    },
  });

  const onRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRenameError(undefined);
    rename.mutate(String(new FormData(event.currentTarget).get('name') ?? '').trim());
  };

  return (
    <Card title="Project settings">
      <form onSubmit={onRename} className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <TextField
            label="Rename project"
            name="name"
            defaultValue={project.name}
            error={renameError}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={rename.isPending}>
          Save name
        </Button>
      </form>
      {rename.isError && !hasFieldErrors(rename.error) && !renameError && (
        <div className="mt-3">
          <Alert>{errorMessage(rename.error)}</Alert>
        </div>
      )}

      <div className="mt-6 border-t border-divider pt-4">
        <p className="text-sm font-semibold text-danger">Danger zone</p>
        <p className="mt-1 text-sm text-fg-secondary">
          Deleting the project revokes all of its keys immediately. Telemetry already stored is
          removed by normal retention, not instantly.
        </p>
        {!confirming ? (
          <Button variant="danger" className="mt-3" onClick={() => setConfirming(true)}>
            Delete project
          </Button>
        ) : (
          <div className="mt-3 flex gap-2">
            <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? 'Deleting…' : `Yes, delete “${project.name}”`}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        )}
        {remove.isError && (
          <div className="mt-3">
            <Alert>{errorMessage(remove.error)}</Alert>
          </div>
        )}
      </div>
    </Card>
  );
}
