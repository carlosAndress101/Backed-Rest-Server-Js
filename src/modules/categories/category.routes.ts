import { Router, type RequestHandler } from 'express';

import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { CATALOG_ROLES } from '../../core/security/roles';
import type { CategoriesController } from './category.controller';
import {
  categoryIdParams,
  createCategoryBody,
  paginationQuerySchema,
  updateCategoryBody,
} from './category.schemas';

export interface CategoryRouteDeps {
  controller: CategoriesController;
  authenticate: RequestHandler;
}

/**
 * Paths, middleware and handlers only. The order matches the legacy chain: auth → authz → validate → controller.
 * The policy holds no state, so it is declared here, next to the paths it protects (ADR-038).
 *
 * AM-M6-2: categories are a shared taxonomy other users' products reference, so PUT/DELETE are a pure role
 * policy (CATALOG_ROLES) — no ownership, no `deferToService`. POST stays open to every authenticated role.
 */
export function createCategoriesRouter(deps: CategoryRouteDeps): Router {
  const { controller, authenticate } = deps;
  const router = Router();

  router.get('/', validate('query', paginationQuerySchema), controller.list);
  router.get('/:id', validate('params', categoryIdParams), controller.getOne);
  router.post('/', authenticate, authorize({}), validate('body', createCategoryBody), controller.create);
  router.put(
    '/:id',
    authenticate,
    authorize({ roles: CATALOG_ROLES }),
    validate('params', categoryIdParams),
    validate('body', updateCategoryBody),
    controller.update,
  );
  router.delete(
    '/:id',
    authenticate,
    authorize({ roles: CATALOG_ROLES }),
    validate('params', categoryIdParams),
    controller.remove,
  );

  return router;
}
