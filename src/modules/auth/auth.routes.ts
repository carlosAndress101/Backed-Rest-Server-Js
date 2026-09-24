import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { RateLimitedError } from '../../core/errors';
import { validate } from '../../middlewares/validate';
import type { AuthController } from './auth.controller';
import { googleBody, loginBody, passwordChangeBody } from './auth.schemas';

export interface AuthRouteDeps {
  controller: AuthController;
  /** The one src/app.ts builds (ADR-028/032): logout-all and the password change act on the caller. */
  authenticate: RequestHandler;
}

// C5 / SEC-07: 10 sign-in requests per client IP per 15 minutes, across the whole auth surface; and, ADR-037, 10 login
// attempts per account per 15 minutes, whatever IPs they come from.
const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 10;

/**
 * P28: the account a login targets, normalized exactly as the DTO normalizes it (trimmed, lowercased) but read here,
 * before validate runs, so neither case, padding nor an otherwise invalid body opens a fresh budget. A body with no
 * string email has no account: validate refuses it (422) before any password is checked.
 */
const loginAccount = (body: unknown): string | undefined => {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : undefined;
};

/** Paths, middleware and handlers only. The order is the legacy chain's: limiter → validate → controller. */
export function createAuthRouter(deps: AuthRouteDeps): Router {
  const { controller, authenticate } = deps;
  const router = Router();

  // One limiter for both routes, so /login and /google spend one budget. It runs before validation, so a malformed
  // request counts too. It keys on req.ip, which config.trustProxy resolves behind a proxy (C9).
  const handler: RequestHandler = (_req, _res, next) => next(new RateLimitedError()); // the envelope (M3 §5.2)
  const limiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler,
  });
  // ADR-037: the same numbers and the same 429 body, keyed on the account instead of the client. It sends no
  // RateLimit headers of its own: they would tell anyone how many attempts an account has had.
  const accountLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: LIMIT,
    standardHeaders: false,
    legacyHeaders: false,
    handler,
    keyGenerator: (req) => `account:${loginAccount(req.body)}`,
    skip: (req) => loginAccount(req.body) === undefined,
  });

  // Both before validate, so a malformed attempt costs budget too. /google has no account limiter: its account is
  // only known once Google has verified the token (ADR-037).
  router.post('/login', limiter, accountLimiter, validate('body', loginBody), controller.login);
  router.post('/google', limiter, validate('body', googleBody), controller.googleSignIn);
  router.post('/logout-all', authenticate, controller.logoutAll);
  // Not throttled in M5 (AM-M5-5): the caller already holds a valid token, and the check is F1-flat.
  router.put('/password', authenticate, validate('body', passwordChangeBody), controller.changePassword);

  return router;
}
