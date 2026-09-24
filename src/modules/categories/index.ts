import type { RequestHandler, Router } from 'express';

import { createCategoriesController } from './category.controller';
import { CategoryModel } from './category.model';
import { createCategoriesRouter } from './category.routes';
import { createCategoriesService } from './category.service';

// The module's public surface: its router factory, and its model for cross-module readers (ADR-027).
export { CategoryModel, type Category, type CategoryDocument } from './category.model';

export interface CategoriesModuleDeps {
  authenticate: RequestHandler;
}

/** P15: model → service → controller → router. src/app.ts mounts the result at /api/category. */
export function categoriesModule(deps: CategoriesModuleDeps): Router {
  const service = createCategoriesService({ Category: CategoryModel });
  return createCategoriesRouter({
    controller: createCategoriesController(service),
    authenticate: deps.authenticate,
  });
}
