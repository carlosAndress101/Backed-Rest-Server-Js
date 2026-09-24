import type { Request, RequestHandler } from 'express';

import { ForbiddenError, UnauthorizedError } from '../core/errors';
import type { Role } from '../core/security/roles';
import type { AuthUser } from './authenticate';

// ADR-028: interim guards with today's semantics. M6 replaces all three with authorize(policy) (SEC-13).

/** Defence in depth: authenticate runs first, so a request without req.user never reaches the guard's check. */
const requireUser = (req: Request): AuthUser => {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
};

/** Replaces esAdminRole. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (requireUser(req).role !== 'ADMIN_ROLE') throw new ForbiddenError('Administrator role required');
  next();
};

/** Replaces esAdminOrOwner on user routes: the caller is the user named by `req.params[idParam]`, or an administrator. */
export const requireSelfOrAdmin =
  (idParam = 'id'): RequestHandler =>
  (req, _res, next) => {
    const user = requireUser(req);
    if (user.role !== 'ADMIN_ROLE' && user.id !== req.params[idParam])
      throw new ForbiddenError('Owner or administrator required');
    next();
  };

/** Replaces hasRole(...roles): DELETE /api/user keeps requireRole('ADMIN_ROLE', 'VENTAS_ROLE') until M6. */
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!(roles as string[]).includes(requireUser(req).role))
      throw new ForbiddenError(`One of these roles required: ${roles.join(', ')}`);
    next();
  };
