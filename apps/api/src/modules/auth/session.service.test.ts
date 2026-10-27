import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../test/test-db.js';
import { SessionModel } from './session.model.js';
import { SessionService } from './session.service.js';

useTestDatabase();

const MINUTE = 60_000;

function clock(start = Date.UTC(2026, 9, 27, 12)) {
  let now = start;
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

const service = (c: ReturnType<typeof clock>, idleMinutes = 30, absoluteMinutes = 120) =>
  new SessionService(
    {
      secret: 'x'.repeat(32),
      idleTtlMs: idleMinutes * MINUTE,
      absoluteTtlMs: absoluteMinutes * MINUTE,
    },
    c.now,
  );

describe('SessionService expiry', () => {
  it('resolves a fresh session', async () => {
    const c = clock();
    const sessions = service(c);
    const userId = new Types.ObjectId();
    const { token } = await sessions.create(userId);
    expect((await sessions.resolve(token))?.userId.equals(userId)).toBe(true);
  });

  it('expires after the idle timeout without activity', async () => {
    const c = clock();
    const sessions = service(c);
    const { token } = await sessions.create(new Types.ObjectId());
    c.advance(31 * MINUTE);
    expect(await sessions.resolve(token)).toBeNull();
  });

  it('slides the idle expiry while the session is used', async () => {
    const c = clock();
    const sessions = service(c);
    const { token } = await sessions.create(new Types.ObjectId());
    for (let i = 0; i < 4; i++) {
      c.advance(20 * MINUTE);
      expect(await sessions.resolve(token)).not.toBeNull();
    }
  });

  it('never outlives the absolute lifetime, even with continuous activity', async () => {
    const c = clock();
    const sessions = service(c, 30, 60);
    const { token } = await sessions.create(new Types.ObjectId());
    c.advance(25 * MINUTE);
    expect(await sessions.resolve(token)).not.toBeNull();
    c.advance(25 * MINUTE);
    expect(await sessions.resolve(token)).not.toBeNull();
    c.advance(11 * MINUTE); // 61 minutes since creation
    expect(await sessions.resolve(token)).toBeNull();

    const stored = await SessionModel.findOne().sort({ createdAt: -1 }).lean();
    expect(stored!.idleExpiresAt.getTime()).toBeLessThanOrEqual(
      stored!.absoluteExpiresAt.getTime(),
    );
  });

  it('revokeAllForUser ends every session of that user only', async () => {
    const c = clock();
    const sessions = service(c);
    const alice = new Types.ObjectId();
    const bob = new Types.ObjectId();
    const a1 = await sessions.create(alice);
    const a2 = await sessions.create(alice);
    const b1 = await sessions.create(bob);
    await sessions.revokeAllForUser(alice);
    expect(await sessions.resolve(a1.token)).toBeNull();
    expect(await sessions.resolve(a2.token)).toBeNull();
    expect(await sessions.resolve(b1.token)).not.toBeNull();
  });
});
