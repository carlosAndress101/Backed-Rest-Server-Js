import { Router, type RequestHandler } from 'express';

import { requireAdmin } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import type { ProductsController } from './product.controller';
import {
  createProductBody,
  paginationQuerySchema,
  productIdParams,
  updateProductBody,
} from './product.schemas';

export interface ProductRouteDeps {
  controller: ProductsController;
  authenticate: RequestHandler;
}

/**
 * Paths, middleware and handlers only. The order matches the legacy chain: auth → authz → validate → controller.
 * The guards hold no state, so the access policy is declared here, next to the paths it protects (AM-M3-8).
 */
export function createProductsRouter(deps: ProductRouteDeps): Router {
  const { controller, authenticate } = deps;
  const router = Router();

  router.get('/', validate('query', paginationQuerySchema), controller.list);
  router.get('/:id', validate('params', productIdParams), controller.getOne);
  router.post('/', authenticate, validate('body', createProductBody), controller.create);
  router.put(
    '/:id',
    authenticate,
    requireAdmin,
    validate('params', productIdParams),
    validate('body', updateProductBody),
    controller.update,
  );
  router.delete('/:id', authenticate, requireAdmin, validate('params', productIdParams), controller.remove);

  return router;
}
