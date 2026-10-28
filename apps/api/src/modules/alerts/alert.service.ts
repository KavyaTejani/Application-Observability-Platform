import type {
  createAlertRuleSchema,
  createDestinationSchema,
  updateAlertRuleSchema,
  updateDestinationSchema,
} from '@aop/validation';
import type { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError, notFound } from '../../lib/errors.js';
import {
  assertCan,
  parseObjectId,
  resolveOrgScope,
  type ProjectScope,
  type TenantScope,
} from '../authz/tenant-scope.js';
import { OrganizationModel } from '../organizations/organization.model.js';
import { PlanModel } from '../plans/plan.model.js';
import { ProjectModel } from '../projects/project.model.js';
import {
  AlertRuleModel,
  IncidentModel,
  NotificationDeliveryModel,
  NotificationDestinationModel,
  type AlertRuleDoc,
  type IncidentDoc,
  type NotificationDestinationDoc,
} from './alert.models.js';
import { generateSigningSecret, signPayload, type SecretBox } from './secret-box.js';
import { checkWebhookUrl, urlPreview, type UrlPolicy } from './ssrf.js';
import type { WebhookResult, WebhookSender } from './webhook-client.js';

type CreateRule = z.output<typeof createAlertRuleSchema>;
type UpdateRule = z.output<typeof updateAlertRuleSchema>;
type CreateDestination = z.output<typeof createDestinationSchema>;
type UpdateDestination = z.output<typeof updateDestinationSchema>;

export const ruleSummary = (r: AlertRuleDoc) => ({
  id: r._id.toHexString(),
  projectId: r.projectId.toHexString(),
  name: r.name,
  metricKey: r.metricKey,
  operator: r.operator,
  threshold: r.threshold,
  windowSeconds: r.windowSeconds,
  evaluationIntervalSeconds: r.evaluationIntervalSeconds,
  forEvaluations: r.forEvaluations,
  resolveAfterEvaluations: r.resolveAfterEvaluations,
  serviceName: r.serviceName ?? null,
  notificationDestinationId: r.notificationDestinationId?.toHexString() ?? null,
  enabled: r.enabled,
  createdBy: r.createdBy.toHexString(),
  lastState: r.lastState,
  lastEvaluatedAt: r.lastEvaluatedAt?.toISOString() ?? null,
  lastValue: r.lastValue ?? null,
  lastError: r.lastError ?? null,
  createdAt: r.createdAt.toISOString(),
});

const incidentSummary = (i: IncidentDoc) => ({
  id: i._id.toHexString(),
  projectId: i.projectId.toHexString(),
  alertRuleId: i.alertRuleId.toHexString(),
  status: i.status,
  title: i.title,
  startedAt: i.startedAt.toISOString(),
  resolvedAt: i.resolvedAt?.toISOString() ?? null,
  lastTriggeredAt: i.lastTriggeredAt.toISOString(),
  lastValue: i.lastValue ?? null,
  ruleSnapshot: i.ruleSnapshot,
});

/** Destination metadata: never the signing secret, never the full URL (paths embed tokens). */
const destinationSummary = (d: NotificationDestinationDoc) => ({
  id: d._id.toHexString(),
  name: d.name,
  type: d.type,
  urlPreview: urlPreview(d.url),
  projectId: d.projectId?.toHexString() ?? null,
  enabled: d.enabled,
  createdAt: d.createdAt.toISOString(),
});

const blocked = (reason: string) =>
  new AppError(400, 'DESTINATION_BLOCKED', `This webhook URL is not allowed: ${reason}.`, {
    fields: { url: reason },
  });

/**
 * Alert rules, incidents, and notification destinations. Resources addressed by their own ID are
 * loaded first and then authorized against THEIR organization (`scopeFor`), so guessing an ID
 * from another tenant yields the same 404 as a missing one.
 */
export class AlertService {
  constructor(
    private readonly secretBox: SecretBox,
    private readonly urlPolicy: UrlPolicy,
    private readonly sender: WebhookSender,
  ) {}

  private async scopeFor(
    userId: Types.ObjectId,
    organizationId: Types.ObjectId,
    what: string,
  ): Promise<TenantScope> {
    try {
      return await resolveOrgScope(userId, organizationId.toHexString());
    } catch {
      throw notFound(`${what} not found.`);
    }
  }

  // ---- Alert rules -------------------------------------------------------------------------

  async listRules(scope: ProjectScope) {
    const rules = await AlertRuleModel.find({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    })
      .sort({ createdAt: 1 })
      .lean();
    return rules.map(ruleSummary);
  }

  async createRule(scope: ProjectScope, input: CreateRule) {
    assertCan(scope, 'alertRule:create');
    await this.assertRuleLimit(scope);
    const destinationId = await this.validDestination(scope, input.notificationDestinationId);
    const rule = await AlertRuleModel.create({
      ...input,
      notificationDestinationId: destinationId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      createdBy: scope.userId,
      lastState: 'normal',
      consecutiveBreaches: 0,
      consecutiveOk: 0,
      nextEvaluationAt: new Date(),
    });
    return ruleSummary(rule.toObject());
  }

  /** Members may edit only rules they created; owners may edit any (PRD ORG-003). */
  private async loadRuleForWrite(userId: Types.ObjectId, ruleIdParam: unknown) {
    const id = parseObjectId(ruleIdParam);
    if (!id) throw notFound('Alert rule not found.');
    const rule = await AlertRuleModel.findById(id).lean();
    if (!rule) throw notFound('Alert rule not found.');
    const scope = await this.scopeFor(userId, rule.organizationId, 'Alert rule');
    if (!rule.createdBy.equals(scope.userId)) assertCan(scope, 'alertRule:manageAny');
    return { rule, scope };
  }

  async updateRule(userId: Types.ObjectId, ruleId: unknown, input: UpdateRule) {
    const { rule, scope } = await this.loadRuleForWrite(userId, ruleId);
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === 'notificationDestinationId' || key === 'serviceName') continue;
      if (value !== undefined) $set[key] = value;
    }
    if (input.serviceName === null) $unset.serviceName = '';
    else if (input.serviceName) $set.serviceName = input.serviceName;
    if (input.notificationDestinationId === null) $unset.notificationDestinationId = '';
    else if (input.notificationDestinationId) {
      $set.notificationDestinationId = await this.validDestination(
        { ...scope, projectId: rule.projectId },
        input.notificationDestinationId,
      );
    }

    const window = (input.windowSeconds ?? rule.windowSeconds) as number;
    const interval = (input.evaluationIntervalSeconds ?? rule.evaluationIntervalSeconds) as number;
    if (window < interval) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', {
        fields: { windowSeconds: 'Window must be at least as long as the evaluation interval' },
      });
    }
    // Changing the condition restarts its counting, so old breaches do not count against it.
    if (['threshold', 'windowSeconds', 'forEvaluations'].some((k) => k in $set)) {
      $set.consecutiveBreaches = 0;
      $set.nextEvaluationAt = new Date();
    }
    if (input.enabled === false) {
      $set.lastState = 'normal';
      $set.consecutiveBreaches = 0;
      $set.consecutiveOk = 0;
      await this.closeOpenIncident(rule._id);
    }
    if (input.enabled === true && !rule.enabled) $set.nextEvaluationAt = new Date();

    const updated = await AlertRuleModel.findOneAndUpdate(
      { _id: rule._id, organizationId: scope.organizationId },
      { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
      { returnDocument: 'after', lean: true },
    );
    if (!updated) throw notFound('Alert rule not found.');
    return ruleSummary(updated);
  }

  async deleteRule(userId: Types.ObjectId, ruleId: unknown) {
    const { rule, scope } = await this.loadRuleForWrite(userId, ruleId);
    await this.closeOpenIncident(rule._id);
    await AlertRuleModel.deleteOne({ _id: rule._id, organizationId: scope.organizationId });
  }

  /** A disabled or deleted rule can no longer resolve its incident, so it is closed now. */
  private async closeOpenIncident(ruleId: Types.ObjectId) {
    await IncidentModel.updateOne(
      { alertRuleId: ruleId, status: 'firing' },
      { $set: { status: 'resolved', resolvedAt: new Date() } },
    );
  }

  private async assertRuleLimit(scope: TenantScope) {
    const org = await OrganizationModel.findById(scope.organizationId, { planId: 1 }).lean();
    const plan = org && (await PlanModel.findById(org.planId, { limits: 1 }).lean());
    const max = plan?.limits.maxAlertRules ?? 10;
    if ((await AlertRuleModel.countDocuments({ organizationId: scope.organizationId })) >= max) {
      throw new AppError(409, 'PLAN_LIMIT_REACHED', `Your plan allows ${max} alert rules.`, {
        limit: max,
        resource: 'alertRules',
      });
    }
  }

  /** A rule may only notify an enabled destination of its own org (and project, if scoped). */
  private async validDestination(
    scope: TenantScope & { projectId: Types.ObjectId },
    idParam?: string,
  ) {
    if (!idParam) return undefined;
    const id = parseObjectId(idParam);
    const destination =
      id &&
      (await NotificationDestinationModel.findOne({
        _id: id,
        organizationId: scope.organizationId,
        enabled: true,
      }).lean());
    if (!destination || (destination.projectId && !destination.projectId.equals(scope.projectId))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', {
        fields: { notificationDestinationId: 'Choose an enabled destination of this organization' },
      });
    }
    return destination._id;
  }

  // ---- Incidents ---------------------------------------------------------------------------

  async listIncidents(
    scope: ProjectScope,
    status: 'firing' | 'resolved' | undefined,
    limit: number,
  ) {
    const incidents = await IncidentModel.find({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      ...(status ? { status } : {}),
    })
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();
    return incidents.map(incidentSummary);
  }

  private async loadIncident(userId: Types.ObjectId, incidentIdParam: unknown) {
    const id = parseObjectId(incidentIdParam);
    if (!id) throw notFound('Incident not found.');
    const incident = await IncidentModel.findById(id).lean();
    if (!incident) throw notFound('Incident not found.');
    const scope = await this.scopeFor(userId, incident.organizationId, 'Incident');
    assertCan(scope, 'incident:read');
    return { incident, scope };
  }

  async getIncident(userId: Types.ObjectId, incidentId: unknown) {
    const { incident, scope } = await this.loadIncident(userId, incidentId);
    const [rule, project] = await Promise.all([
      AlertRuleModel.findOne({
        _id: incident.alertRuleId,
        organizationId: scope.organizationId,
      }).lean(),
      ProjectModel.findOne(
        { _id: incident.projectId, organizationId: scope.organizationId },
        { name: 1, environment: 1 },
      ).lean(),
    ]);
    return {
      ...incidentSummary(incident),
      organizationId: incident.organizationId.toHexString(),
      rule: rule ? ruleSummary(rule) : null,
      project: project
        ? { id: project._id.toHexString(), name: project.name, environment: project.environment }
        : null,
    };
  }

  async listDeliveries(userId: Types.ObjectId, incidentId: unknown) {
    const { incident, scope } = await this.loadIncident(userId, incidentId);
    const deliveries = await NotificationDeliveryModel.find({
      incidentId: incident._id,
      organizationId: scope.organizationId,
    })
      .sort({ startedAt: 1 })
      .limit(200)
      .lean();
    return deliveries.map((d) => ({
      id: d._id.toHexString(),
      destinationId: d.destinationId.toHexString(),
      event: d.event,
      attempt: d.attempt,
      status: d.status,
      responseStatus: d.responseStatus ?? null,
      startedAt: d.startedAt.toISOString(),
      finishedAt: d.finishedAt.toISOString(),
      errorSummary: d.errorSummary ?? null,
    }));
  }

  // ---- Notification destinations -----------------------------------------------------------

  async listDestinations(scope: TenantScope) {
    assertCan(scope, 'destination:read');
    const destinations = await NotificationDestinationModel.find({
      organizationId: scope.organizationId,
    })
      .sort({ createdAt: 1 })
      .lean();
    return destinations.map(destinationSummary);
  }

  async createDestination(scope: TenantScope, input: CreateDestination) {
    assertCan(scope, 'destination:manage');
    const check = await checkWebhookUrl(input.url, this.urlPolicy);
    if (!check.ok) throw blocked(check.reason);
    let projectId: Types.ObjectId | undefined;
    if (input.projectId) {
      const project = await ProjectModel.findOne(
        { _id: input.projectId, organizationId: scope.organizationId, status: 'active' },
        { _id: 1 },
      ).lean();
      if (!project) throw notFound('Project not found.');
      projectId = project._id;
    }
    const secret = generateSigningSecret();
    const destination = await NotificationDestinationModel.create({
      organizationId: scope.organizationId,
      projectId,
      type: 'webhook',
      name: input.name,
      url: input.url,
      signingSecretEncrypted: this.secretBox.encrypt(secret),
      createdBy: scope.userId,
    });
    // The signing secret is shown once, like an API key.
    return { destination: destinationSummary(destination.toObject()), signingSecret: secret };
  }

  private async loadDestinationForWrite(userId: Types.ObjectId, idParam: unknown) {
    const id = parseObjectId(idParam);
    if (!id) throw notFound('Destination not found.');
    const destination = await NotificationDestinationModel.findById(id).lean();
    if (!destination) throw notFound('Destination not found.');
    const scope = await this.scopeFor(userId, destination.organizationId, 'Destination');
    assertCan(scope, 'destination:manage');
    return { destination, scope };
  }

  async updateDestination(userId: Types.ObjectId, id: unknown, input: UpdateDestination) {
    const { destination, scope } = await this.loadDestinationForWrite(userId, id);
    if (input.url) {
      const check = await checkWebhookUrl(input.url, this.urlPolicy);
      if (!check.ok) throw blocked(check.reason);
    }
    const updated = await NotificationDestinationModel.findOneAndUpdate(
      { _id: destination._id, organizationId: scope.organizationId },
      { $set: input },
      { returnDocument: 'after', lean: true },
    );
    if (!updated) throw notFound('Destination not found.');
    return destinationSummary(updated);
  }

  async deleteDestination(userId: Types.ObjectId, id: unknown) {
    const { destination, scope } = await this.loadDestinationForWrite(userId, id);
    await AlertRuleModel.updateMany(
      { organizationId: scope.organizationId, notificationDestinationId: destination._id },
      { $unset: { notificationDestinationId: '' } },
    );
    await NotificationDestinationModel.deleteOne({
      _id: destination._id,
      organizationId: scope.organizationId,
    });
  }

  /** Sends a clearly labelled test payload through the same SSRF-checked path. */
  async testDestination(userId: Types.ObjectId, id: unknown): Promise<WebhookResult> {
    const { destination } = await this.loadDestinationForWrite(userId, id);
    const body = JSON.stringify({
      event: 'test',
      message:
        'Test notification from the Application Observability Platform. No incident is involved.',
      destinationId: destination._id.toHexString(),
      sentAt: new Date().toISOString(),
    });
    const secret = this.secretBox.decrypt(destination.signingSecretEncrypted);
    return this.sender.send(destination.url, body, {
      'X-AOP-Event': 'test',
      'X-AOP-Signature': signPayload(secret, body, Math.floor(Date.now() / 1000)),
    });
  }
}
