import { Schema, model, type Types } from 'mongoose';

export interface OrganizationDoc {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  ownerUserId: Types.ObjectId;
  planId: Types.ObjectId;
  /** Deployment-wide in the MVP and shown read-only. `metricsDays` is informational. */
  retention: { metricsDays: number; logsDays: number; tracesDays: number };
  /** Active projects. Maintained with conditional $inc so the plan limit is atomic. */
  projectCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const organizationSchema = new Schema<OrganizationDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: { type: String, required: true, unique: true },
    ownerUserId: { type: Schema.Types.ObjectId, required: true },
    planId: { type: Schema.Types.ObjectId, required: true },
    retention: {
      metricsDays: { type: Number, default: 15 },
      logsDays: { type: Number, default: 7 },
      tracesDays: { type: Number, default: 3 },
    },
    projectCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

export const OrganizationModel = model<OrganizationDoc>(
  'Organization',
  organizationSchema,
  'organizations',
);

export type Role = 'owner' | 'member';

export interface MembershipDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  role: Role;
  status: 'active' | 'invited' | 'removed';
  createdAt: Date;
}

const membershipSchema = new Schema<MembershipDoc>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    role: { type: String, enum: ['owner', 'member'], required: true },
    status: { type: String, enum: ['active', 'invited', 'removed'], default: 'active' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
membershipSchema.index({ organizationId: 1, userId: 1 }, { unique: true });

export const MembershipModel = model<MembershipDoc>('Membership', membershipSchema, 'memberships');
