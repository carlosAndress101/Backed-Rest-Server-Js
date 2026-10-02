import { Router, type RequestHandler } from 'express';

import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import type { UsersController } from './user.controller';
import { createUserBody, paginationQuerySchema, updateUserBody, userIdParams } from './user.schemas';

export interface UserRouteDeps {
  controller: UsersController;
  authenticate: RequestHandler;
}

/**
 * Paths, middleware and handlers only. The order matches the legacy chain: auth → authz → validate → controller.
 * The policy holds no state, so it is declared here, next to the paths it protects (ADR-038).
 */
export function createUsersRouter(deps: UserRouteDeps): Router {
  const { controller, authenticate } = deps;
  const router = Router();

  router.get(
    '/',
    authenticate,
    authorize({ roles: ['ADMIN_ROLE'] }),
    validate('query', paginationQuerySchema),
    controller.list,
  ); // SEC-05
  router.post('/', validate('body', createUserBody), controller.create); // public sign-up
  router.put(
    '/:id',
    authenticate,
    authorize({ roles: ['ADMIN_ROLE'], selfParam: 'id' }),
    validate('params', userIdParams),
    validate('body', updateUserBody),
    controller.update,
  );
  router.delete(
    '/:id',
    authenticate,
    authorize({ roles: ['ADMIN_ROLE'] }), // ADR-040: VENTAS_ROLE is dropped from user deletion
    validate('params', userIdParams),
    controller.remove,
  );

  return router;
}
