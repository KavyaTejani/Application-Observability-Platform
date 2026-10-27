import type { Environment } from '@aop/validation';
import type { Types } from 'mongoose';
import type { Logger } from 'pino';
import { AppError } from '../../lib/errors.js';
import { ProjectModel } from '../projects/project.model.js';
import { ApiKeyModel, type ApiKeyScope } from './api-key.model.js';
import { hashKeySecret, parseApiKey, verifyKeySecret } from './api-key.crypto.js';

/**
 * Identity of a telemetry writer, derived only from a verified key and the database. Ingestion
 * stamps every record with these IDs. Tenant fields in a request body or header are ignored.
 */
export interface IngestionPrincipal {
  readonly organizationId: Types.ObjectId;
  readonly projectId: Types.ObjectId;
  readonly keyId: string;
  readonly environment: Environment;
  readonly projectName: string;
}

interface CachedKey {
  keyHash: string;
  status: 'active' | 'revoked';
  expiresAt?: Date;
  scopes: ApiKeyScope[];
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  project: { active: boolean; environment: Environment; name: string } | null;
  fetchedAt: number;
}

export const invalidApiKey = () =>
  new AppError(401, 'INVALID_API_KEY', 'The API key is missing, malformed, revoked, or expired.');

/** lastUsedAt is written at most this often per key, off the request path. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const MAX_CACHE_ENTRIES = 10_000;

/**
 * Verifies ingestion keys on the hot path. Key records are cached briefly. Revocation through
 * this process invalidates the cache entry immediately, and other API instances see it within
 * `cacheTtlMs` (KEY-003: "revoked keys fail immediately after cache invalidation or a
 * documented short TTL").
 */
export class KeyAuthenticator {
  private readonly cache = new Map<string, CachedKey>();
  private readonly lastUsedWrites = new Map<string, number>();
  private readonly dummyHash: string;

  constructor(
    private readonly pepper: string,
    private readonly cacheTtlMs: number,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dummyHash = hashKeySecret(pepper, 'unknown-key-placeholder');
  }

  /** Drops a key from the cache, so the next request re-reads it from the database. */
  invalidate(keyId: string): void {
    this.cache.delete(keyId);
  }

  async authenticate(authorization: string | undefined): Promise<IngestionPrincipal> {
    const match = /^Bearer (\S+)$/.exec(authorization ?? '');
    const parsed = match?.[1] ? parseApiKey(match[1]) : null;
    if (!parsed) throw invalidApiKey();

    const record = await this.load(parsed.keyId);
    // Verify even for unknown keys, so response time does not reveal which key IDs exist.
    const valid = verifyKeySecret(this.pepper, parsed.secret, record?.keyHash ?? this.dummyHash);
    if (!record || !valid) throw invalidApiKey();

    const now = this.now();
    const usable =
      record.status === 'active' &&
      (!record.expiresAt || record.expiresAt > now) &&
      record.scopes.includes('telemetry:write') &&
      record.project?.active === true;
    if (!usable || !record.project) throw invalidApiKey();

    this.touchLastUsed(parsed.keyId, now);
    return {
      organizationId: record.organizationId,
      projectId: record.projectId,
      keyId: parsed.keyId,
      environment: record.project.environment,
      projectName: record.project.name,
    };
  }

  private async load(keyId: string): Promise<CachedKey | null> {
    const cached = this.cache.get(keyId);
    if (cached && this.now().getTime() - cached.fetchedAt < this.cacheTtlMs) return cached;

    const key = await ApiKeyModel.findOne(
      { keyId },
      { keyHash: 1, status: 1, expiresAt: 1, scopes: 1, organizationId: 1, projectId: 1 },
    ).lean();
    if (!key) {
      this.cache.delete(keyId);
      return null;
    }
    // The project must belong to the key's organization, which guards against a corrupted or
    // hand-edited key record pointing at another tenant's project.
    const project = await ProjectModel.findOne(
      { _id: key.projectId, organizationId: key.organizationId },
      { status: 1, environment: 1, name: 1 },
    ).lean();

    const entry: CachedKey = {
      keyHash: key.keyHash,
      status: key.status,
      expiresAt: key.expiresAt,
      scopes: key.scopes,
      organizationId: key.organizationId,
      projectId: key.projectId,
      project: project
        ? {
            active: project.status === 'active',
            environment: project.environment,
            name: project.name,
          }
        : null,
      fetchedAt: this.now().getTime(),
    };
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      // Evict the oldest entry. Map iteration order is insertion order.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(keyId, entry);
    return entry;
  }

  private touchLastUsed(keyId: string, now: Date): void {
    const last = this.lastUsedWrites.get(keyId) ?? 0;
    if (now.getTime() - last < LAST_USED_WRITE_INTERVAL_MS) return;
    this.lastUsedWrites.set(keyId, now.getTime());
    ApiKeyModel.updateOne({ keyId }, { $set: { lastUsedAt: now } }).catch((error: unknown) =>
      this.logger.warn({ err: (error as Error).message }, 'Failed to record key lastUsedAt'),
    );
  }
}
