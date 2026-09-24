import type { Response } from 'supertest';
import { expect } from 'vitest';

/**
 * Asserts a response status. On a mismatch the diff also prints the response
 * body (which 401 fired, or whose), so an unexpected status is diagnosable from a
 * single failing run.
 */
export const expectStatus = (res: Response, status: number) =>
  expect({ status: res.statusCode, body: res.body }).toEqual({ status, body: res.body });
