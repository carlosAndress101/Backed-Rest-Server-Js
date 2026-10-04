// The error catalog (Decision 5): every documented status is the status the real error class answers.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  type AppError,
  BadRequestError,
  ConflictError,
  type ErrorCode,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from '../../../src/core/errors';
import { ERROR_CATALOG, ERROR_CODES } from '../../../src/docs/error-catalog';

const INSTANCES: Record<ErrorCode, AppError> = {
  BAD_REQUEST: new BadRequestError(),
  UNAUTHORIZED: new UnauthorizedError(),
  FORBIDDEN: new ForbiddenError(),
  NOT_FOUND: new NotFoundError(),
  CONFLICT: new ConflictError(),
  PAYLOAD_TOO_LARGE: new PayloadTooLargeError(),
  VALIDATION_FAILED: new ValidationError([]),
  RATE_LIMITED: new RateLimitedError(),
  INTERNAL: new InternalError(),
};

/** The ErrorCode union as app-error.ts declares it, in its declared order. */
const declaredCodes = (): string[] => {
  const source = readFileSync(path.join(__dirname, '../../../src/core/errors/app-error.ts'), 'utf8');
  const union = /export type ErrorCode =([^;]+);/.exec(source)?.[1] ?? '';
  return [...union.matchAll(/'([A-Z_]+)'/g)].flatMap(([, code]) => (code ? [code] : []));
};

describe('ERROR_CATALOG', () => {
  test.each(Object.entries(INSTANCES))('%s documents the status its class answers', (code, error) => {
    expect(error.code).toBe(code);
    expect(ERROR_CATALOG[code as ErrorCode].status).toBe(error.status);
  });

  test('every entry has a summary', () => {
    for (const { summary } of Object.values(ERROR_CATALOG)) expect(summary.length).toBeGreaterThan(0);
  });
});

describe('ERROR_CODES', () => {
  test("equals the 9 codes in app-error.ts's declared order", () => {
    const codes = declaredCodes();

    expect(codes).toHaveLength(9);
    expect(ERROR_CODES).toEqual(codes);
  });
});
