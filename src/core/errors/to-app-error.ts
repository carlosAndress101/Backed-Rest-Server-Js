import { AppError, BadRequestError, ConflictError, InternalError, PayloadTooLargeError } from './app-error';

type ErrorLike = { name?: unknown; code?: unknown; status?: unknown; expose?: unknown };
const asErrorLike = (err: unknown): ErrorLike => (typeof err === 'object' && err !== null ? err : {});

/** A 4xx raised by the HTTP layer: body-parser (http-errors, `expose`) or Express URL decoding (URIError). */
const httpClientStatus = (err: unknown): number | undefined => {
  const { status, expose } = asErrorLike(err);
  const isClientError = typeof status === 'number' && status >= 400 && status < 500;
  return isClientError && (expose === true || err instanceof URIError) ? status : undefined;
};

/**
 * The M1 C1 mapping: every failure that reaches the error handler becomes an AppError. The one change is
 * body-parser's 413, which has its own code, PAYLOAD_TOO_LARGE, in 3.0.0 (AM-M3-10).
 * Duck-typed, so it works across Mongoose instances and keeps core/ free of a Mongoose import.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const clientStatus = httpClientStatus(err);
  if (clientStatus === 413) return new PayloadTooLargeError(undefined, err);
  if (clientStatus !== undefined)
    return new AppError(clientStatus, 'BAD_REQUEST', 'Invalid request data', { cause: err });
  const { code, name } = asErrorLike(err);
  if (code === 11000) return new ConflictError(undefined, err);
  if (name === 'ValidationError' || name === 'CastError') return new BadRequestError(undefined, err);
  return new InternalError(err);
}
