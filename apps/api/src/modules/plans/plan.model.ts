import { Schema, model, type Types } from 'mongoose';

export interface PlanLimits {
  eventsPerDay: number;
  bytesPerDay: number;
  maxProjects: number;
  maxDashboards: number;
  maxAlertRules: number;
}

export interface PlanDoc {
  _id: Types.ObjectId;
  code: string;
  name: string;
  limits: PlanLimits;
  /** `metrics` values are informational while Prometheus retention is deployment-wide. */
  allowedRetentionDays: { metrics: number[]; logs: number[]; traces: number[] };
  active: boolean;
}

const planSchema = new Schema<PlanDoc>(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    limits: {
      eventsPerDay: { type: Number, required: true, min: 0 },
      bytesPerDay: { type: Number, required: true, min: 0 },
      maxProjects: { type: Number, required: true, min: 0 },
      maxDashboards: { type: Number, required: true, min: 0 },
      maxAlertRules: { type: Number, required: true, min: 0 },
    },
    allowedRetentionDays: {
      metrics: { type: [Number], default: [15] },
      logs: { type: [Number], default: [7] },
      traces: { type: [Number], default: [3] },
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const PlanModel = model<PlanDoc>('Plan', planSchema, 'plans');
