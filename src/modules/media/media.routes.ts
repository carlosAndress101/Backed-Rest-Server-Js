import { Router, type RequestHandler } from 'express';

import { authorize } from '../../middlewares/authorize';
import { CATALOG_ROLES } from '../../core/security/roles';
import { validate } from '../../middlewares/validate';
import type { MediaController } from './media.controller';
import { mediaParams } from './media.schemas';
import { fileParser, requireImage } from './media.upload';

export interface MediaRouteDeps {
  controller: MediaController;
  authenticate: RequestHandler;
}

/**
 * SEC-03 / C7: a user's image is owner-or-admin; every other collection is CATALOG_ROLES (fail closed), so a
 * product whose _id equals the caller's user id grants nothing (T1.2). ADR-041 does not extend ownership to
 * media: a product's creator does not get its image replacement, only ADMIN_ROLE/VENTAS_ROLE do.
 */
const authorizeCollection: RequestHandler = (req, res, next) => {
  const policy =
    req.params.collection === 'user'
      ? { roles: ['ADMIN_ROLE'] as const, selfParam: 'id' }
      : { roles: CATALOG_ROLES };
  authorize(policy)(req, res, next);
};

/** Paths, middleware and handlers only. C10: the multipart parser runs last, after auth → authz → validate. */
export function createMediaRouter(deps: MediaRouteDeps): Router {
  const { controller, authenticate } = deps;
  const router = Router();

  router.put(
    '/:collection/:id',
    authenticate,
    authorizeCollection,
    validate('params', mediaParams),
    fileParser,
    requireImage,
    controller.replaceImage,
  );
  router.get('/:collection/:id', validate('params', mediaParams), controller.showImage);

  return router;
}
