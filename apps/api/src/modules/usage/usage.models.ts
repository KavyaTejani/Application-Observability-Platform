import { Schema, model, type Types } from 'mongoose';

/**
 * Organization quota counter for one UTC day: the source of truth for enforcement (PRD
 * QUOTA-002/003). Records and bytes are *reserved* here with a conditional atomic `$inc` before a
 * batch is forwarded, and released again if the forward fails, so after a request completes the
 * counter equals what was accepted. A process crash between reserve and release leaves the
 * reservation in place: a small overcount, which errs on the safe side and is never an overrun.
 */
export interface OrgUsageDailyDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  dayUtc: string;
  records: number;
  bytes: number;
  updatedAt: Date;
}

const orgUsageSchema = new Schema<OrgUsageDailyDoc>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    dayUtc: { type: String, required: true },
    records: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);
orgUsageSchema.index({ organizationId: 1, dayUtc: -1 }, { unique: true });

export const OrgUsageDailyModel = model<OrgUsageDailyDoc>(
  'OrgUsageDaily',
  orgUsageSchema,
  'orgUsageDaily',
);

/**
 * Per-project usage for one UTC day (PRD §11.8), for visibility. Written after the outcome of
 * each batch is known, so it holds only accepted data. Rejections are counted too, with quota
 * rejections broken out so the usage screen can explain them.
 */
export interface UsageDailyDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  dayUtc: string;
  acceptedRecords: number;
  acceptedBytes: number;
  rejectedRecords: number;
  quotaRejectedRecords: number;
  updatedAt: Date;
}

const usageSchema = new Schema<UsageDailyDoc>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    projectId: { type: Schema.Types.ObjectId, required: true },
    dayUtc: { type: String, required: true },
    acceptedRecords: { type: Number, default: 0 },
    acceptedBytes: { type: Number, default: 0 },
    rejectedRecords: { type: Number, default: 0 },
    quotaRejectedRecords: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);
usageSchema.index({ organizationId: 1, projectId: 1, dayUtc: 1 }, { unique: true });
usageSchema.index({ organizationId: 1, dayUtc: 1 });

export const UsageDailyModel = model<UsageDailyDoc>('UsageDaily', usageSchema, 'usageDaily');
