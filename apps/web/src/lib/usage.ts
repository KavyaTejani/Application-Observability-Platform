import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Meter {
  used: number;
  limit: number;
}

export interface ProjectUsage {
  id: string;
  name: string;
  environment: string;
  deleted: boolean;
  acceptedRecords: number;
  acceptedBytes: number;
  rejectedRecords: number;
  quotaRejectedRecords: number;
}

export interface Usage {
  dayUtc: string;
  resetsAt: string;
  plan: { code: string; name: string };
  quota: { records: Meter; bytes: Meter };
  rejected: { records: number; quotaRecords: number };
  resources: { projects: Meter; alertRules: Meter };
  retention: { metricsDays: number; logsDays: number };
  projects: ProjectUsage[];
  history: Array<{ dayUtc: string; records: number; bytes: number }>;
}

export const useUsage = (organizationId: string) =>
  useQuery({
    queryKey: ['usage', organizationId],
    queryFn: ({ signal }) =>
      api<{ usage: Usage }>(`/organizations/${organizationId}/usage`, { signal }),
    refetchInterval: 30_000,
  });
