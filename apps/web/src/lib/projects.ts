import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Project } from './types';

export const projectsKey = (organizationId: string) => [
  'organizations',
  organizationId,
  'projects',
];

export const useProjects = (organizationId: string) =>
  useQuery({
    queryKey: projectsKey(organizationId),
    queryFn: ({ signal }) =>
      api<{ projects: Project[] }>(`/organizations/${organizationId}/projects`, { signal }),
    staleTime: 30_000,
  });

/*
 * The project the sidebar's Metrics / Logs / Alerts links open when no project is in the URL:
 * the one used most recently in this organization (a per-browser convenience only).
 */
const lastProjectKey = (organizationId: string) => `aop-last-project:${organizationId}`;

export function rememberProject(organizationId: string, projectId: string): void {
  try {
    localStorage.setItem(lastProjectKey(organizationId), projectId);
  } catch {
    // Not persisted; the sidebar falls back to the first project.
  }
}

export function lastProject(organizationId: string): string | null {
  try {
    return localStorage.getItem(lastProjectKey(organizationId));
  } catch {
    return null;
  }
}
