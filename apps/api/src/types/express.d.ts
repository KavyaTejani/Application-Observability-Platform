import type { Types } from 'mongoose';
import type { TenantScope } from '../modules/authz/tenant-scope.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `sessionAuth` when a valid session cookie is present. */
      auth?: { sessionId: Types.ObjectId; userId: Types.ObjectId; token: string };
      /** Set by `requireOrgScope` after membership has been verified. */
      scope?: TenantScope;
    }
  }
}

export {};
