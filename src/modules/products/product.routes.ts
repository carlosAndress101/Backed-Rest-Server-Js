import { Router, type RequestHandler } from 'express';

import { authorize } from '../../middlewares/authorize';
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
 * The policy holds no state, so it is declared here, next to the paths it protects (ADR-038).
 */
export function createProductsRouter(deps: ProductRouteDeps): Router {
  const { controller, authenticate } = deps;
  const router = Router();

  router.get('/', validate('query', paginationQuerySchema), controller.list);
  router.get('/:id', validate('params', productIdParams), controller.getOne);
  router.post('/', authenticate, authorize({}), validate('body', createProductBody), controller.create);
  router.put(
    '/:id',
    authenticate,
    authorize({ roles: ['ADMIN_ROLE'] }),
    validate('params', productIdParams),
    validate('body', updateProductBody),
    controller.update,
  );
  router.delete(
    '/:id',
    authenticate,
    authorize({ roles: ['ADMIN_ROLE'] }),
    validate('params', productIdParams),
    controller.remove,
  );

  return router;
}
