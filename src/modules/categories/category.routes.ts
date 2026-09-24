import { Router, type RequestHandler } from 'express';

import { requireAdmin } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
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
 * The guards hold no state, so the access policy is declared here, next to the paths it protects (AM-M3-8).
 */
export function createCategoriesRouter(deps: CategoryRouteDeps): Router {
  const { controller, authenticate } = deps;
  const router = Router();

  router.get('/', validate('query', paginationQuerySchema), controller.list);
  router.get('/:id', validate('params', categoryIdParams), controller.getOne);
  router.post('/', authenticate, validate('body', createCategoryBody), controller.create);
  router.put(
    '/:id',
    authenticate,
    requireAdmin,
    validate('params', categoryIdParams),
    validate('body', updateCategoryBody),
    controller.update,
  );
  router.delete('/:id', authenticate, requireAdmin, validate('params', categoryIdParams), controller.remove);

  return router;
}
