import type { CreateAlertRuleInput, UpdateAlertRuleInput } from '@aop/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type RuleState = 'normal' | 'pending' | 'firing' | 'error';

export interface AlertRule {
  id: string;
  projectId: string;
  name: string;
  metricKey: 'error_rate' | 'p95_latency';
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  threshold: number;
  windowSeconds: number;
  evaluationIntervalSeconds: number;
  forEvaluations: number;
  resolveAfterEvaluations: number;
  serviceName: string | null;
  notificationDestinationId: string | null;
  enabled: boolean;
  createdBy: string;
  lastState: RuleState;
  lastEvaluatedAt: string | null;
  lastValue: number | null;
  lastError: string | null;
  createdAt: string;
}

export interface Incident {
  id: string;
  projectId: string;
  alertRuleId: string;
  status: 'firing' | 'resolved';
  title: string;
  startedAt: string;
  resolvedAt: string | null;
  lastTriggeredAt: string;
  lastValue: number | null;
  ruleSnapshot: {
    metricKey: AlertRule['metricKey'];
    operator: string;
    threshold: number;
    windowSeconds: number;
  };
}

export interface IncidentDetail extends Incident {
  organizationId: string;
  rule: AlertRule | null;
  project: { id: string; name: string; environment: string } | null;
}

export interface Delivery {
  id: string;
  destinationId: string;
  event: 'incident_firing' | 'incident_resolved';
  attempt: number;
  status: 'success' | 'failed' | 'blocked';
  responseStatus: number | null;
  startedAt: string;
  finishedAt: string;
  errorSummary: string | null;
}

export interface Destination {
  id: string;
  name: string;
  type: 'webhook';
  urlPreview: string;
  projectId: string | null;
  enabled: boolean;
  createdAt: string;
}

const rulesKey = (projectId: string) => ['alerts', projectId, 'rules'];
const incidentsKey = (projectId: string) => ['alerts', projectId, 'incidents'];
export const destinationsKey = (organizationId: string) => ['destinations', organizationId];

/** Alert state changes in the background, so these views poll. */
const LIVE_MS = 10_000;

export const useRules = (projectId: string) =>
  useQuery({
    queryKey: rulesKey(projectId),
    queryFn: ({ signal }) =>
      api<{ rules: AlertRule[] }>(`/projects/${projectId}/alert-rules`, { signal }),
    refetchInterval: LIVE_MS,
  });

export const useIncidents = (projectId: string) =>
  useQuery({
    queryKey: incidentsKey(projectId),
    queryFn: ({ signal }) =>
      api<{ incidents: Incident[] }>(`/projects/${projectId}/incidents`, { signal }),
    refetchInterval: LIVE_MS,
  });

export const useIncident = (incidentId: string) =>
  useQuery({
    queryKey: ['incident', incidentId],
    queryFn: ({ signal }) =>
      api<{ incident: IncidentDetail }>(`/incidents/${incidentId}`, { signal }),
    refetchInterval: LIVE_MS,
  });

export const useDeliveries = (incidentId: string) =>
  useQuery({
    queryKey: ['incident', incidentId, 'deliveries'],
    queryFn: ({ signal }) =>
      api<{ deliveries: Delivery[] }>(`/incidents/${incidentId}/deliveries`, { signal }),
    refetchInterval: LIVE_MS,
  });

export const useDestinations = (organizationId: string) =>
  useQuery({
    queryKey: destinationsKey(organizationId),
    queryFn: ({ signal }) =>
      api<{ destinations: Destination[] }>(
        `/organizations/${organizationId}/notification-destinations`,
        { signal },
      ),
  });

export function useCreateRule(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAlertRuleInput) =>
      api<{ rule: AlertRule }>(`/projects/${projectId}/alert-rules`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rulesKey(projectId) }),
  });
}

export function useUpdateRule(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAlertRuleInput }) =>
      api<{ rule: AlertRule }>(`/alert-rules/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rulesKey(projectId) });
      void qc.invalidateQueries({ queryKey: incidentsKey(projectId) });
    },
  });
}

export function useDeleteRule(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/alert-rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rulesKey(projectId) });
      void qc.invalidateQueries({ queryKey: incidentsKey(projectId) });
    },
  });
}

export const formatRuleValue = (metricKey: AlertRule['metricKey'], value: number | null) =>
  value === null
    ? 'no data'
    : metricKey === 'error_rate'
      ? `${(value * 100).toFixed(2)}%`
      : `${Math.round(value)} ms`;

export const OPERATOR_TEXT: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' };
