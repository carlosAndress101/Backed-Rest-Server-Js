import { Router, type RequestHandler } from 'express';

import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { CATALOG_ROLES } from '../../core/security/roles';
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
 *
 * ADR-041: a product's creator may PUT/DELETE their own active product, alongside CATALOG_ROLES on any item.
 * `deferToService` lets any authenticated caller through here; the ownership decision is the service's, made
 * atomically with the write (ADR-039). POST stays open to every authenticated role.
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
    authorize({ roles: CATALOG_ROLES, deferToService: true }),
    validate('params', productIdParams),
    validate('body', updateProductBody),
    controller.update,
  );
  router.delete(
    '/:id',
    authenticate,
    authorize({ roles: CATALOG_ROLES, deferToService: true }),
    validate('params', productIdParams),
    controller.remove,
  );

  return router;
}
