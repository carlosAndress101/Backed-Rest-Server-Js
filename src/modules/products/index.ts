import type { RequestHandler, Router } from 'express';

import { createProductsController } from './product.controller';
import { ProductModel } from './product.model';
import { createProductsRouter } from './product.routes';
import { createProductsService, type CategoryLookup } from './product.service';

// The module's public surface: its router factory, and its model for cross-module readers (ADR-027).
export { ProductModel, type Product, type ProductDocument } from './product.model';

export interface ProductsModuleDeps {
  /** The categories model, injected by the composition root (§2.3 rule 4). */
  Category: CategoryLookup;
  authenticate: RequestHandler;
}

/** P15: model → service → controller → router. src/app.ts mounts the result at /api/product. */
export function productsModule(deps: ProductsModuleDeps): Router {
  const service = createProductsService({ Product: ProductModel, Category: deps.Category });
  return createProductsRouter({
    controller: createProductsController(service),
    authenticate: deps.authenticate,
  });
}
