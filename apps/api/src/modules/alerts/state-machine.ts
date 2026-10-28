import type { RuleState } from './alert.models.js';

/**
 * Alert evaluation semantics (PRD ALERT-005, ALERT-006, ALERT-011). A pure function: given the
 * rule's counters, whether an incident is open, and one evaluation outcome, it returns the next
 * state and the incident action. It does no I/O, so every rule here is unit-tested.
 *
 * - breach  → consecutive breach count +1. Below `forEvaluations` the rule is `pending`; at or
 *             above it, `firing` (open an incident if none is open, otherwise refresh it).
 * - ok      → consecutive OK count +1. A firing rule resolves only after `resolveAfterEvaluations`
 *             consecutive OKs (anti-flapping).
 * - noData  → zero requests in the window. Treated as non-breaching: it never opens an incident,
 *             and it counts towards resolution.
 * - error   → the backend query failed. State becomes `error`; counters and incidents are left
 *             untouched, because we know nothing new.
 */
export type EvaluationOutcome =
  | { kind: 'breach'; value: number }
  | { kind: 'ok'; value: number }
  | { kind: 'noData' }
  | { kind: 'error'; message: string };

export interface RuleCounters {
  consecutiveBreaches: number;
  consecutiveOk: number;
}

export interface Thresholds {
  forEvaluations: number;
  resolveAfterEvaluations: number;
}

export type IncidentAction = 'open' | 'update' | 'resolve' | 'none';

export interface Transition extends RuleCounters {
  state: RuleState;
  incident: IncidentAction;
}

export function transition(
  counters: RuleCounters,
  hasOpenIncident: boolean,
  outcome: EvaluationOutcome,
  thresholds: Thresholds,
): Transition {
  switch (outcome.kind) {
    case 'error':
      return {
        ...counters,
        state: 'error',
        incident: 'none',
      };

    case 'breach': {
      const consecutiveBreaches = counters.consecutiveBreaches + 1;
      const firing = hasOpenIncident || consecutiveBreaches >= thresholds.forEvaluations;
      return {
        consecutiveBreaches,
        consecutiveOk: 0,
        state: firing ? 'firing' : 'pending',
        incident: firing ? (hasOpenIncident ? 'update' : 'open') : 'none',
      };
    }

    case 'ok':
    case 'noData': {
      const consecutiveOk = counters.consecutiveOk + 1;
      if (hasOpenIncident) {
        const resolve = consecutiveOk >= thresholds.resolveAfterEvaluations;
        return {
          consecutiveBreaches: 0,
          consecutiveOk,
          state: resolve ? 'normal' : 'firing',
          incident: resolve ? 'resolve' : 'none',
        };
      }
      return { consecutiveBreaches: 0, consecutiveOk, state: 'normal', incident: 'none' };
    }
  }
}

/** Compares an observed value with the threshold. MVP operators have "above" semantics. */
export function isBreach(
  operator: 'gt' | 'gte' | 'lt' | 'lte',
  value: number,
  threshold: number,
): boolean {
  switch (operator) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
  }
}
