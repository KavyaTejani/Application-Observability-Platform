import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProject,
  del,
  patch,
  post,
  signUp,
  type TestUser,
} from '../../test/fixtures.js';
import { buildTestApp, unlimited } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import { IncidentModel, NotificationDestinationModel } from './alert.models.js';

useTestDatabase();

const publicDns = async (hostname: string) =>
  hostname === 'internal.example.test'
    ? [{ address: '10.0.0.8', family: 4 }]
    : [{ address: '93.184.216.34', family: 4 }];

/**
 * Alert API: validation, RBAC, and tenant isolation for rules, incidents, and destinations
 * (PRD §14.2 item 1, ORG-003, ALERT-001 to ALERT-003).
 */
describe('alert API', () => {
  const { app } = buildTestApp({ limiter: unlimited, webhookResolve: publicDns });
  let a: TestUser;
  let b: TestUser;
  let member: TestUser;
  let projectA: string;
  let projectB: string;
  let destinationA: string;
  let destinationB: string;
  let ruleB: string;
  let incidentB: string;

  const rule = (overrides: Record<string, unknown> = {}) => ({
    name: 'Slow checkout',
    metricKey: 'p95_latency',
    operator: 'gt',
    threshold: 500,
    ...overrides,
  });

  beforeAll(async () => {
    a = await signUp(app, 'alice');
    b = await signUp(app, 'bob');
    member = await addMember(app, a.organizationId, 'member');
    projectA = await createProject(a, 'Alpha');
    projectB = await createProject(b, 'Bravo');
    destinationA = (
      await post(a.agent, `/api/v1/organizations/${a.organizationId}/notification-destinations`, {
        name: 'A hook',
        url: 'https://hooks.example.com/a',
      })
    ).body.destination.id;
    destinationB = (
      await post(b.agent, `/api/v1/organizations/${b.organizationId}/notification-destinations`, {
        name: 'B hook',
        url: 'https://hooks.example.com/b',
      })
    ).body.destination.id;
    ruleB = (await post(b.agent, `/api/v1/projects/${projectB}/alert-rules`, rule())).body.rule.id;
    incidentB = (
      await IncidentModel.create({
        organizationId: b.organizationId,
        projectId: projectB,
        alertRuleId: ruleB,
        fingerprint: `rule:${ruleB}`,
        status: 'firing',
        title: 'B incident',
        startedAt: new Date(),
        lastTriggeredAt: new Date(),
        ruleSnapshot: {
          metricKey: 'p95_latency',
          operator: 'gt',
          threshold: 500,
          windowSeconds: 300,
        },
      })
    )._id.toHexString();
  });

  describe('validation', () => {
    it('applies defaults and accepts a valid rule', async () => {
      const res = await post(a.agent, `/api/v1/projects/${projectA}/alert-rules`, rule());
      expect(res.status).toBe(201);
      expect(res.body.rule).toMatchObject({
        windowSeconds: 300,
        evaluationIntervalSeconds: 60,
        forEvaluations: 2,
        resolveAfterEvaluations: 2,
        enabled: true,
        lastState: 'normal',
      });
    });

    it.each([
      [{ operator: 'lt' }, 'operator'],
      [{ metricKey: 'request_rate' }, 'metricKey'],
      [{ metricKey: 'error_rate', threshold: 5 }, 'threshold'], // ratio, not percent
      [{ threshold: 0 }, 'threshold'],
      [{ windowSeconds: 45 }, 'windowSeconds'],
      [{ windowSeconds: 60, evaluationIntervalSeconds: 120 }, 'windowSeconds'],
      [{ forEvaluations: 0 }, 'forEvaluations'],
      [{ promql: 'up' }, '_root'],
    ])('rejects %j', async (overrides, field) => {
      const res = await post(a.agent, `/api/v1/projects/${projectA}/alert-rules`, rule(overrides));
      expect(res.status).toBe(400);
      expect(Object.keys(res.body.error.details.fields)).toContain(field);
    });

    it('rejects a destination from another organization', async () => {
      const res = await post(
        a.agent,
        `/api/v1/projects/${projectA}/alert-rules`,
        rule({ notificationDestinationId: destinationB }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.details.fields.notificationDestinationId).toBeDefined();
    });

    it('rejects webhook URLs that target internal networks (SSRF on save)', async () => {
      for (const url of [
        'http://127.0.0.1:27017/',
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost:4000/api',
        'https://internal.example.test/hook', // resolves to 10.0.0.8
        'ftp://example.com/x',
        'https://user:pw@hooks.example.com/',
      ]) {
        const res = await post(
          a.agent,
          `/api/v1/organizations/${a.organizationId}/notification-destinations`,
          {
            name: 'bad',
            url,
          },
        );
        expect(res.status).toBe(400);
        expect(['DESTINATION_BLOCKED', 'VALIDATION_ERROR']).toContain(res.body.error.code);
      }
    });
  });

  describe('destinations never leak secrets', () => {
    it('shows the signing secret once and only a URL preview afterwards', async () => {
      const created = await post(
        a.agent,
        `/api/v1/organizations/${a.organizationId}/notification-destinations`,
        {
          name: 'Slack-like',
          url: 'https://hooks.example.com/services/T0/B0/topsecrettoken',
        },
      );
      expect(created.status).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      expect(created.body.signingSecret).toMatch(/^whsec_/);

      const list = await a.agent.get(
        `/api/v1/organizations/${a.organizationId}/notification-destinations`,
      );
      const text = JSON.stringify(list.body);
      expect(text).not.toContain('topsecrettoken');
      expect(text).not.toContain(created.body.signingSecret);
      expect(text).not.toContain('signingSecretEncrypted');

      const stored = await NotificationDestinationModel.findById(
        created.body.destination.id,
      ).lean();
      expect(stored!.signingSecretEncrypted).not.toContain(created.body.signingSecret);
    });
  });

  describe('RBAC (ORG-003)', () => {
    it('lets a member create a rule using an existing destination, but not manage destinations', async () => {
      const res = await post(
        member.agent,
        `/api/v1/projects/${projectA}/alert-rules`,
        rule({ notificationDestinationId: destinationA }),
      );
      expect(res.status).toBe(201);

      const dest = await post(
        member.agent,
        `/api/v1/organizations/${a.organizationId}/notification-destinations`,
        {
          name: 'x',
          url: 'https://hooks.example.com/x',
        },
      );
      expect(dest.status).toBe(403);
      expect(
        (await del(member.agent, `/api/v1/notification-destinations/${destinationA}`)).status,
      ).toBe(403);
      // Members may read destinations, to choose one for their rules.
      expect(
        (
          await member.agent.get(
            `/api/v1/organizations/${a.organizationId}/notification-destinations`,
          )
        ).status,
      ).toBe(200);
    });

    it('lets members edit only their own rules; owners edit any', async () => {
      const ownersRule = (
        await post(
          a.agent,
          `/api/v1/projects/${projectA}/alert-rules`,
          rule({ name: 'owner rule' }),
        )
      ).body.rule.id;
      const membersRule = (
        await post(
          member.agent,
          `/api/v1/projects/${projectA}/alert-rules`,
          rule({ name: 'member rule' }),
        )
      ).body.rule.id;

      expect(
        (await patch(member.agent, `/api/v1/alert-rules/${ownersRule}`, { threshold: 900 })).status,
      ).toBe(403);
      expect((await del(member.agent, `/api/v1/alert-rules/${ownersRule}`)).status).toBe(403);
      expect(
        (await patch(member.agent, `/api/v1/alert-rules/${membersRule}`, { threshold: 900 })).body
          .rule.threshold,
      ).toBe(900);
      expect(
        (await patch(a.agent, `/api/v1/alert-rules/${membersRule}`, { enabled: false })).body.rule
          .enabled,
      ).toBe(false);
      expect((await del(member.agent, `/api/v1/alert-rules/${membersRule}`)).status).toBe(204);
    });
  });

  describe('tenant isolation (§14.2 item 1)', () => {
    it('A cannot list or create rules in B’s project', async () => {
      expect((await a.agent.get(`/api/v1/projects/${projectB}/alert-rules`)).status).toBe(404);
      expect((await post(a.agent, `/api/v1/projects/${projectB}/alert-rules`, rule())).status).toBe(
        404,
      );
    });

    it('A cannot edit or delete B’s rule by ID', async () => {
      expect((await patch(a.agent, `/api/v1/alert-rules/${ruleB}`, { threshold: 1 })).status).toBe(
        404,
      );
      expect((await del(a.agent, `/api/v1/alert-rules/${ruleB}`)).status).toBe(404);
    });

    it('A cannot read B’s incidents or their delivery history', async () => {
      expect((await a.agent.get(`/api/v1/projects/${projectB}/incidents`)).status).toBe(404);
      expect((await a.agent.get(`/api/v1/incidents/${incidentB}`)).status).toBe(404);
      expect((await a.agent.get(`/api/v1/incidents/${incidentB}/deliveries`)).status).toBe(404);
    });

    it('A cannot list, edit, delete, or test B’s destinations', async () => {
      expect(
        (await a.agent.get(`/api/v1/organizations/${b.organizationId}/notification-destinations`))
          .status,
      ).toBe(404);
      expect(
        (
          await patch(a.agent, `/api/v1/notification-destinations/${destinationB}`, {
            name: 'pwned',
          })
        ).status,
      ).toBe(404);
      expect((await del(a.agent, `/api/v1/notification-destinations/${destinationB}`)).status).toBe(
        404,
      );
      expect(
        (await post(a.agent, `/api/v1/notification-destinations/${destinationB}/test`)).status,
      ).toBe(404);
      expect((await NotificationDestinationModel.findById(destinationB).lean())!.name).toBe(
        'B hook',
      );
    });
  });
});
