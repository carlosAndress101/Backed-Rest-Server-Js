import { describe, expect, test } from 'vitest';

import { InternalError, NotFoundError, ValidationError } from '../../src/core/errors';
import { envelope, errorEnvelope, pageEnvelope } from '../../src/core/http/envelope';

describe('response envelopes', () => {
  test('envelope wraps a value in data', () => {
    const category = { uid: '1', name: 'COFFEE' };

    expect(envelope(category)).toEqual({ data: category });
    expect(envelope(null)).toEqual({ data: null });
  });

  test('pageEnvelope carries the items and the page metadata', () => {
    const items = [{ name: 'A' }, { name: 'B' }];

    expect(pageEnvelope(items, { total: 12, limit: 2, offset: 4 })).toEqual({
      data: items,
      meta: { total: 12, limit: 2, offset: 4 },
    });
    expect(pageEnvelope([], { total: 0, limit: 5, offset: 0 })).toEqual({
      data: [],
      meta: { total: 0, limit: 5, offset: 0 },
    });
  });

  test('errorEnvelope carries code and message, and omits details when absent', () => {
    const body = errorEnvelope(new NotFoundError('Route not found'));

    expect(body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    expect('details' in body.error).toBe(false);
    expect(JSON.stringify(body)).toBe('{"error":{"code":"NOT_FOUND","message":"Route not found"}}');
  });

  test('errorEnvelope includes validation details', () => {
    const details = [
      { path: 'name', message: 'Required' },
      { path: 'price', message: 'Must be positive' },
    ];

    expect(errorEnvelope(new ValidationError(details))).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Validation failed', details },
    });
  });

  test('errorEnvelope exposes only the safe message, never the cause', () => {
    const body = errorEnvelope(new InternalError(new Error('connection refused to 10.0.0.5')));

    expect(body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });
});
