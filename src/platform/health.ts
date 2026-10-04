import { Router } from 'express';

import { AppError } from '../core/errors';
import { envelope } from '../core/http/envelope';

export interface ReadyDeps {
  /** Injected so the not-ready path is testable without touching the database (ADR-023). */
  readonly checkDb: () => Promise<void>;
}

/**
 * Liveness: answers 200 whenever the process serves. Mounted at `/health` (matrix #28).
 * No database touch, no auth, no limiter — orchestrators must reach it even when dependencies fail.
 */
export function healthRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(envelope({ status: 'ok' }));
  });
  return router;
}

/**
 * Readiness: a real dependency check. Mounted at `/ready` (matrix #29). A failed `checkDb`
 * answers 500 INTERNAL through the standard envelope (M9 D1): any non-2xx reads as not-ready,
 * and no new ErrorCode or status enters the catalog.
 */
export function readyRouter({ checkDb }: ReadyDeps): Router {
  const router = Router();
  router.get('/', (_req, res, next) => {
    checkDb().then(
      () => {
        res.json(envelope({ status: 'ok' }));
      },
      () => {
        next(new AppError(500, 'INTERNAL', 'Database not ready'));
      },
    );
  });
  return router;
}
