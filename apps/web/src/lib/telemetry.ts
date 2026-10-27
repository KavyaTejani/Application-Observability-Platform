import type {
  LogQueryInput,
  MetricKey,
  MetricQueryInput,
  Severity,
  TimeRange,
} from '@aop/validation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface MetricSeries {
  labels: Record<string, string>;
  points: Array<[number, number | null]>;
}

export interface MetricQueryResult {
  metricKey: MetricKey;
  unit: 'requests_per_second' | 'ratio' | 'milliseconds';
  range: TimeRange;
  stepSeconds: number;
  start: string;
  end: string;
  series: MetricSeries[];
  noData: boolean;
}

export interface MetricSummary {
  range: TimeRange;
  requests: number | null;
  requestRate: number | null;
  serverErrorRate: number | null;
  clientErrorRate: number | null;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null };
  lastTelemetryAt: string | null;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  severity: Severity;
  service: string;
  environment: string;
  message: string;
  requestId: string | null;
  attributes: Record<string, unknown>;
}

interface LogPage {
  entries: LogEntry[];
  nextCursor: string | null;
  from: string;
  to: string;
}

const REFRESH_MS = 30_000;

export function useMetricSummary(projectId: string, range: TimeRange, serviceName?: string) {
  return useQuery({
    queryKey: ['telemetry', projectId, 'summary', range, serviceName ?? ''],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ range });
      if (serviceName) params.set('serviceName', serviceName);
      return api<{ summary: MetricSummary }>(`/projects/${projectId}/metrics/summary?${params}`, {
        signal,
      });
    },
    refetchInterval: REFRESH_MS,
  });
}

export function useMetricQuery(projectId: string, query: MetricQueryInput) {
  return useQuery({
    queryKey: ['telemetry', projectId, 'query', query],
    queryFn: ({ signal }) =>
      api<MetricQueryResult>(`/projects/${projectId}/metrics/query`, {
        method: 'POST',
        body: query,
        signal,
      }),
    refetchInterval: REFRESH_MS,
    // Keep the previous chart visible while a new range loads.
    placeholderData: (previous) => previous,
  });
}

export function useServices(projectId: string) {
  return useQuery({
    queryKey: ['telemetry', projectId, 'services'],
    queryFn: ({ signal }) =>
      api<{ services: string[] }>(`/projects/${projectId}/services`, { signal }),
    staleTime: 60_000,
  });
}

/** Log search with cursor pagination ("load older"). Filters are part of the cache key. */
export function useLogs(projectId: string, filters: Omit<LogQueryInput, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: ['telemetry', projectId, 'logs', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value === undefined || value === '') continue;
        params.set(key, Array.isArray(value) ? value.join(',') : String(value));
      }
      if (pageParam) params.set('cursor', pageParam);
      return api<LogPage>(`/projects/${projectId}/logs?${params}`, { signal });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
