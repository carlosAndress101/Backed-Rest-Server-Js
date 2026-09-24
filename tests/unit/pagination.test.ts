// P12 (M3 design §3.4): one pagination query schema for every list route (DUP-01).
import { describe, expect, test } from 'vitest';

import { paginationQuerySchema } from '../../src/core/http/pagination';

describe('paginationQuerySchema', () => {
  test('defaults to limit 5, offset 0', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 5, offset: 0 });
  });

  test('coerces the query strings to integers and drops unknown keys', () => {
    expect(paginationQuerySchema.parse({ limit: '12', offset: '30', sort: 'name' })).toEqual({
      limit: 12,
      offset: 30,
    });
  });

  test.each([
    [{ limit: '1' }, { limit: 1, offset: 0 }],
    [{ limit: '50' }, { limit: 50, offset: 0 }],
    [{ offset: '0' }, { limit: 5, offset: 0 }],
  ])('accepts the bounds: %o', (query, parsed) => {
    expect(paginationQuerySchema.parse(query)).toEqual(parsed);
  });

  test.each([
    ['limit', { limit: '0' }],
    ['limit', { limit: '51' }],
    ['limit', { limit: '2.5' }],
    ['limit', { limit: 'ten' }],
    ['offset', { offset: '-1' }],
    ['offset', { offset: '1.5' }],
    ['offset', { offset: 'abc' }],
  ])('rejects %s in %o', (field, query) => {
    const result = paginationQuerySchema.safeParse(query);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([[field]]);
  });
});
