/** Response shapes of the product API (kept in sync with apps/api route handlers). */

export type Role = 'owner' | 'member';

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface OrganizationDetail extends OrganizationSummary {
  retention: { metricsDays: number; logsDays: number; tracesDays: number };
  createdAt: string;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface Me {
  user: User;
  organizations: OrganizationSummary[];
}

type DependencyName = 'mongodb' | 'redis' | 'prometheus' | 'loki';

export type DependencyStatus =
  { status: 'up' | 'down'; latencyMs: number } | { status: 'not_configured' };

export interface ReadinessReport {
  status: 'ready' | 'degraded' | 'not_ready';
  checkedAt: string;
  dependencies: Record<DependencyName, DependencyStatus>;
}
