import type { AlertMetricKey } from '@aop/validation';
import { Schema, model, type Types } from 'mongoose';

export type RuleState = 'normal' | 'pending' | 'firing' | 'error';

export interface AlertRuleDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  name: string;
  metricKey: AlertMetricKey;
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  threshold: number;
  windowSeconds: number;
  evaluationIntervalSeconds: number;
  forEvaluations: number;
  resolveAfterEvaluations: number;
  serviceName?: string;
  notificationDestinationId?: Types.ObjectId;
  enabled: boolean;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  // Evaluation state, owned by the evaluator.
  lastState: RuleState;
  lastEvaluatedAt?: Date;
  /** Last observed value: ratio for error_rate, ms for p95_latency; null = no data. */
  lastValue?: number | null;
  lastError?: string;
  consecutiveBreaches: number;
  consecutiveOk: number;
  nextEvaluationAt: Date;
  /** Lease so that only one evaluator handles a rule at a time, across instances. */
  lockedUntil?: Date;
  lockedBy?: string;
}

const alertRuleSchema = new Schema<AlertRuleDoc>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    projectId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, maxlength: 80 },
    metricKey: { type: String, enum: ['error_rate', 'p95_latency'], required: true },
    operator: { type: String, enum: ['gt', 'gte', 'lt', 'lte'], required: true },
    threshold: { type: Number, required: true },
    windowSeconds: { type: Number, required: true },
    evaluationIntervalSeconds: { type: Number, required: true },
    forEvaluations: { type: Number, required: true, min: 1 },
    resolveAfterEvaluations: { type: Number, required: true, min: 1 },
    serviceName: { type: String },
    notificationDestinationId: { type: Schema.Types.ObjectId },
    enabled: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    lastState: { type: String, enum: ['normal', 'pending', 'firing', 'error'], default: 'normal' },
    lastEvaluatedAt: { type: Date },
    lastValue: { type: Number, default: null },
    lastError: { type: String },
    consecutiveBreaches: { type: Number, default: 0 },
    consecutiveOk: { type: Number, default: 0 },
    nextEvaluationAt: { type: Date, required: true },
    lockedUntil: { type: Date },
    lockedBy: { type: String },
  },
  { timestamps: true },
);
alertRuleSchema.index({ organizationId: 1, projectId: 1, createdAt: 1 });
// The evaluator's "due rules" query.
alertRuleSchema.index({ enabled: 1, nextEvaluationAt: 1 });

export const AlertRuleModel = model<AlertRuleDoc>('AlertRule', alertRuleSchema, 'alertRules');

export interface IncidentDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  alertRuleId: Types.ObjectId;
  /** Dedupe key for one continuous firing condition of a rule. */
  fingerprint: string;
  status: 'firing' | 'resolved';
  title: string;
  startedAt: Date;
  resolvedAt?: Date;
  lastTriggeredAt: Date;
  lastValue?: number | null;
  /** Rule settings when the incident opened, so its history stays meaningful after edits. */
  ruleSnapshot: {
    metricKey: AlertMetricKey;
    operator: string;
    threshold: number;
    windowSeconds: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const incidentSchema = new Schema<IncidentDoc>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    projectId: { type: Schema.Types.ObjectId, required: true },
    alertRuleId: { type: Schema.Types.ObjectId, required: true },
    fingerprint: { type: String, required: true },
    status: { type: String, enum: ['firing', 'resolved'], required: true },
    title: { type: String, required: true },
    startedAt: { type: Date, required: true },
    resolvedAt: { type: Date },
    lastTriggeredAt: { type: Date, required: true },
    lastValue: { type: Number, default: null },
    ruleSnapshot: {
      metricKey: { type: String, required: true },
      operator: { type: String, required: true },
      threshold: { type: Number, required: true },
      windowSeconds: { type: Number, required: true },
    },
  },
  { timestamps: true },
);
// At most ONE open incident per rule and condition, enforced by the database even under
// concurrent evaluators (PRD §11.11, ALERT-006).
incidentSchema.index(
  { alertRuleId: 1, fingerprint: 1 },
  { unique: true, partialFilterExpression: { status: 'firing' } },
);
incidentSchema.index({ organizationId: 1, projectId: 1, startedAt: -1 });

export const IncidentModel = model<IncidentDoc>('Incident', incidentSchema, 'incidents');

export interface NotificationDestinationDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId?: Types.ObjectId;
  type: 'webhook';
  name: string;
  /** Full URL. Never returned to clients (paths often embed tokens); a preview is shown instead. */
  url: string;
  /** AES-256-GCM ciphertext of the per-destination signing secret. */
  signingSecretEncrypted: string;
  enabled: boolean;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const destinationSchema = new Schema<NotificationDestinationDoc>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    projectId: { type: Schema.Types.ObjectId },
    type: { type: String, enum: ['webhook'], default: 'webhook' },
    name: { type: String, required: true, maxlength: 80 },
    url: { type: String, required: true, maxlength: 2048 },
    signingSecretEncrypted: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);

export const NotificationDestinationModel = model<NotificationDestinationDoc>(
  'NotificationDestination',
  destinationSchema,
  'notificationDestinations',
);

export type NotificationEvent = 'incident_firing' | 'incident_resolved';

/**
 * Outbox of notifications to send. One row per (incident, destination, event): the unique index
 * is the deduplication guarantee, so a firing incident is announced once, not once per evaluation.
 */
export interface NotificationJobDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  incidentId: Types.ObjectId;
  destinationId: Types.ObjectId;
  event: NotificationEvent;
  status: 'pending' | 'delivered' | 'failed' | 'blocked';
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date;
  lockedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema = new Schema<NotificationJobDoc>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    projectId: { type: Schema.Types.ObjectId, required: true },
    incidentId: { type: Schema.Types.ObjectId, required: true },
    destinationId: { type: Schema.Types.ObjectId, required: true },
    event: { type: String, enum: ['incident_firing', 'incident_resolved'], required: true },
    status: {
      type: String,
      enum: ['pending', 'delivered', 'failed', 'blocked'],
      default: 'pending',
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    lockedUntil: { type: Date },
    lockedBy: { type: String },
  },
  { timestamps: true },
);
jobSchema.index({ incidentId: 1, destinationId: 1, event: 1 }, { unique: true });
jobSchema.index({ status: 1, nextAttemptAt: 1 });

export const NotificationJobModel = model<NotificationJobDoc>(
  'NotificationJob',
  jobSchema,
  'notificationJobs',
);

/** One record per delivery attempt (PRD §11.12). Never stores secrets or response bodies. */
export interface NotificationDeliveryDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  destinationId: Types.ObjectId;
  incidentId: Types.ObjectId;
  event: NotificationEvent;
  attempt: number;
  status: 'success' | 'failed' | 'blocked';
  responseStatus?: number;
  startedAt: Date;
  finishedAt: Date;
  errorSummary?: string;
}

const deliverySchema = new Schema<NotificationDeliveryDoc>({
  organizationId: { type: Schema.Types.ObjectId, required: true },
  projectId: { type: Schema.Types.ObjectId, required: true },
  destinationId: { type: Schema.Types.ObjectId, required: true },
  incidentId: { type: Schema.Types.ObjectId, required: true },
  event: { type: String, enum: ['incident_firing', 'incident_resolved'], required: true },
  attempt: { type: Number, required: true },
  status: { type: String, enum: ['success', 'failed', 'blocked'], required: true },
  responseStatus: { type: Number },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, required: true },
  errorSummary: { type: String, maxlength: 300 },
});
deliverySchema.index({ incidentId: 1, startedAt: 1 });

export const NotificationDeliveryModel = model<NotificationDeliveryDoc>(
  'NotificationDelivery',
  deliverySchema,
  'notificationDeliveries',
);
