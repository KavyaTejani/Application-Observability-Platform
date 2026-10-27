import type { Types } from 'mongoose';
import type { IngestionPrincipal } from '../modules/api-keys/key-authenticator.js';
import type { ProjectScope, TenantScope } from '../modules/authz/tenant-scope.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `sessionAuth` when a valid session cookie is present. */
      auth?: { sessionId: Types.ObjectId; userId: Types.ObjectId; token: string };
      /** Set by `requireOrgScope` / `requireProjectScope` after membership has been verified. */
      scope?: TenantScope | ProjectScope;
      /** Set by `requireApiKey` on ingestion routes; derived only from a verified key. */
      ingest?: IngestionPrincipal;
    }
  }
}

export {};
