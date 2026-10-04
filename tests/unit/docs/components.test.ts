// The docs-only response components (Decision 5): one registry conversion, real $refs, no stray keys.
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { z } from 'zod';

import type { ErrorEnvelope as ErrorEnvelopeContract } from '../../../src/core/http/envelope';
import { BEARER_SCHEME, componentSchemas, ErrorEnvelope } from '../../../src/docs/components';
import { ERROR_CODES } from '../../../src/docs/error-catalog';

const PREFIX = '#/components/schemas/';

/** Visits every key and its value in `node`, depth-first. */
const walk = (node: unknown, visit: (key: string, value: unknown) => void): void => {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      visit(key, value);
      walk(value, visit);
    }
  }
};

describe('componentSchemas()', () => {
  const schemas = componentSchemas();

  test('converts exactly the eight components', () => {
    expect(Object.keys(schemas).sort()).toEqual(
      [
        'Category',
        'ErrorEnvelope',
        'PageMeta',
        'Product',
        'Session',
        'TokenGrant',
        'User',
        'ValidationIssue',
      ].sort(),
    );
  });

  test('every $ref resolves under components.schemas, and the shared ones are real refs', () => {
    const refs: string[] = [];
    walk(schemas, (key, value) => {
      if (key === '$ref') refs.push(value as string);
    });

    expect(refs).toEqual(expect.arrayContaining([`${PREFIX}User`, `${PREFIX}ValidationIssue`]));
    for (const ref of refs) {
      expect(ref.startsWith(PREFIX)).toBe(true);
      expect(Object.keys(schemas)).toContain(ref.slice(PREFIX.length));
    }
  });

  test('no $id, $schema, $defs or __shared key remains', () => {
    const keys = new Set<string>();
    walk(schemas, (key) => keys.add(key));

    for (const stray of ['$id', '$schema', '$defs', '__shared']) expect(keys.has(stray)).toBe(false);
  });

  test("ErrorEnvelope's code enum is ERROR_CODES, in order", () => {
    const error = (
      schemas.ErrorEnvelope.properties as Record<string, { properties: Record<string, unknown> }>
    ).error;

    expect(error?.properties.code).toEqual({ type: 'string', enum: ERROR_CODES });
  });

  test("User's uid is marked deprecated", () => {
    const properties = schemas.User.properties as Record<string, Record<string, unknown>>;

    expect(properties.uid).toMatchObject({ type: 'string', deprecated: true });
  });
});

describe('ErrorEnvelope', () => {
  test('its output type is assignable to the envelope the error handler sends', () => {
    expectTypeOf<z.output<typeof ErrorEnvelope>>().toExtend<ErrorEnvelopeContract>();
  });
});

describe('BEARER_SCHEME', () => {
  test('is HTTP bearer with a JWT, and names the deprecated x-token fallback', () => {
    expect(BEARER_SCHEME).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(BEARER_SCHEME.description).toContain('x-token');
    expect(BEARER_SCHEME.description).toContain('Deprecation: true');
    expect(BEARER_SCHEME.description).toContain('4.0.0');
  });
});
