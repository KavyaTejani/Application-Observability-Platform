import type { Types } from 'mongoose';
import { AppError, notFound } from '../../lib/errors.js';
import type { ProjectScope } from '../authz/tenant-scope.js';
import { ApiKeyModel, type ApiKeyDoc } from './api-key.model.js';
import { generateApiKey } from './api-key.crypto.js';

/** Upper bound on simultaneously usable keys per project (active, including grace periods). */
export const MAX_ACTIVE_KEYS_PER_PROJECT = 10;

export type KeyState = 'active' | 'expiring' | 'revoked';

/** Key metadata safe to return to any organization member. It never includes the secret or hash. */
export interface ApiKeySummary {
  keyId: string;
  name: string;
  prefix: string;
  scopes: string[];
  state: KeyState;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  replacedBy: string | null;
}

export interface CreatedApiKey {
  key: ApiKeySummary;
  /** The full key. Returned exactly once, at creation or rotation. */
  secret: string;
}

/** Notified when a key stops being valid, so the ingestion cache can drop it immediately. */
export type KeyInvalidationListener = (keyId: string) => void;

function stateOf(key: Pick<ApiKeyDoc, 'status' | 'expiresAt'>, now: Date): KeyState {
  if (key.status === 'revoked') return 'revoked';
  if (key.expiresAt) return key.expiresAt > now ? 'expiring' : 'revoked';
  return 'active';
}

function toSummary(key: ApiKeyDoc, now: Date): ApiKeySummary {
  return {
    keyId: key.keyId,
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    state: stateOf(key, now),
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    replacedBy: key.replacedBy ?? null,
  };
}

/** Filter for keys that can still authenticate at `now`. */
const usableFilter = (now: Date) => ({
  status: 'active' as const,
  $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
});

export class ApiKeyService {
  constructor(
    private readonly pepper: string,
    private readonly onInvalidate: KeyInvalidationListener = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(scope: ProjectScope): Promise<ApiKeySummary[]> {
    const now = this.now();
    const keys = await ApiKeyModel.find({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    })
      .sort({ createdAt: -1 })
      .lean();
    return keys.map((key) => toSummary(key, now));
  }

  async create(scope: ProjectScope, name: string): Promise<CreatedApiKey> {
    const now = this.now();
    const usable = await ApiKeyModel.countDocuments({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      ...usableFilter(now),
    });
    if (usable >= MAX_ACTIVE_KEYS_PER_PROJECT) {
      throw new AppError(
        409,
        'KEY_LIMIT_REACHED',
        `A project can have at most ${MAX_ACTIVE_KEYS_PER_PROJECT} active keys. Revoke one first.`,
      );
    }
    return this.insert(scope, name);
  }

  async revoke(scope: ProjectScope, keyId: string): Promise<ApiKeySummary> {
    const now = this.now();
    const filter = { organizationId: scope.organizationId, projectId: scope.projectId, keyId };
    // Idempotent: revoking an already revoked key keeps its original revocation time.
    await ApiKeyModel.updateOne(
      { ...filter, status: 'active' },
      { $set: { status: 'revoked', revokedAt: now } },
    );
    const key = await ApiKeyModel.findOne(filter).lean();
    if (!key) throw notFound('API key not found.');
    this.onInvalidate(keyId);
    return toSummary(key, now);
  }

  /**
   * Issues a replacement key. The old key is revoked now, or after `gracePeriodHours` so that
   * deployed services can switch over without dropping telemetry.
   */
  async rotate(
    scope: ProjectScope,
    keyId: string,
    gracePeriodHours: number,
  ): Promise<{ replacement: CreatedApiKey; previous: ApiKeySummary }> {
    const now = this.now();
    const filter = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      keyId,
    };
    const old = await ApiKeyModel.findOne(filter).lean();
    if (!old) throw notFound('API key not found.');
    if (stateOf(old, now) !== 'active') {
      throw new AppError(409, 'KEY_NOT_ACTIVE', 'Only an active key can be rotated.');
    }

    const replacement = await this.insert(scope, old.name);
    const previous = await ApiKeyModel.findOneAndUpdate(
      { ...filter, status: 'active' },
      {
        $set:
          gracePeriodHours === 0
            ? { status: 'revoked', revokedAt: now, replacedBy: replacement.key.keyId }
            : {
                expiresAt: new Date(now.getTime() + gracePeriodHours * 3_600_000),
                replacedBy: replacement.key.keyId,
              },
      },
      { returnDocument: 'after', lean: true },
    );
    if (!previous) {
      // The old key was revoked concurrently. The replacement still stands, and the old key
      // is unusable either way.
      throw new AppError(409, 'KEY_NOT_ACTIVE', 'The key was revoked while rotating it.');
    }
    this.onInvalidate(keyId);
    return { replacement, previous: toSummary(previous, now) };
  }

  /** Used when a project is deleted: every key stops working immediately. */
  async revokeAllForProject(organizationId: Types.ObjectId, projectId: Types.ObjectId) {
    const now = this.now();
    const keys = await ApiKeyModel.find(
      { organizationId, projectId, status: 'active' },
      { keyId: 1 },
    ).lean();
    await ApiKeyModel.updateMany(
      { organizationId, projectId, status: 'active' },
      { $set: { status: 'revoked', revokedAt: now } },
    );
    for (const key of keys) this.onInvalidate(key.keyId);
  }

  private async insert(scope: ProjectScope, name: string): Promise<CreatedApiKey> {
    const generated = generateApiKey(this.pepper);
    const key = await ApiKeyModel.create({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      name,
      keyId: generated.keyId,
      keyHash: generated.keyHash,
      prefix: generated.prefix,
      scopes: ['telemetry:write'],
      createdBy: scope.userId,
    });
    return { key: toSummary(key.toObject(), this.now()), secret: generated.plaintext };
  }
}
