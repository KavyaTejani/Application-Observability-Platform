import { Schema, model, type Types } from 'mongoose';

export interface SessionDoc {
  _id: Types.ObjectId;
  /** HMAC-SHA-256 of the opaque cookie value. The raw session ID is never stored or logged. */
  sessionIdHash: string;
  userId: Types.ObjectId;
  createdAt: Date;
  lastSeenAt: Date;
  /** Sliding expiry, always capped at `absoluteExpiresAt`, so it is the effective expiry. */
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

const sessionSchema = new Schema<SessionDoc>({
  sessionIdHash: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  createdAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  idleExpiresAt: { type: Date, required: true },
  absoluteExpiresAt: { type: Date, required: true },
});

// MongoDB's TTL monitor deletes expired sessions (about once a minute). Expiry is also checked
// on every request, so a session is unusable the moment it expires, not when it is deleted.
sessionSchema.index({ idleExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel = model<SessionDoc>('Session', sessionSchema, 'sessions');
