// The operation catalog's drift guards (Decision 5): the catalog is checked against the permission matrix (ADR-044's
// single source of the live routes), every module DTO, the error catalog and package.json. All fail closed.
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';

import { ERROR_CATALOG } from '../../../src/docs/error-catalog';
import { API_VERSION, type ApiOperation, buildOpenApiDocument } from '../../../src/docs/openapi';
import { API_OPERATIONS, imageUpload, searchParams } from '../../../src/docs/operations';
import { SEARCH_COLLECTIONS } from '../../../src/modules/search/search.service';
import { collectRefs, pathParams, resolvePointer } from '../../helpers/openapi';
import { MATRIX, type MatrixRow } from '../../helpers/permission-matrix';

const ROOT = path.join(__dirname, '../../..');

/** `GET /api/category/{id}` → `get /api/category/:id`, the matrix's spelling. */
const pairOf = (op: Pick<ApiOperation, 'method' | 'path'>) =>
  `${op.method} ${op.path.replace(/\{([^}]+)\}/g, ':$1')}`;
const API_ROWS = MATRIX.filter((row) => row.path.startsWith('/api/'));
const rowsOf = (op: ApiOperation): MatrixRow[] =>
  API_ROWS.filter((row) => `${row.method} ${row.path}` === pairOf(op));
const statusesOf = (op: ApiOperation) =>
  new Set(rowsOf(op).flatMap((row) => row.cases.map(({ status }) => status)));
const errorStatuses = (op: ApiOperation) =>
  new Set<number>([...op.errors, 'INTERNAL' as const].map((c) => ERROR_CATALOG[c].status));
const requestSchemas = (op: ApiOperation): z.ZodType[] =>
  [op.params, op.query, op.body?.schema].filter((schema): schema is z.ZodType => schema !== undefined);

/** Every zod schema exported by a src/modules/<module>/<module>.schemas.ts file, by file. */
let moduleDtos: Map<z.ZodType, string>;

beforeAll(async () => {
  moduleDtos = new Map();
  for (const file of globSync('src/modules/*/*.schemas.ts', { cwd: ROOT }).sort()) {
    const exports = (await import(path.join(ROOT, file))) as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      if (value instanceof z.ZodType && !moduleDtos.has(value)) moduleDtos.set(value, `${file}#${name}`);
    }
  }
});

describe('API_OPERATIONS against the live routes (the permission matrix)', () => {
  test('has 21 operations, one per (method, path) of the matrix under /api/', () => {
    const documented = API_OPERATIONS.map(pairOf);
    const live = [...new Set(API_ROWS.map((row) => `${row.method} ${row.path}`))];

    // The set differences first, so a failure names the route.
    expect(
      live.filter((pair) => !documented.includes(pair)),
      'live routes with no catalog entry',
    ).toEqual([]);
    expect(
      documented.filter((pair) => !live.includes(pair)),
      'catalog entries with no live route',
    ).toEqual([]);
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented).toHaveLength(21);
  });

  test.each(API_OPERATIONS.map((op) => [op.operationId, op] as const))(
    '%s: security follows the anonymous cells of its matrix rows',
    (_id, op) => {
      const anonymousSucceeds = rowsOf(op).map((row) =>
        row.cases.some(({ caller, status }) => caller === 'anonymous' && status < 400),
      );
      const expected = anonymousSucceeds.every(Boolean)
        ? 'none'
        : anonymousSucceeds.some(Boolean)
          ? 'optional'
          : 'bearer';

      expect(op.security).toBe(expected);
    },
  );

  test.each(API_OPERATIONS.map((op) => [op.operationId, op] as const))(
    '%s: every 2xx/3xx of the matrix is the documented success, and every 4xx is a documented error',
    (_id, op) => {
      const statuses = [...statusesOf(op)];

      for (const status of statuses.filter((s) => s < 400)) expect(status).toBe(op.success.status);
      const documented = errorStatuses(op);
      expect(
        statuses.filter((s) => s >= 400 && !documented.has(s)),
        'undocumented 4xx cells',
      ).toEqual([]);
    },
  );
});

describe('API_OPERATIONS against the module DTOs', () => {
  test.each(API_OPERATIONS.map((op) => [op.operationId, op] as const))(
    '%s: VALIDATION_FAILED is documented if and only if a request schema is a module export',
    (_id, op) => {
      const validated = requestSchemas(op).some((schema) => moduleDtos.has(schema));

      expect(op.errors.includes('VALIDATION_FAILED')).toBe(validated);
    },
  );

  test('every zod schema a module exports is wired into some operation', () => {
    const referenced = new Set(API_OPERATIONS.flatMap(requestSchemas));

    expect(moduleDtos.size).toBeGreaterThan(0);
    expect(
      [...moduleDtos].filter(([schema]) => !referenced.has(schema)).map(([, name]) => name),
      'module DTOs no operation references',
    ).toEqual([]);
  });

  test('the two documentation-only schemas are not module exports, so they promise no 422', () => {
    expect(moduleDtos.has(searchParams)).toBe(false);
    expect(moduleDtos.has(imageUpload)).toBe(false);
  });
});

describe('API_OPERATIONS: transport errors', () => {
  test.each(API_OPERATIONS.map((op) => [op.operationId, op] as const))(
    '%s documents the generic failures of its transport',
    (_id, op) => {
      if (op.body?.mediaType === 'application/json') {
        expect(op.errors).toEqual(expect.arrayContaining(['BAD_REQUEST', 'PAYLOAD_TOO_LARGE']));
      }
      if (op.params) expect(op.errors).toContain('BAD_REQUEST');
    },
  );
});

describe('the real document', () => {
  const document = buildOpenApiDocument(API_OPERATIONS);
  const json = JSON.parse(JSON.stringify(document));

  test('documents the search collection from SEARCH_COLLECTIONS, with the 400 for an unknown one (D4)', () => {
    const search = json.paths['/api/search/{collection}/{term}'].get;
    const collection = search.parameters.find(
      (parameter: { name: string }) => parameter.name === 'collection',
    );

    expect(collection.schema.enum).toEqual([...SEARCH_COLLECTIONS]);
    expect(search.responses[400]).toEqual({ $ref: '#/components/responses/BAD_REQUEST' });
  });

  test("info.version is API_VERSION, which is package.json's version", () => {
    const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };

    expect(API_VERSION).toBe(version);
    expect(document.info.version).toBe(version);
  });

  test('is OpenAPI 3.1', () => {
    expect(document.openapi).toMatch(/^3\.1\.\d+$/);
  });

  test('every $ref resolves under components', () => {
    const refs = collectRefs(json);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/')).toBe(true);
      expect(resolvePointer(json, ref), ref).toBeDefined();
    }
  });

  test('every operationId is unique, one per catalog entry', () => {
    const ids = Object.values(json.paths).flatMap((item) =>
      Object.values(item as Record<string, { operationId: string }>).map((op) => op.operationId),
    );

    expect(ids).toHaveLength(API_OPERATIONS.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every {param} of a path template has a required in: path parameter', () => {
    for (const [template, item] of Object.entries(json.paths)) {
      for (const op of Object.values(
        item as Record<string, { parameters?: { name: string; in: string; required: boolean }[] }>,
      )) {
        const inPath = (op.parameters ?? []).filter((parameter) => parameter.in === 'path');
        expect(inPath.map(({ name }) => name).sort()).toEqual(pathParams(template).sort());
        for (const parameter of inPath) expect(parameter.required).toBe(true);
      }
    }
  });
});
