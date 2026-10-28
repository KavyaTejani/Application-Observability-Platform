import { describe, expect, it } from 'vitest';
import { isBreach, transition, type EvaluationOutcome, type Transition } from './state-machine.js';

const T = { forEvaluations: 2, resolveAfterEvaluations: 2 };
const breach: EvaluationOutcome = { kind: 'breach', value: 0.3 };
const ok: EvaluationOutcome = { kind: 'ok', value: 0.01 };
const noData: EvaluationOutcome = { kind: 'noData' };
const error: EvaluationOutcome = { kind: 'error', message: 'timeout' };

/** Runs a sequence of outcomes from a fresh rule, tracking whether an incident is open. */
function run(outcomes: EvaluationOutcome[], thresholds = T) {
  let counters = { consecutiveBreaches: 0, consecutiveOk: 0 };
  let open = false;
  const steps: Transition[] = [];
  for (const outcome of outcomes) {
    const next = transition(counters, open, outcome, thresholds);
    if (next.incident === 'open') open = true;
    if (next.incident === 'resolve') open = false;
    counters = { consecutiveBreaches: next.consecutiveBreaches, consecutiveOk: next.consecutiveOk };
    steps.push(next);
  }
  return steps;
}

const states = (steps: Transition[]) => steps.map((s) => s.state);
const actions = (steps: Transition[]) => steps.map((s) => s.incident);

describe('alert state machine', () => {
  it('goes normal → pending → firing after forEvaluations consecutive breaches', () => {
    const steps = run([ok, breach, breach, breach]);
    expect(states(steps)).toEqual(['normal', 'pending', 'firing', 'firing']);
    expect(actions(steps)).toEqual(['none', 'none', 'open', 'update']);
  });

  it('opens exactly one incident for one continuous breach (ALERT-006)', () => {
    const steps = run(Array.from({ length: 20 }, () => breach));
    expect(actions(steps).filter((a) => a === 'open')).toHaveLength(1);
  });

  it('fires immediately when forEvaluations is 1', () => {
    expect(actions(run([breach], { ...T, forEvaluations: 1 }))).toEqual(['open']);
  });

  it('an interrupted breach resets the count (a single blip never fires)', () => {
    const steps = run([breach, ok, breach, ok, breach]);
    expect(states(steps)).toEqual(['pending', 'normal', 'pending', 'normal', 'pending']);
    expect(actions(steps)).not.toContain('open');
  });

  it('resolves only after resolveAfterEvaluations consecutive non-breaching checks', () => {
    const steps = run([breach, breach, ok, ok]);
    expect(states(steps)).toEqual(['pending', 'firing', 'firing', 'normal']);
    expect(actions(steps)).toEqual(['none', 'open', 'none', 'resolve']);
  });

  it('does not flap: a recovery interrupted by a breach keeps the same incident open', () => {
    const steps = run([breach, breach, ok, breach, ok, ok]);
    expect(actions(steps)).toEqual(['none', 'open', 'none', 'update', 'none', 'resolve']);
  });

  it('treats no data (zero requests) as non-breaching: it never opens an incident', () => {
    const steps = run(Array.from({ length: 10 }, () => noData));
    expect(states(steps).every((s) => s === 'normal')).toBe(true);
    expect(actions(steps).every((a) => a === 'none')).toBe(true);
  });

  it('lets no data count towards resolution', () => {
    expect(actions(run([breach, breach, noData, noData]))).toEqual([
      'none',
      'open',
      'none',
      'resolve',
    ]);
  });

  it('on a backend error, sets state "error" and changes neither counters nor incidents (ALERT-011)', () => {
    const counters = { consecutiveBreaches: 1, consecutiveOk: 0 };
    const whileFiring = transition(counters, true, error, T);
    expect(whileFiring).toEqual({ ...counters, state: 'error', incident: 'none' });

    // An outage during an incident neither resolves nor duplicates it.
    const steps = run([breach, breach, error, error, error, breach, ok, ok]);
    expect(actions(steps)).toEqual([
      'none',
      'open',
      'none',
      'none',
      'none',
      'update',
      'none',
      'resolve',
    ]);
  });

  it('an error does not count as a breach towards firing', () => {
    const steps = run([breach, error, ok, breach]);
    expect(actions(steps)).not.toContain('open');
  });

  it('a new breach after resolution opens a new incident', () => {
    const steps = run([breach, breach, ok, ok, breach, breach]);
    expect(actions(steps).filter((a) => a === 'open')).toHaveLength(2);
  });
});

describe('isBreach', () => {
  it('applies the operator', () => {
    expect(isBreach('gt', 0.05, 0.05)).toBe(false);
    expect(isBreach('gte', 0.05, 0.05)).toBe(true);
    expect(isBreach('gt', 250, 200)).toBe(true);
    expect(isBreach('lt', 1, 2)).toBe(true);
  });
});
