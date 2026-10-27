import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { Alert, Button, Card, RoleBadge, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { Member, OrganizationDetail, OrganizationSummary } from '../lib/types';

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));

export function OverviewPage() {
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
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{current.name}</h1>
        <p className="mt-1 text-sm text-slate-600">Organization overview</p>
      </div>

      <Card title="Organization">
        {org.isPending && <Spinner />}
        {org.isError && <Alert>{errorMessage(org.error)}</Alert>}
        {org.data && (
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">Created</dt>
              <dd className="font-medium">{formatDate(org.data.organization.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Log retention</dt>
              <dd className="font-medium">{org.data.organization.retention.logsDays} days</dd>
            </div>
            <div>
              <dt className="text-slate-500">Metric retention</dt>
              <dd className="font-medium">
                {org.data.organization.retention.metricsDays} days{' '}
                <span className="font-normal text-slate-500">(deployment-wide)</span>
              </dd>
            </div>
          </dl>
        )}
      </Card>

      <Card title="Members">
        {members.isPending && <Spinner />}
        {members.isError && (
          <Alert>
            {errorMessage(members.error)}{' '}
            <Button variant="secondary" className="ml-2" onClick={() => void members.refetch()}>
              Retry
            </Button>
          </Alert>
        )}
        {members.data && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Email</th>
                  <th className="py-2 pr-4 font-medium">Role</th>
                  <th className="py-2 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {members.data.members.map((member) => (
                  <tr key={member.userId}>
                    <td className="py-2 pr-4">{member.name}</td>
                    <td className="py-2 pr-4 text-slate-600">{member.email}</td>
                    <td className="py-2 pr-4">
                      <RoleBadge role={member.role} />
                    </td>
                    <td className="py-2 text-slate-600">{formatDate(member.joinedAt)}</td>
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
