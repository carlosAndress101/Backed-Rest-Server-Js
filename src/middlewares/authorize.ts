import type { Request, RequestHandler } from 'express';

import { ForbiddenError, UnauthorizedError } from '../core/errors';
import type { Role } from '../core/security/roles';
import type { AuthUser } from './authenticate';

/**
 * A route's access rule (ADR-038). `authorize` never reads the database (P29): a check that needs the
 * resource itself (a stored creator, not the URL's own id) is deferred to the service, which already
 * loads it for find-active-or-404 (ADR-039).
 */
export interface Policy {
  /** Roles that satisfy this policy on their own. Omitted = every authenticated role. */
  roles?: readonly Role[];
  /**
   * Also satisfied when `req.params[selfParam]` equals the caller's own id. Compared case-insensitively
   * (AM-M6-7), matching `UsersService`'s `isSelf` and Mongoose's `ObjectId` comparison (P29). No DB read:
   * the id in the URL IS the owner's id, for a user's own account.
   */
  selfParam?: string;
  /** Also satisfied once the service, having loaded the resource, finds the caller is its creator (ADR-039). */
  deferToService?: true;
}

/** Defence in depth: authenticate runs first, so a request without req.user never reaches the policy check. */
const requireUser = (req: Request): AuthUser => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

/**
 * ADR-038: the one authorization middleware, replacing the three interim role/ownership guards (SEC-13).
 * Runs after `authenticate`; touches no database (P29). When no branch of the policy matches, it is a 403.
 */
export const authorize =
  (policy: Policy): RequestHandler =>
  (req, _res, next) => {
    const user = requireUser(req);
    if (!policy.roles || policy.roles.includes(user.role as Role)) return next();
    const target = policy.selfParam ? req.params[policy.selfParam] : undefined;
    if (typeof target === 'string' && target.toLowerCase() === user.id.toLowerCase()) return next();
    if (policy.deferToService) return next(); // the service decides, atomically with its write (ADR-039)
    throw new ForbiddenError('Not allowed');
  };
