import { HTTP_METHODS } from '@aop/validation';

const KNOWN_METHODS = new Set<string>(HTTP_METHODS);

const ID_SEGMENTS: Array<[RegExp, string]> = [
  [/^\d+$/, ':id'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ':uuid'],
  [/^[0-9a-f]{24}$/i, ':id'], // MongoDB ObjectId
  [/^[0-9a-f]{32,}$/i, ':hash'],
];

/**
 * Defence in depth for metric cardinality: SDKs send route *templates*, but a misconfigured
 * client might send raw paths (`/users/8812`). Segments that look like identifiers are replaced,
 * so each user ID does not become its own Prometheus series. Templates (`/users/:id`) pass through.
 */
export function normalizeRoute(route: string): string {
  return route
    .split('/')
    .map((segment) => {
      if (segment === '' || segment.startsWith(':')) return segment;
      for (const [pattern, replacement] of ID_SEGMENTS) {
        if (pattern.test(segment)) return replacement;
      }
      return segment;
    })
    .join('/');
}

export const methodLabel = (method: string): string =>
  KNOWN_METHODS.has(method) ? method : 'OTHER';

export const statusClassLabel = (statusCode: number): string => `${Math.floor(statusCode / 100)}xx`;
