import type { ErrorRequestHandler } from 'express';

import { AppError, toAppError } from '../core/errors';
import { errorEnvelope } from '../core/http/envelope';

/** C1, registered last. Every error body is the envelope { error: { code, message, details? } } (ADR-021, 3.0.0). */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const appError = toAppError(err);
  // pino-http writes one line per request on completion; attach the cause unless it is an expected 4xx AppError.
  if (!(err instanceof AppError) || appError.status >= 500) res.err = err instanceof Error ? err : appError;
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(appError.status).json(errorEnvelope(appError)); // 3.0.0: was res.json({ msg: appError.message })
};
