import {
  INTERVAL_SECONDS,
  TIME_RANGE_SECONDS,
  type GroupByDimension,
  type MetricKey,
  type MetricQuery,
  type TimeRange,
} from '@aop/validation';

/**
 * Server-side PromQL generation (PRD §2.3, MET-003, MET-004). This is the only place PromQL is
 * produced, and every expression is built from:
 *   - a fixed template per allow-listed metric key,
 *   - validated, escaped label values,
 *   - the tenant matchers from the authorized scope, always first.
 * No client text is ever used as an expression.
 */

export interface MetricScope {
  organizationId: string;
  projectId: string;
}

export interface MetricFilters {
  serviceName?: string;
  route?: string;
  method?: string;
  statusClass?: string;
}

const REQUESTS = 'app_http_requests_total';
const BUCKETS = 'app_http_request_duration_seconds_bucket';

/** PromQL string-literal escaping. Inputs are already allow-list validated; this is depth. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Label matchers with the tenant scope first. The scope can never be omitted or overridden. */
export function labelMatchers(
  scope: MetricScope,
  filters: MetricFilters = {},
  extra: Record<string, string> = {},
): string {
  const pairs: Array<[string, string | undefined]> = [
    ['organization_id', scope.organizationId],
    ['project_id', scope.projectId],
    ['service', filters.serviceName],
    ['route', filters.route],
    ['method', filters.method],
    ['status_class', filters.statusClass],
    ...Object.entries(extra),
  ];
  return `{${pairs
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(',')}}`;
}

/** Default step per range: roughly 60–120 points, never below the 15 s scrape interval. */
const DEFAULT_STEP_SECONDS: Record<TimeRange, number> = {
  '15m': 15,
  '1h': 30,
  '6h': 180,
  '24h': 720,
};

export function stepSeconds(query: Pick<MetricQuery, 'range' | 'interval'>): number {
  return query.interval ? INTERVAL_SECONDS[query.interval] : DEFAULT_STEP_SECONDS[query.range];
}

/**
 * Window for `rate()`: at least 4 × the 15 s scrape interval, so every evaluation sees several
 * samples, and at least one step, so no request falls between points.
 */
export const rateWindow = (step: number): string => `${Math.max(60, step)}s`;

const byClause = (dims: readonly string[]) => (dims.length > 0 ? ` by (${dims.join(', ')})` : '');

const QUANTILES: Partial<Record<MetricKey, number>> = {
  p50_latency: 0.5,
  p95_latency: 0.95,
  p99_latency: 0.99,
};

/** Range-query expression for one allow-listed metric key. */
export function buildRangeExpression(
  metricKey: MetricKey,
  scope: MetricScope,
  filters: MetricFilters,
  groupBy: readonly GroupByDimension[],
  step: number,
): string {
  const window = rateWindow(step);
  const by = byClause(groupBy);
  const rate = (extra: Record<string, string> = {}) =>
    `sum${by} (rate(${REQUESTS}${labelMatchers(scope, filters, extra)}[${window}]))`;

  switch (metricKey) {
    case 'request_rate':
      return rate();
    case 'error_rate':
    case 'client_error_rate': {
      const statusClass = metricKey === 'error_rate' ? '5xx' : '4xx';
      const total = rate();
      // `or (total * 0)` turns "no error series" into an explicit 0 whenever requests exist.
      // With zero requests the division is 0/0 = NaN, which is reported as "no data", not 0.
      return `(${rate({ status_class: statusClass })} or (${total} * 0)) / ${total}`;
    }
    case 'p50_latency':
    case 'p95_latency':
    case 'p99_latency': {
      const quantile = QUANTILES[metricKey];
      const dims = ['le', ...groupBy].join(', ');
      return `histogram_quantile(${quantile}, sum by (${dims}) (rate(${BUCKETS}${labelMatchers(scope, filters)}[${window}])))`;
    }
  }
}

/** Instant expressions summarizing a whole window (overview tiles). */
export function buildSummaryExpressions(
  scope: MetricScope,
  range: TimeRange,
  serviceName?: string,
) {
  const window = `${TIME_RANGE_SECONDS[range]}s`;
  const filters = { serviceName };
  const increase = (extra: Record<string, string> = {}) =>
    `sum(increase(${REQUESTS}${labelMatchers(scope, filters, extra)}[${window}]))`;
  const quantile = (q: number) =>
    `histogram_quantile(${q}, sum by (le) (increase(${BUCKETS}${labelMatchers(scope, filters)}[${window}])))`;
  return {
    requests: increase(),
    serverErrors: increase({ status_class: '5xx' }),
    clientErrors: increase({ status_class: '4xx' }),
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
  };
}
