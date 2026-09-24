import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { RateLimitedError } from '../../core/errors';
import { validate } from '../../middlewares/validate';
import type { AuthController } from './auth.controller';
import { googleBody, loginBody } from './auth.schemas';

export interface AuthRouteDeps {
  controller: AuthController;
}

// C5 / SEC-07: 10 sign-in requests per client IP per 15 minutes, across the whole auth surface.
const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 10;

/** Paths, middleware and handlers only. The order is the legacy chain's: limiter → validate → controller. */
export function createAuthRouter(deps: AuthRouteDeps): Router {
  const { controller } = deps;
  const router = Router();

  // One limiter for both routes, so /login and /google spend one budget. It runs before validation, so a malformed
  // request counts too. It keys on req.ip, which config.trustProxy resolves behind a proxy (C9).
  const limiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new RateLimitedError()), // the 429 body is the envelope (M3 §5.2)
  });

  router.post('/login', limiter, validate('body', loginBody), controller.login);
  router.post('/google', limiter, validate('body', googleBody), controller.googleSignIn);

  return router;
}
