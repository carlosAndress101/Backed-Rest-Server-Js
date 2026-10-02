import { Router, type RequestHandler } from 'express';

import { authorize } from '../../middlewares/authorize';
import type { SearchController } from './search.controller';

export interface SearchRouteDeps {
  controller: SearchController;
  authenticate: RequestHandler;
}

// C8/SEC-05: only the user collection is private. The check reads the DECODED :collection param, so an
// encoded variant (GET /api/search/us%65r/x) cannot skip it. A literal '/user/:term' route could be skipped.
const forUserSearch =
  (guard: RequestHandler): RequestHandler =>
  (req, res, next) =>
    req.params.collection === 'user' ? guard(req, res, next) : next();

/**
 * Paths and middleware only. Auth runs before the collection check, so `GET /api/search/role/x` with no
 * token is 400 (the legacy order). The policy is declared here, next to the path it protects (ADR-038).
 */
export function createSearchRouter(deps: SearchRouteDeps): Router {
  const { controller, authenticate } = deps;
  const router = Router();

  router.get(
    '/:collection/:term',
    forUserSearch(authenticate),
    forUserSearch(authorize({ roles: ['ADMIN_ROLE'] })),
    controller.search,
  );

  return router;
}
