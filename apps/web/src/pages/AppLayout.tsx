import { Navigate, NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { Button, RoleBadge } from '../components/ui';
import { useLogout, useMe } from '../lib/auth';

/**
 * Signed-in shell: organization switcher, navigation, and account menu. Navigation lists only
 * features that exist; later milestones add Projects, Metrics, Logs, Alerts, and Usage here.
 */
export function AppLayout() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const { organizationId } = useParams();

  const organizations = me.data?.organizations ?? [];
  const current = organizations.find((org) => org.id === organizationId);

  if (!current) {
    // Unknown or foreign organization in the URL: fall back to the user's first organization.
    // The API enforces the boundary regardless; this only keeps the UI in a valid state.
    const first = organizations[0];
    return first ? <Navigate to={`/orgs/${first.id}`} replace /> : <NoOrganization />;
  }

  const onLogout = () =>
    logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });

  const navItem = ({ isActive }: { isActive: boolean }) =>
    `block rounded-md px-3 py-2 text-sm font-medium ${
      isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
    }`;

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-wide text-slate-900">AOP</span>
            <label className="sr-only" htmlFor="org-switcher">
              Organization
            </label>
            <select
              id="org-switcher"
              value={current.id}
              onChange={(event) => navigate(`/orgs/${event.target.value}`)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
            <RoleBadge role={current.role} />
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-600">
            <span className="hidden sm:inline">{me.data?.user.email}</span>
            <Button variant="secondary" onClick={onLogout} disabled={logout.isPending}>
              {logout.isPending ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row">
        <nav aria-label="Main" className="md:w-48 md:shrink-0">
          <ul className="flex gap-1 md:flex-col">
            <li>
              <NavLink to={`/orgs/${current.id}`} end className={navItem}>
                Overview
              </NavLink>
            </li>
            <li>
              <NavLink to="/status" className={navItem}>
                System status
              </NavLink>
            </li>
          </ul>
        </nav>
        <main className="min-w-0 flex-1">
          <Outlet context={current} />
        </main>
      </div>
    </div>
  );
}

function NoOrganization() {
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center text-slate-700">
      <h1 className="text-lg font-semibold">No organization</h1>
      <p className="mt-2 text-sm">
        Your account is not a member of any organization. Ask an organization owner to add you.
      </p>
    </main>
  );
}
