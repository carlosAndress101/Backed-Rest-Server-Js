import type { ErrorRequestHandler } from 'express';

import { AppError, toAppError } from '../core/errors';

/** C1, registered last. The body is `{ msg }` until M3 switches to the envelope (ADR-021). */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const appError = toAppError(err);
  // pino-http writes one line per request on completion; attach the cause unless it is an expected 4xx AppError.
  if (!(err instanceof AppError) || appError.status >= 500) res.err = err instanceof Error ? err : appError;
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(appError.status).json({ msg: appError.message });
};
