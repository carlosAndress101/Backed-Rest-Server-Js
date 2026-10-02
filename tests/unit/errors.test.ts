import mongoose from 'mongoose';
import { describe, expect, test } from 'vitest';

import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
  toAppError,
  type ErrorCode,
} from '../../src/core/errors';

/** The only messages a non-AppError can ever produce: nothing from the original error reaches the client. */
const FIXED_MESSAGES = [
  'Invalid request data',
  'Payload too large',
  'Resource already exists',
  'Internal server error',
];

/** Shaped like body-parser's http-errors: a client error it marks safe to expose. */
const bodyParserError = (status: number) =>
  Object.assign(new SyntaxError('Unexpected token } in JSON at position 9'), {
    status,
    statusCode: status,
    expose: true,
    type: 'entity.parse.failed',
  });

/** Shaped like Express's path-parameter decoding failure. */
const uriError = (status?: number) =>
  Object.assign(new URIError("Failed to decode param '%E0%A4%A'"), status === undefined ? {} : { status });

type Row = readonly [label: string, input: () => unknown, status: number, code: ErrorCode, message: string];

// §4.3 mapping table, row by row. Each input must come out as the M1 C1 response, never a raw message.
const C1_ROWS: readonly Row[] = [
  // T1.3 client-error branch: the error's own 4xx
  [
    'body-parser 400 (malformed JSON)',
    () => bodyParserError(400),
    400,
    'BAD_REQUEST',
    'Invalid request data',
  ],
  // AM-M3-10: a 413 has its own code in 3.0.0
  [
    'body-parser 413 (JSON > 100 kb)',
    () => bodyParserError(413),
    413,
    'PAYLOAD_TOO_LARGE',
    'Payload too large',
  ],
  ['body-parser 415 (bad charset)', () => bodyParserError(415), 415, 'BAD_REQUEST', 'Invalid request data'],
  [
    'URIError with status 400 (bad % escape)',
    () => uriError(400),
    400,
    'BAD_REQUEST',
    'Invalid request data',
  ],
  // duplicate key
  ['{ code: 11000 }', () => ({ code: 11000 }), 409, 'CONFLICT', 'Resource already exists'],
  [
    'a real MongoServerError 11000',
    () => new mongoose.mongo.MongoServerError({ message: 'E11000 duplicate key error', code: 11000 }),
    409,
    'CONFLICT',
    'Resource already exists',
  ],
  // Mongoose validation and cast errors
  [
    'a real Mongoose ValidationError',
    () => new mongoose.Error.ValidationError(),
    400,
    'BAD_REQUEST',
    'Invalid request data',
  ],
  [
    'a real Mongoose CastError',
    () => new mongoose.Error.CastError('ObjectId', 'not-an-id', '_id'),
    400,
    'BAD_REQUEST',
    'Invalid request data',
  ],
  // everything else is a 500
  ['{ status: 404 } without expose', () => ({ status: 404 }), 500, 'INTERNAL', 'Internal server error'],
  [
    '{ status: 400, expose: false }',
    () => ({ status: 400, expose: false }),
    500,
    'INTERNAL',
    'Internal server error',
  ],
  [
    '{ status: 413, expose: false }',
    () => ({ status: 413, expose: false }),
    500,
    'INTERNAL',
    'Internal server error',
  ],
  [
    '{ status: 500, expose: true }',
    () => ({ status: 500, expose: true }),
    500,
    'INTERNAL',
    'Internal server error',
  ],
  ['URIError without a status', () => uriError(), 500, 'INTERNAL', 'Internal server error'],
  // Orchestrator decision: no C1 amendment A2, multipart parse errors stay 500 in M2
  [
    'a busboy multipart parse error',
    () => new Error('Unexpected end of form'),
    500,
    'INTERNAL',
    'Internal server error',
  ],
  ["{ code: '11000' } (not the number)", () => ({ code: '11000' }), 500, 'INTERNAL', 'Internal server error'],
  ['a plain Error', () => new Error('database is down'), 500, 'INTERNAL', 'Internal server error'],
  ['a thrown string', () => 'boom', 500, 'INTERNAL', 'Internal server error'],
  ['a thrown number', () => 42, 500, 'INTERNAL', 'Internal server error'],
  ['null', () => null, 500, 'INTERNAL', 'Internal server error'],
  ['undefined', () => undefined, 500, 'INTERNAL', 'Internal server error'],
];

describe('toAppError reproduces the M1 C1 mapping', () => {
  test.each(C1_ROWS)('%s → %i', (_label, input, status, code, message) => {
    const err = input();

    const appError = toAppError(err);

    expect(appError).toBeInstanceOf(AppError);
    expect(appError.status).toBe(status);
    expect(appError.code).toBe(code);
    expect(appError.message).toBe(message);
    expect(FIXED_MESSAGES).toContain(appError.message);
    // The original is kept as the cause, for the log line; it is never sent.
    expect(appError.cause).toBe(err);
  });

  test('the mapped classes match the §4.3 table', () => {
    expect(toAppError(bodyParserError(413))).toBeInstanceOf(PayloadTooLargeError);
    expect(toAppError({ code: 11000 })).toBeInstanceOf(ConflictError);
    expect(toAppError(new mongoose.Error.CastError('ObjectId', 'x', '_id'))).toBeInstanceOf(BadRequestError);
    expect(toAppError(new Error('boom'))).toBeInstanceOf(InternalError);
  });

  test.each([
    new BadRequestError(),
    new UnauthorizedError(),
    new ForbiddenError('Not the owner'),
    new NotFoundError('Route not found'),
    new ConflictError(),
    new PayloadTooLargeError('The file is larger than 5 MB'),
    new ValidationError([{ path: 'name', message: 'Required' }]),
    new InternalError(new Error('cause')),
    new AppError(418, 'BAD_REQUEST', 'custom'),
  ])('an AppError passes through unchanged: %s', (appError) => {
    expect(toAppError(appError)).toBe(appError);
  });
});

describe('the AppError hierarchy', () => {
  test.each([
    [BadRequestError, () => new BadRequestError(), 400, 'BAD_REQUEST', 'Invalid request data'],
    [UnauthorizedError, () => new UnauthorizedError(), 401, 'UNAUTHORIZED', 'Unauthorized'],
    [ForbiddenError, () => new ForbiddenError(), 403, 'FORBIDDEN', 'Forbidden'],
    [NotFoundError, () => new NotFoundError(), 404, 'NOT_FOUND', 'Resource not found'],
    [ConflictError, () => new ConflictError(), 409, 'CONFLICT', 'Resource already exists'],
    [PayloadTooLargeError, () => new PayloadTooLargeError(), 413, 'PAYLOAD_TOO_LARGE', 'Payload too large'],
    [ValidationError, () => new ValidationError([]), 422, 'VALIDATION_FAILED', 'Validation failed'],
    [InternalError, () => new InternalError(), 500, 'INTERNAL', 'Internal server error'],
  ] as const)('%o: status, code, default message and name', (errorClass, create, status, code, message) => {
    const appError = create();

    expect(appError).toBeInstanceOf(errorClass);
    expect(appError).toBeInstanceOf(AppError);
    expect(appError).toBeInstanceOf(Error);
    expect(appError.status).toBe(status);
    expect(appError.code).toBe(code);
    expect(appError.message).toBe(message);
    expect(appError.name).toBe(errorClass.name);
    expect(appError.stack).toContain(errorClass.name);
  });

  test('messages can be overridden, except for InternalError', () => {
    expect(new BadRequestError('Bad id').message).toBe('Bad id');
    expect(new UnauthorizedError('Token expired').message).toBe('Token expired');
    expect(new ForbiddenError('Not the owner').message).toBe('Not the owner');
    expect(new NotFoundError('Route not found').message).toBe('Route not found');
    expect(new ConflictError('Email taken').message).toBe('Email taken');
    expect(new PayloadTooLargeError('The file is larger than 5 MB').message).toBe(
      'The file is larger than 5 MB',
    );
    expect(new ValidationError([], 'Invalid body').message).toBe('Invalid body');
    expect(new InternalError(new Error('secret detail')).message).toBe('Internal server error');
  });

  test('causes are kept where the class accepts one', () => {
    const cause = new Error('original');

    expect(new BadRequestError(undefined, cause).cause).toBe(cause);
    expect(new ConflictError(undefined, cause).cause).toBe(cause);
    expect(new PayloadTooLargeError(undefined, cause).cause).toBe(cause);
    expect(new InternalError(cause).cause).toBe(cause);
    expect(new AppError(400, 'BAD_REQUEST', 'x', { cause }).cause).toBe(cause);
  });

  test('only ValidationError carries details', () => {
    const details = [{ path: 'email', message: 'Invalid email' }];

    expect(new ValidationError(details).details).toBe(details);
    expect(new BadRequestError().details).toBeUndefined();
    expect(new AppError(400, 'BAD_REQUEST', 'x').details).toBeUndefined();
  });

  test('the base class is named AppError', () => {
    expect(new AppError(400, 'BAD_REQUEST', 'x').name).toBe('AppError');
  });
});

describe('RateLimitedError (M3 §5.2)', () => {
  test('is a 429 RATE_LIMITED with the legacy limiter message by default', () => {
    const appError = new RateLimitedError();

    expect(appError).toBeInstanceOf(AppError);
    expect(appError.status).toBe(429);
    expect(appError.code).toBe('RATE_LIMITED');
    expect(appError.message).toBe('Too many requests, please try again later');
    expect(appError.name).toBe('RateLimitedError');
    expect(appError.details).toBeUndefined();
  });

  test('passes through toAppError unchanged, with an overridable message', () => {
    const appError = new RateLimitedError('Slow down');

    expect(appError.message).toBe('Slow down');
    expect(toAppError(appError)).toBe(appError);
  });
});
