import {
  Activity,
  Bell,
  BellRing,
  ChevronsUpDown,
  FolderKanban,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  ScrollText,
  Settings,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { ICON_STROKE, RoleBadge, sectionLabel } from '../components/ui';
import { useLogout, useMe } from '../lib/auth';
import { lastProject, useProjects } from '../lib/projects';
import { useTheme, type ThemePreference } from '../lib/theme';
import type { OrganizationSummary } from '../lib/types';

/**
 * Signed-in shell: sidebar navigation (PRD §13.1), organization and project switchers, theme
 * toggle, and account menu. Links appear only for features the user can reach; the API still
 * re-authorizes every request.
 */
export function AppLayout() {
  const me = useMe();
  const { organizationId } = useParams();
  const location = useLocation();
  // The mobile drawer is open for one route only: navigating anywhere closes it, no effect needed.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const menuOpen = openAt === location.pathname;
  const setMenuOpen = (open: boolean) => setOpenAt(open ? location.pathname : null);

  const organizations = me.data?.organizations ?? [];
  const current = organizations.find((org) => org.id === organizationId);

  if (!current) {
    // Unknown or foreign organization in the URL: fall back to the user's first organization.
    // The API enforces the boundary regardless; this only keeps the UI in a valid state.
    const first = organizations[0];
    return first ? <Navigate to={`/orgs/${first.id}`} replace /> : <NoOrganization />;
  }

  return (
    <div className="min-h-screen lg:pl-64">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:bw focus:border-ink"
      >
        Skip to content
      </a>

      {menuOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-30 bg-overlay lg:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bw-r border-line bg-canvas transition-transform select-none lg:translate-x-0 ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar org={current} organizations={organizations} onClose={() => setMenuOpen(false)} />
      </aside>

      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 bw-b border-line bg-surface px-4 select-none sm:px-6">
        <button
          type="button"
          className="-ml-1 rounded-lg p-1.5 text-fg-secondary hover:bg-subtle lg:hidden"
          aria-label="Open menu"
          onClick={() => setMenuOpen(true)}
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1 truncate text-sm text-fg-muted">
          <span className="font-display font-bold text-fg">{current.name}</span>
        </div>
        <ThemeToggle />
        <AccountMenu email={me.data?.user.email ?? ''} name={me.data?.user.name ?? ''} />
      </header>

      <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <Outlet context={current} />
      </main>
    </div>
  );
}

function Sidebar({
  org,
  organizations,
  onClose,
}: {
  org: OrganizationSummary;
  organizations: OrganizationSummary[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { projectId: projectInUrl } = useParams();
  const projects = useProjects(org.id);
  const list = projects.data?.projects ?? [];
  const remembered = lastProject(org.id);
  const activeProject =
    list.find((p) => p.id === projectInUrl) ??
    list.find((p) => p.id === remembered) ??
    list[0] ??
    null;
  const projectBase = activeProject ? `/orgs/${org.id}/projects/${activeProject.id}` : null;
  const base = `/orgs/${org.id}`;

  return (
    <>
      <div className="flex h-14 items-center justify-between bw-b border-line px-4">
        <NavLink to={base} className="flex items-center gap-2 font-display font-bold text-fg">
          <span className="flex size-7 items-center justify-center rounded-lg bw border-ink bg-pink text-[#111111] shadow-chip">
            <Activity className="size-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
          </span>
          AOP
          <span className="text-xs font-normal text-fg-muted">Observability</span>
        </NavLink>
        <button
          type="button"
          className="rounded-lg p-1.5 text-fg-secondary hover:bg-subtle lg:hidden"
          aria-label="Close menu"
          onClick={onClose}
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        <Switcher
          label="Organization"
          value={org.id}
          onChange={(id) => navigate(`/orgs/${id}`)}
          options={organizations.map((o) => ({ value: o.id, label: o.name }))}
          trailing={<RoleBadge role={org.role} />}
        />

        <NavSection>
          <NavItem to={base} end icon={LayoutDashboard} label="Overview" />
          <NavItem to={`${base}/projects`} end icon={FolderKanban} label="Projects" />
        </NavSection>

        <NavSection title="Project">
          {list.length > 0 && activeProject ? (
            <>
              <Switcher
                label="Project"
                value={activeProject.id}
                onChange={(id) => navigate(`${base}/projects/${id}`)}
                options={list.map((p) => ({ value: p.id, label: `${p.name} · ${p.environment}` }))}
              />
              <NavItem to={projectBase ?? base} end icon={Gauge} label="Metrics" />
              <NavItem to={`${projectBase}/logs`} icon={ScrollText} label="Logs" />
              <NavItem to={`${projectBase}/alerts`} icon={BellRing} label="Alerts" />
              <NavItem to={`${projectBase}/settings`} icon={KeyRound} label="Keys & setup" />
            </>
          ) : (
            <p className="px-2 text-xs text-fg-muted">
              {projects.isPending
                ? 'Loading projects…'
                : 'Create a project to see metrics, logs, and alerts.'}
            </p>
          )}
        </NavSection>

        <NavSection title="Organization">
          <NavItem to={`${base}/usage`} icon={Activity} label="Usage" />
          <NavItem to={`${base}/notifications`} icon={Bell} label="Notifications" />
          <NavItem to={`${base}/settings`} icon={Settings} label="Settings" />
        </NavSection>
      </div>

      <div className="bw-t border-line p-3">
        <NavItem to="/status" icon={Monitor} label="System status" />
      </div>
    </>
  );
}

function NavSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      {title && <p className={`mb-1.5 px-2 ${sectionLabel}`}>{title}</p>}
      {children}
    </div>
  );
}

function NavItem({
  to,
  end,
  icon: Icon,
  label,
}: {
  to: string;
  end?: boolean;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-lg bw px-2 py-1.5 font-display text-sm font-semibold transition-colors ${
          isActive
            ? 'border-ink bg-accent text-accent-fg shadow-chip'
            : 'border-transparent text-fg-secondary hover:border-ink hover:bg-surface hover:text-fg'
        }`
      }
    >
      <Icon className="size-4 shrink-0" strokeWidth={ICON_STROKE} aria-hidden="true" />
      {label}
    </NavLink>
  );
}

function Switcher({
  label,
  value,
  options,
  onChange,
  trailing,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  trailing?: ReactNode;
}) {
  return (
    <div>
      <label className="sr-only" htmlFor={`switch-${label}`}>
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-lg bw border-line bg-surface px-2 py-1.5 shadow-chip">
        <div className="relative min-w-0 flex-1">
          <select
            id={`switch-${label}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="w-full cursor-pointer appearance-none truncate bg-transparent pr-5 font-display text-sm font-semibold text-fg focus:outline-none"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <ChevronsUpDown
            className="pointer-events-none absolute top-1/2 right-0 size-3.5 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
        </div>
        {trailing}
      </div>
    </div>
  );
}

const THEMES: Array<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
];

function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex gap-0.5 rounded-lg bw border-line bg-surface p-0.5"
    >
      {THEMES.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={preference === value}
          aria-label={`${label} theme`}
          title={`${label} theme`}
          onClick={() => setPreference(value)}
          className={`rounded-lg p-1.5 transition-colors ${
            preference === value ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:text-fg'
          }`}
        >
          <Icon className="size-3.5" strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function AccountMenu({ email, name }: { email: string; name: string }) {
  const logout = useLogout();
  const navigate = useNavigate();
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?';
  const onLogout = () =>
    logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });

  return (
    <div className="flex items-center gap-2">
      <span
        className="flex size-8 items-center justify-center rounded-full bw border-ink bg-accent-soft font-display text-xs font-bold text-accent-text"
        aria-hidden="true"
      >
        {initials}
      </span>
      <span className="hidden max-w-48 truncate text-sm text-fg-secondary md:inline">{email}</span>
      <button
        type="button"
        onClick={onLogout}
        disabled={logout.isPending}
        className="rounded-lg p-1.5 text-fg-muted hover:bg-subtle hover:text-fg"
        aria-label="Sign out"
        title="Sign out"
      >
        <LogOut className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function NoOrganization() {
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center text-fg-secondary">
      <h1 className="text-lg font-semibold text-fg">No organization</h1>
      <p className="mt-2 text-sm">
        Your account is not a member of any organization. Ask an organization owner to add you.
      </p>
    </main>
  );
}
