import { Router, type RequestHandler } from 'express';

import { requireAdmin, requireRole, requireSelfOrAdmin } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import type { UsersController } from './user.controller';
import { createUserBody, paginationQuerySchema, updateUserBody, userIdParams } from './user.schemas';

export interface UserRouteDeps {
  controller: UsersController;
  authenticate: RequestHandler;
}

/**
 * Paths, middleware and handlers only. The order matches the legacy chain: auth → authz → validate → controller.
 * The guards hold no state, so the access policy is declared here, next to the paths it protects (ADR-028).
 */
export function createUsersRouter(deps: UserRouteDeps): Router {
  const { controller, authenticate } = deps;
  const router = Router();

  router.get('/', authenticate, requireAdmin, validate('query', paginationQuerySchema), controller.list); // SEC-05
  router.post('/', validate('body', createUserBody), controller.create); // public sign-up
  router.put(
    '/:id',
    authenticate,
    requireSelfOrAdmin(),
    validate('params', userIdParams),
    validate('body', updateUserBody),
    controller.update,
  );
  router.delete(
    '/:id',
    authenticate,
    requireRole('ADMIN_ROLE', 'VENTAS_ROLE'), // as legacy hasRole; SEC-13 revisits it in M6
    validate('params', userIdParams),
    controller.remove,
  );

  return router;
}
