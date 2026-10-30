import { Activity, ArrowRight, FolderKanban, Plus, Radio, Users } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router';
import { FreshnessBadge } from '../components/StatusBadge';
import { Alert, Card, EmptyState, PageHeader, Pill, Spinner, StatTile } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatNumber, formatRelative } from '../lib/format';
import { useProjects } from '../lib/projects';
import type { Member, OrganizationSummary } from '../lib/types';
import { useNow } from '../lib/use-now';
import { useUsage } from '../lib/usage';

const RECEIVING_MS = 5 * 60_000;

/** Organization home: headline numbers and the projects with their telemetry freshness. */
export function OverviewPage() {
  const org = useOutletContext<OrganizationSummary>();
  const projects = useProjects(org.id);
  const usage = useUsage(org.id);
  const members = useQuery({
    queryKey: ['organizations', org.id, 'members'],
    queryFn: ({ signal }) =>
      api<{ members: Member[] }>(`/organizations/${org.id}/members`, { signal }),
  });

  const now = useNow();
  const list = projects.data?.projects ?? [];
  const receiving = list.filter(
    (p) => p.lastTelemetryAt && now - Date.parse(p.lastTelemetryAt) < RECEIVING_MS,
  ).length;
  const quota = usage.data?.usage.quota.records;

  return (
    <div className="space-y-8">
      <PageHeader title={org.name} description="Organization overview" />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          icon={FolderKanban}
          label="Projects"
          value={projects.data ? list.length : '—'}
          hint={
            usage.data ? `of ${usage.data.usage.resources.projects.limit} on your plan` : undefined
          }
        />
        <StatTile
          icon={Radio}
          label="Receiving data"
          value={projects.data ? receiving : '—'}
          hint="projects with data in the last 5 min"
        />
        <StatTile
          icon={Activity}
          label="Records today"
          value={quota ? formatNumber(quota.used) : '—'}
          hint={quota ? `of ${formatNumber(quota.limit)} daily quota (UTC)` : undefined}
        />
        <StatTile
          icon={Users}
          label="Members"
          value={members.data ? members.data.members.length : '—'}
          hint={
            <Link to={`/orgs/${org.id}/settings`} className="text-accent-text hover:underline">
              Manage in settings
            </Link>
          }
        />
      </div>

      <Card
        title="Projects"
        description="Open a project to see its metrics, logs, and alerts."
        actions={
          <Link
            to={`/orgs/${org.id}/projects`}
            className="inline-flex items-center gap-1 text-sm font-medium text-accent-text hover:underline"
          >
            All projects <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        }
        padded={false}
      >
        {projects.isPending && (
          <div className="p-5">
            <Spinner />
          </div>
        )}
        {projects.isError && (
          <div className="p-5">
            <Alert>{errorMessage(projects.error)}</Alert>
          </div>
        )}
        {projects.data && list.length === 0 && (
          <EmptyState
            icon={FolderKanban}
            title="No projects yet"
            action={
              org.role === 'owner' ? (
                <Link
                  to={`/orgs/${org.id}/projects`}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
                >
                  <Plus className="size-4" aria-hidden="true" /> Create a project
                </Link>
              ) : undefined
            }
          >
            {org.role === 'owner'
              ? 'Create a project, add its ingestion key to your service, and telemetry appears here.'
              : 'Ask an organization owner to create one.'}
          </EmptyState>
        )}
        {list.length > 0 && (
          <ul className="divide-y divide-divider">
            {list.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/orgs/${org.id}/projects/${p.id}`}
                  className="flex flex-wrap items-center gap-3 px-5 py-3.5 hover:bg-subtle/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-fg">{p.name}</span>
                    <span className="block text-xs text-fg-muted sm:ml-2 sm:inline">
                      last data {formatRelative(p.lastTelemetryAt)}
                    </span>
                  </span>
                  <Pill>{p.environment}</Pill>
                  <FreshnessBadge lastTelemetryAt={p.lastTelemetryAt} />
                  <ArrowRight className="size-4 text-fg-muted" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
