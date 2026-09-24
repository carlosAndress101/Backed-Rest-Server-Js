import type { RequestHandler, Router } from 'express';

import { createSearchController } from './search.controller';
import { createSearchRouter } from './search.routes';
import { createSearchService, type SearchableModel } from './search.service';

export interface SearchModuleDeps {
  /** The three owning modules' models, injected by the composition root (§2.3 rule 4). */
  User: SearchableModel;
  Category: SearchableModel;
  Product: SearchableModel;
  authenticate: RequestHandler;
}

/** P15: service → controller → router, over the three injected models. src/app.ts mounts it at /api/search. */
export function searchModule(deps: SearchModuleDeps): Router {
  const service = createSearchService({
    User: deps.User,
    Category: deps.Category,
    Product: deps.Product,
  });
  return createSearchRouter({
    controller: createSearchController(service),
    authenticate: deps.authenticate,
  });
}
