export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** An error whose status and message are safe to send to the client. */
export class AppError extends Error {
  readonly details: readonly ValidationIssue[] | undefined;
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    options: { cause?: unknown; details?: readonly ValidationIssue[] } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.details = options.details;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Invalid request data', cause?: unknown) {
    super(400, 'BAD_REQUEST', message, { cause });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists', cause?: unknown) {
    super(409, 'CONFLICT', message, { cause });
  }
}

export class ValidationError extends AppError {
  constructor(details: readonly ValidationIssue[], message = 'Validation failed') {
    super(422, 'VALIDATION_FAILED', message, { details });
  }
}

/** The auth limiter's 429 (C5), so its body is the envelope too (M3 §5.2). */
export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests, please try again later') {
    super(429, 'RATE_LIMITED', message);
  }
}

export class InternalError extends AppError {
  constructor(cause?: unknown) {
    super(500, 'INTERNAL', 'Internal server error', { cause });
  }
}
