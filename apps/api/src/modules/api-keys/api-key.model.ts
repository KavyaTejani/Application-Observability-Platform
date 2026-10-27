import { Schema, model, type Types } from 'mongoose';

export type ApiKeyScope = 'telemetry:write';

export interface ApiKeyDoc {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  name: string;
  /** Public lookup identifier, embedded in the key itself. Not secret. */
  keyId: string;
  /** HMAC-SHA-256(pepper, secret). The raw secret is shown once and never stored. */
  keyHash: string;
  /** Non-secret display form, e.g. `aop_1a2b3c4d5e6f7a8b`. */
  prefix: string;
  scopes: ApiKeyScope[];
  status: 'active' | 'revoked';
  /** Set when a rotation grace period ends; the key stops working at this instant. */
  expiresAt?: Date;
  /** keyId of the key that replaced this one through rotation. */
  replacedBy?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

const apiKeySchema = new Schema<ApiKeyDoc>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    projectId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, maxlength: 60 },
    keyId: { type: String, required: true, unique: true },
    keyHash: { type: String, required: true },
    prefix: { type: String, required: true },
    scopes: { type: [String], enum: ['telemetry:write'], default: ['telemetry:write'] },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    expiresAt: { type: Date },
    replacedBy: { type: String },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

apiKeySchema.index({ organizationId: 1, projectId: 1, createdAt: -1 });

export const ApiKeyModel = model<ApiKeyDoc>('ApiKey', apiKeySchema, 'apiKeys');
