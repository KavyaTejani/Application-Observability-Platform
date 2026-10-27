import { createHmac, randomBytes } from 'node:crypto';
import type { Types } from 'mongoose';
import { SessionModel } from './session.model.js';

export interface SessionSettings {
  secret: string;
  idleTtlMs: number;
  absoluteTtlMs: number;
}

export interface ActiveSession {
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
}

/** Sliding-expiry writes are throttled so active users do not cause a write per request. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

/**
 * Server-side sessions. The browser holds only an opaque 256-bit random token. MongoDB stores
 * its HMAC, so a database leak does not yield usable session cookies, and logout or expiry
 * takes effect immediately because every request is checked against the store.
 */
export class SessionService {
  constructor(
    private readonly settings: SessionSettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private hash(rawId: string): string {
    return createHmac('sha256', this.settings.secret).update(rawId).digest('hex');
  }

  /** Creates a session and returns the raw token for the cookie. The token is never stored. */
  async create(userId: Types.ObjectId): Promise<{ token: string; absoluteExpiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const absoluteExpiresAt = new Date(now.getTime() + this.settings.absoluteTtlMs);
    await SessionModel.create({
      sessionIdHash: this.hash(token),
      userId,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: this.cappedIdleExpiry(now, absoluteExpiresAt),
      absoluteExpiresAt,
    });
    return { token, absoluteExpiresAt };
  }

  /** Returns the session for a cookie token if it exists and has not expired. */
  async resolve(token: string): Promise<ActiveSession | null> {
    const now = this.now();
    const session = await SessionModel.findOne({
      sessionIdHash: this.hash(token),
      idleExpiresAt: { $gt: now },
      absoluteExpiresAt: { $gt: now },
    }).lean();
    if (!session) return null;

    if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      await SessionModel.updateOne(
        { _id: session._id },
        {
          $set: {
            lastSeenAt: now,
            idleExpiresAt: this.cappedIdleExpiry(now, session.absoluteExpiresAt),
          },
        },
      );
    }
    return { sessionId: session._id, userId: session.userId };
  }

  async revoke(token: string): Promise<void> {
    await SessionModel.deleteOne({ sessionIdHash: this.hash(token) });
  }

  async revokeAllForUser(userId: Types.ObjectId): Promise<void> {
    await SessionModel.deleteMany({ userId });
  }

  private cappedIdleExpiry(now: Date, absoluteExpiresAt: Date): Date {
    return new Date(Math.min(now.getTime() + this.settings.idleTtlMs, absoluteExpiresAt.getTime()));
  }
}
