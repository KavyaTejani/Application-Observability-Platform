import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useOutletContext } from 'react-router';
import { Alert, Button, Card, PageHeader, RoleBadge, Spinner, table } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { Member, OrganizationDetail, OrganizationSummary } from '../lib/types';

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));

/** Organization settings (PRD §13.1): details, retention (read-only), and members. */
export function SettingsPage() {
  const current = useOutletContext<OrganizationSummary>();
  const org = useQuery({
    queryKey: ['organizations', current.id],
    queryFn: ({ signal }) =>
      api<{ organization: OrganizationDetail }>(`/organizations/${current.id}`, { signal }),
  });
  const members = useQuery({
    queryKey: ['organizations', current.id, 'members'],
    queryFn: ({ signal }) =>
      api<{ members: Member[] }>(`/organizations/${current.id}/members`, { signal }),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Organization details and members." />

      <Card title="Organization">
        {org.isPending && <Spinner />}
        {org.isError && <Alert>{errorMessage(org.error)}</Alert>}
        {org.data && (
          <dl className="grid grid-cols-1 gap-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Name" value={org.data.organization.name} />
            <Field
              label="Slug"
              value={<code className="text-xs">{org.data.organization.slug}</code>}
            />
            <Field label="Created" value={formatDate(org.data.organization.createdAt)} />
            <Field label="Your role" value={<RoleBadge role={current.role} />} />
          </dl>
        )}
      </Card>

      <Card
        title="Retention"
        description="Set for the whole deployment and shown read-only; per-organization retention is on the roadmap."
      >
        {org.data && (
          <dl className="grid grid-cols-1 gap-5 text-sm sm:grid-cols-2">
            <Field label="Logs" value={`${org.data.organization.retention.logsDays} days`} />
            <Field label="Metrics" value={`${org.data.organization.retention.metricsDays} days`} />
          </dl>
        )}
      </Card>

      <Card
        title="Members"
        description="Owners manage projects, keys, quotas, and destinations. Members view telemetry and create alert rules."
        padded={false}
      >
        {members.isPending && (
          <div className="p-5">
            <Spinner />
          </div>
        )}
        {members.isError && (
          <div className="p-5">
            <Alert>
              {errorMessage(members.error)}{' '}
              <Button
                variant="secondary"
                size="sm"
                className="ml-2"
                onClick={() => void members.refetch()}
              >
                Retry
              </Button>
            </Alert>
          </div>
        )}
        {members.data && (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Name</th>
                  <th className={table.th}>Email</th>
                  <th className={table.th}>Role</th>
                  <th className={table.th}>Joined</th>
                </tr>
              </thead>
              <tbody>
                {members.data.members.map((member) => (
                  <tr key={member.userId} className={table.row}>
                    <td className={`${table.td} font-medium text-fg`}>{member.name}</td>
                    <td className={`${table.td} text-fg-secondary`}>{member.email}</td>
                    <td className={table.td}>
                      <RoleBadge role={member.role} />
                    </td>
                    <td className={`${table.td} text-fg-secondary`}>
                      {formatDate(member.joinedAt)}
                    </td>
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

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-fg-muted">{label}</dt>
      <dd className="mt-1 font-medium text-fg">{value}</dd>
    </div>
  );
}
