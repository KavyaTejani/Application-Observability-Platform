import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProject, post, signUp, type TestUser } from '../../test/fixtures.js';
import { buildTestApp, unlimited } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import type { PromInstantSample, PrometheusQueryApi } from '../query/backend-clients.js';
import {
  AlertRuleModel,
  IncidentModel,
  NotificationDeliveryModel,
  NotificationJobModel,
} from './alert.models.js';
import type { WebhookResult, WebhookSender } from './webhook-client.js';

useTestDatabase();

/** Answers every instant query with the next scripted value ('nodata' = empty, Error = failure). */
class ScriptedPrometheus implements PrometheusQueryApi {
  script: Array<number | 'nodata' | Error> = [];
  exprs: string[] = [];
  async query(expr: string): Promise<PromInstantSample[]> {
    this.exprs.push(expr);
    const next = this.script.shift() ?? 'nodata';
    if (next instanceof Error) throw next;
    return next === 'nodata' ? [] : [{ metric: {}, value: [0, String(next)] }];
  }
  async queryRange() {
    return [];
  }
  async labelValues() {
    return [];
  }
}

class RecordingSender implements WebhookSender {
  sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  results: WebhookResult[] = [];
  async send(url: string, body: string, headers: Record<string, string>): Promise<WebhookResult> {
    this.sent.push({ url, body, headers });
    return this.results.shift() ?? { status: 'success', responseStatus: 200 };
  }
}

/** Public address for every hostname, so destinations pass the save-time SSRF check. */
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

describe('alert evaluation → incident → webhook', () => {
  let now = Date.now();
  const clock = () => new Date(now);
  const prometheus = new ScriptedPrometheus();
  const sender = new RecordingSender();
  const ctx = buildTestApp({
    limiter: unlimited,
    prometheusQuery: prometheus,
    webhookSender: sender,
    webhookResolve: publicDns,
    now: clock,
  });
  let owner: TestUser;
  let projectId: string;
  let destinationId: string;
  let signingSecret: string;

  beforeAll(async () => {
    owner = await signUp(ctx.app, 'alerts');
    projectId = await createProject(owner, 'Checkout');
    const res = await post(
      owner.agent,
      `/api/v1/organizations/${owner.organizationId}/notification-destinations`,
      {
        name: 'On-call',
        url: 'https://hooks.example.com/aop/secret-token',
      },
    );
    expect(res.status).toBe(201);
    destinationId = res.body.destination.id;
    signingSecret = res.body.signingSecret;
  });

  async function createRule(body: Record<string, unknown> = {}) {
    const res = await post(owner.agent, `/api/v1/projects/${projectId}/alert-rules`, {
      name: 'High error rate',
      metricKey: 'error_rate',
      operator: 'gt',
      threshold: 0.05,
      windowSeconds: 300,
      evaluationIntervalSeconds: 30,
      forEvaluations: 2,
      resolveAfterEvaluations: 2,
      notificationDestinationId: destinationId,
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body.rule.id as string;
  }

  /** Delivers anything left in the outbox by earlier tests, so each test sees only its own sends. */
  async function drainOutbox() {
    now += 3_600_000;
    while ((await ctx.notifier.runDue()) > 0) now += 3_600_000;
    sender.sent = [];
    sender.results = [];
  }

  /** Advances time past the evaluation interval and runs one evaluator + notifier pass. */
  async function tick() {
    now += 31_000;
    await ctx.alertEvaluator.runDue();
    await ctx.notifier.runDue();
  }

  it('fires after consecutive breaches, opens ONE incident, notifies once, and resolves (AC-06)', async () => {
    const ruleId = await createRule();
    sender.sent = [];
    prometheus.script = [0.2, 0.25, 0.3, 0.31, 0.3, 0.01, 0.02];
    const states: string[] = [];
    for (let i = 0; i < 7; i++) {
      await tick();
      states.push((await AlertRuleModel.findById(ruleId).lean())!.lastState);
    }
    expect(states).toEqual(['pending', 'firing', 'firing', 'firing', 'firing', 'firing', 'normal']);

    const incidents = await IncidentModel.find({ alertRuleId: ruleId }).lean();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ status: 'resolved', lastValue: 0.02 });
    expect(incidents[0]!.title).toContain('error rate');

    // Exactly one firing and one resolved notification despite five breaching evaluations.
    expect(sender.sent.map((s) => JSON.parse(s.body).event)).toEqual([
      'incident_firing',
      'incident_resolved',
    ]);
    const [firing] = sender.sent;
    expect(firing!.url).toBe('https://hooks.example.com/aop/secret-token');
    expect(firing!.headers['X-AOP-Event']).toBe('incident_firing');

    // The signature verifies with the secret shown at creation.
    const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(firing!.headers['X-AOP-Signature']!);
    expect(match).not.toBeNull();
    const expected = createHmac('sha256', signingSecret)
      .update(`${match![1]}.${firing!.body}`)
      .digest('hex');
    expect(match![2]).toBe(expected);
    expect(JSON.parse(firing!.body)).toMatchObject({
      incident: { id: incidents[0]!._id.toHexString(), status: 'firing' },
      rule: { metricKey: 'error_rate', threshold: 0.05 },
      project: { id: projectId, name: 'Checkout' },
    });

    const deliveries = await NotificationDeliveryModel.find({
      incidentId: incidents[0]!._id,
    }).lean();
    expect(deliveries.map((d) => [d.event, d.status])).toEqual([
      ['incident_firing', 'success'],
      ['incident_resolved', 'success'],
    ]);
    await AlertRuleModel.updateOne({ _id: ruleId }, { enabled: false });
  });

  it('scopes the alert query to the rule’s own tenant (ALERT-004)', async () => {
    const ruleId = await createRule();
    prometheus.exprs = [];
    prometheus.script = [0.01];
    await tick();
    expect(prometheus.exprs[0]).toContain(
      `organization_id="${owner.organizationId}",project_id="${projectId}"`,
    );
    expect(prometheus.exprs[0]).toContain('[300s]');
    await AlertRuleModel.updateOne({ _id: ruleId }, { enabled: false });
  });

  it('never opens an incident for windows with zero requests (ALERT-011)', async () => {
    const ruleId = await createRule({ forEvaluations: 1 });
    prometheus.script = ['nodata', 'nodata', 'nodata'];
    for (let i = 0; i < 3; i++) await tick();
    expect(await IncidentModel.countDocuments({ alertRuleId: ruleId })).toBe(0);
    expect((await AlertRuleModel.findById(ruleId).lean())!.lastState).toBe('normal');
    await AlertRuleModel.updateOne({ _id: ruleId }, { enabled: false });
  });

  it('a Prometheus outage sets state "error" and leaves the open incident untouched (ALERT-011)', async () => {
    const ruleId = await createRule({ forEvaluations: 1 });
    prometheus.script = [0.5];
    await tick();
    const incident = await IncidentModel.findOne({ alertRuleId: ruleId, status: 'firing' }).lean();
    expect(incident).not.toBeNull();

    prometheus.script = [
      new Error('connect ECONNREFUSED'),
      new Error('timeout'),
      new Error('timeout'),
    ];
    for (let i = 0; i < 3; i++) await tick();
    const rule = await AlertRuleModel.findById(ruleId).lean();
    expect(rule).toMatchObject({ lastState: 'error', lastValue: 0.5 });
    expect(rule!.lastError).toMatch(/ECONNREFUSED|timeout/);
    const still = await IncidentModel.find({ alertRuleId: ruleId }).lean();
    expect(still).toHaveLength(1);
    expect(still[0]!.status).toBe('firing');
    await AlertRuleModel.updateOne({ _id: ruleId }, { enabled: false });
  });

  it('two evaluators racing on the same breach still create exactly one incident (ALERT-006)', async () => {
    const ruleId = await createRule({ forEvaluations: 1 });
    const rule = (await AlertRuleModel.findById(ruleId).lean())!;
    const other = buildTestApp({
      limiter: unlimited,
      prometheusQuery: prometheus,
      webhookSender: sender,
      now: clock,
    });
    prometheus.script = [0.9, 0.9];
    await Promise.all([ctx.alertEvaluator.evaluate(rule), other.alertEvaluator.evaluate(rule)]);
    expect(await IncidentModel.countDocuments({ alertRuleId: ruleId, status: 'firing' })).toBe(1);
    expect(
      await NotificationJobModel.countDocuments({
        event: 'incident_firing',
        incidentId: {
          $in: (await IncidentModel.find({ alertRuleId: ruleId }).lean()).map((i) => i._id),
        },
      }),
    ).toBe(1);
    await AlertRuleModel.updateOne({ _id: ruleId }, { enabled: false });
  });

  it('a failed webhook is recorded and retried with backoff; the incident is unaffected (ALERT-008)', async () => {
    const ruleId = await createRule({ forEvaluations: 1 });
    await drainOutbox();
    sender.results = [
      {
        status: 'failed',
        responseStatus: 503,
        errorSummary: 'Receiver responded with HTTP 503',
        retryable: true,
      },
      { status: 'failed', errorSummary: 'Timed out', retryable: true },
    ];
    prometheus.script = [0.9];
    await tick(); // evaluation opens the incident; delivery attempt 1 fails
    const incident = (await IncidentModel.findOne({
      alertRuleId: ruleId,
      status: 'firing',
    }).lean())!;
    let job = (await NotificationJobModel.findOne({ incidentId: incident._id }).lean())!;
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job.nextAttemptAt.getTime() - now).toBeGreaterThanOrEqual(29_000);

    now += 10_000;
    await ctx.notifier.runDue(); // not due yet: no attempt
    expect(sender.sent).toHaveLength(1);

    now += 25_000;
    await ctx.notifier.runDue(); // attempt 2 fails (timeout)
    now += 125_000;
    await ctx.notifier.runDue(); // attempt 3 succeeds
    job = (await NotificationJobModel.findById(job._id).lean())!;
    expect(job).toMatchObject({ status: 'delivered', attempts: 3 });

    const attempts = await NotificationDeliveryModel.find({ incidentId: incident._id })
      .sort({ attempt: 1 })
      .lean();
    expect(attempts.map((a) => [a.attempt, a.status, a.responseStatus ?? null])).toEqual([
      [1, 'failed', 503],
      [2, 'failed', null],
      [3, 'success', 200],
    ]);
    expect((await IncidentModel.findById(incident._id).lean())!.status).toBe('firing');
    await AlertRuleModel.updateOne({ _id: ruleId }, { enabled: false });
  });

  it('does not retry permanent failures', async () => {
    const ruleId = await createRule({ forEvaluations: 1 });
    await drainOutbox();
    sender.results = [
      {
        status: 'failed',
        responseStatus: 404,
        errorSummary: 'Receiver responded with HTTP 404',
        retryable: false,
      },
    ];
    prometheus.script = [0.9];
    await tick();
    const incident = (await IncidentModel.findOne({ alertRuleId: ruleId }).lean())!;
    expect((await NotificationJobModel.findOne({ incidentId: incident._id }).lean())!.status).toBe(
      'failed',
    );
    await AlertRuleModel.updateOne({ _id: ruleId }, { enabled: false });
  });

  it('exposes rule state, incidents, and deliveries through the API', async () => {
    const list = await owner.agent.get(`/api/v1/projects/${projectId}/incidents`);
    expect(list.status).toBe(200);
    expect(list.body.incidents.length).toBeGreaterThan(0);
    const id = list.body.incidents[0].id;

    const detail = await owner.agent.get(`/api/v1/incidents/${id}`);
    expect(detail.body.incident).toMatchObject({ id, project: { id: projectId } });
    const deliveries = await owner.agent.get(`/api/v1/incidents/${id}/deliveries`);
    expect(deliveries.status).toBe(200);
    expect(Array.isArray(deliveries.body.deliveries)).toBe(true);

    const rules = await owner.agent.get(`/api/v1/projects/${projectId}/alert-rules`);
    expect(rules.body.rules[0]).toHaveProperty('lastState');
  });

  it('closes the open incident when its rule is disabled', async () => {
    const ruleId = await createRule({ forEvaluations: 1 });
    prometheus.script = [0.9];
    await tick();
    expect(await IncidentModel.countDocuments({ alertRuleId: ruleId, status: 'firing' })).toBe(1);
    const res = await owner.agent
      .patch(`/api/v1/alert-rules/${ruleId}`)
      .set('Origin', 'http://localhost:5173')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(await IncidentModel.countDocuments({ alertRuleId: ruleId, status: 'firing' })).toBe(0);
  });
});
