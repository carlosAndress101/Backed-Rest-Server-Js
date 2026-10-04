// The OpenAPI builder (Decision 5), on synthetic operations that exercise every mapping branch and invariant.
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { BEARER_SCHEME } from '../../../src/docs/components';
import { ERROR_CODES } from '../../../src/docs/error-catalog';
import {
  API_VERSION,
  type ApiOperation,
  buildOpenApiDocument,
  type OpenApiDocument,
  toJsonSchema,
} from '../../../src/docs/openapi';
import { loginBody } from '../../../src/modules/auth/auth.schemas';
import { collectRefs, pathParams, resolvePointer } from '../../helpers/openapi';

/** A value as plain, untyped JSON, the way a client reads it (and proof that it serializes). */
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value));

const idParams = z.object({ id: z.string().describe('The thing id') });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(5),
  q: z.string().optional(),
  mode: z.enum(['short', 'long']),
});
const createBody = z.object({ name: z.string().min(1) });
const updateBody = z.object({ name: z.string().optional() }).default({});
const uploadBody = z.object({ file: z.file() });

const base = { tag: 'Products', summary: 'A synthetic operation', description: 'Test only.' } as const;

/** One synthetic operation per mapping branch of the builder. */
const OPERATIONS: readonly ApiOperation[] = [
  {
    ...base,
    operationId: 'listThings',
    method: 'get',
    path: '/api/thing',
    security: 'none',
    query: listQuery,
    success: { status: 200, description: 'A page of things', body: { envelope: 'page', of: 'Product' } },
    errors: ['VALIDATION_FAILED'],
  },
  {
    ...base,
    operationId: 'getThing',
    method: 'get',
    path: '/api/thing/{id}',
    security: 'optional',
    params: idParams,
    success: { status: 200, description: 'One thing', body: { envelope: 'data', of: 'Product' } },
    errors: ['NOT_FOUND', 'VALIDATION_FAILED'],
  },
  {
    ...base,
    operationId: 'createThing',
    method: 'post',
    path: '/api/thing',
    security: 'bearer',
    body: { schema: createBody, mediaType: 'application/json' },
    success: { status: 201, description: 'Created', body: { envelope: 'data', of: ['User', 'Category'] } },
    errors: ['BAD_REQUEST', 'UNAUTHORIZED', 'CONFLICT', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED'],
  },
  {
    ...base,
    operationId: 'updateThing',
    method: 'put',
    path: '/api/thing/{id}',
    security: 'bearer',
    params: idParams,
    body: { schema: updateBody, mediaType: 'application/json' },
    success: { status: 200, description: 'Updated', body: { envelope: 'data', of: ['Product'] } },
    errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  },
  {
    ...base,
    operationId: 'uploadThingImage',
    method: 'put',
    path: '/api/thing/{id}/image',
    security: 'bearer',
    params: idParams,
    body: { schema: uploadBody, mediaType: 'multipart/form-data' },
    success: {
      status: 200,
      description: 'Either resource',
      body: { envelope: 'data-list', of: ['User', 'Product'], maxItems: 2 },
    },
    errors: ['BAD_REQUEST', 'UNAUTHORIZED', 'PAYLOAD_TOO_LARGE'],
  },
  {
    ...base,
    operationId: 'searchThings',
    method: 'get',
    path: '/api/thing/{id}/related',
    security: 'none',
    params: idParams,
    success: {
      status: 200,
      description: 'Related',
      body: { envelope: 'data-list', of: ['Category'], maxItems: 10 },
    },
    errors: ['BAD_REQUEST'],
  },
  {
    ...base,
    operationId: 'deleteThing',
    method: 'delete',
    path: '/api/thing/{id}',
    security: 'bearer',
    params: idParams,
    success: { status: 204, description: 'Deleted' },
    errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  },
  {
    ...base,
    operationId: 'getThingImage',
    method: 'get',
    path: '/api/thing/{id}/image',
    security: 'none',
    params: idParams,
    success: { status: 302, description: 'Redirects to the image' },
    errors: ['NOT_FOUND'],
  },
];

const document: OpenApiDocument = buildOpenApiDocument(OPERATIONS);
const json = asJson(document);
const operation = (method: string, path: string) => json.paths[path][method];

interface OperationJson {
  operationId: string;
  parameters?: { name: string; in: string; required: boolean }[];
  responses: Record<string, unknown>;
}
/** Every operation of the document, with its path template. */
const allOperations = (): [string, OperationJson][] =>
  Object.entries(json.paths as Record<string, Record<string, OperationJson>>).flatMap(([path, item]) =>
    Object.values(item).map((op): [string, OperationJson] => [path, op]),
  );

const byId = (operationId: string): ApiOperation =>
  OPERATIONS.find((op) => op.operationId === operationId) as ApiOperation;

describe('toJsonSchema', () => {
  test('converts in input mode: a transform-bearing DTO documents the plain string a client sends', () => {
    const schema = asJson(toJsonSchema(loginBody));

    expect(schema).not.toHaveProperty('$schema');
    expect(schema.properties.email).toEqual({ type: 'string', maxLength: 254 });
    expect(schema.required).toEqual(['email', 'password']);
  });

  test('negative control: the same DTO in output mode throws, so io: input is load-bearing', () => {
    expect(() => z.toJSONSchema(loginBody, { io: 'output' })).toThrow(/Transforms cannot be represented/);
  });

  test('throws on what JSON Schema cannot represent', () => {
    expect(() => toJsonSchema(z.bigint())).toThrow();
  });
});

describe('buildOpenApiDocument: the document', () => {
  test('is OpenAPI 3.1 with the API version, the tags and one server', () => {
    expect(document.openapi).toMatch(/^3\.1\.\d+$/);
    expect(document.info.version).toBe(API_VERSION);
    expect(document.tags.map(({ name }) => name)).toEqual([
      'Auth',
      'Users',
      'Categories',
      'Products',
      'Search',
      'Media',
    ]);
    expect(document.servers).toEqual([{ url: '/' }]);
  });

  test('has one error response per code, each the shared ErrorEnvelope, and the bearer scheme', () => {
    expect(Object.keys(document.components.responses)).toEqual(ERROR_CODES);
    for (const response of Object.values(document.components.responses)) {
      expect(response).toMatchObject({
        description: expect.any(String),
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      });
    }
    expect(document.components.securitySchemes).toEqual({ bearerAuth: BEARER_SCHEME });
  });

  test('every $ref resolves under components', () => {
    const refs = collectRefs(document);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/')).toBe(true);
      expect(resolvePointer(document, ref), ref).toBeDefined();
    }
  });

  test('every operationId is unique', () => {
    const ids = Object.values(document.paths).flatMap((item) =>
      Object.values(item).map((op) => op.operationId),
    );

    expect(ids).toHaveLength(OPERATIONS.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every {param} of a path template has a required in: path parameter', () => {
    for (const [path, op] of allOperations()) {
      const inPath = (op.parameters ?? []).filter((parameter) => parameter.in === 'path');
      expect(inPath.map((parameter) => parameter.name).sort()).toEqual(pathParams(path).sort());
      for (const parameter of inPath) expect(parameter.required).toBe(true);
    }
  });
});

describe('buildOpenApiDocument: one operation', () => {
  test('carries its id, tag, summary and description', () => {
    expect(operation('get', '/api/thing')).toMatchObject({
      operationId: 'listThings',
      tags: ['Products'],
      summary: base.summary,
      description: base.description,
    });
  });

  test('params become required path parameters', () => {
    expect(operation('get', '/api/thing/{id}').parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string', description: 'The thing id' } },
    ]);
  });

  test('query parameters are required only when the JSON Schema says so; defaults stay optional', () => {
    const parameters: { name: string; in: string; required: boolean; schema: unknown }[] = operation(
      'get',
      '/api/thing',
    ).parameters;

    expect(parameters.map(({ name, in: where, required }) => ({ name, where, required }))).toEqual([
      { name: 'limit', where: 'query', required: false },
      { name: 'q', where: 'query', required: false },
      { name: 'mode', where: 'query', required: true },
    ]);
    expect(parameters[0]?.schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 50, default: 5 });
  });

  test('an all-optional query has only optional parameters, and an empty one adds none', () => {
    const list = { ...byId('listThings'), query: z.object({ q: z.string().optional() }) };
    const empty = { ...byId('createThing'), query: z.object({}) };
    const built = asJson(buildOpenApiDocument([list, empty]));

    expect(built.paths['/api/thing'].get.parameters).toEqual([
      { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
    ]);
    expect(built.paths['/api/thing'].post).not.toHaveProperty('parameters');
  });

  test('an operation without params or query has no parameters key', () => {
    expect(operation('post', '/api/thing')).not.toHaveProperty('parameters');
  });

  test('a JSON body is required unless the schema accepts no body (.default({}))', () => {
    expect(operation('post', '/api/thing').requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: toJsonSchema(createBody) } },
    });
    expect(operation('put', '/api/thing/{id}').requestBody).toMatchObject({ required: false });
  });

  test('a multipart body documents the file as binary', () => {
    expect(operation('put', '/api/thing/{id}/image').requestBody).toMatchObject({
      required: true,
      content: {
        'multipart/form-data': {
          schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
        },
      },
    });
  });

  test('an operation without a body has no requestBody key', () => {
    expect(operation('get', '/api/thing')).not.toHaveProperty('requestBody');
  });

  const dataSchema = (method: string, path: string, status: number) =>
    operation(method, path).responses[status].content['application/json'].schema;

  test('200 data: one component is a $ref', () => {
    expect(dataSchema('get', '/api/thing/{id}', 200)).toEqual({
      type: 'object',
      properties: { data: { $ref: '#/components/schemas/Product' } },
      required: ['data'],
    });
  });

  test('a one-element list of components is a plain $ref too', () => {
    expect(dataSchema('put', '/api/thing/{id}', 200).properties.data).toEqual({
      $ref: '#/components/schemas/Product',
    });
  });

  test('201 data: several components are an anyOf', () => {
    expect(dataSchema('post', '/api/thing', 201).properties.data).toEqual({
      anyOf: [{ $ref: '#/components/schemas/User' }, { $ref: '#/components/schemas/Category' }],
    });
  });

  test('data-list: an array of the components, capped by maxItems', () => {
    expect(dataSchema('put', '/api/thing/{id}/image', 200).properties.data).toEqual({
      type: 'array',
      items: { anyOf: [{ $ref: '#/components/schemas/User' }, { $ref: '#/components/schemas/Product' }] },
      maxItems: 2,
    });
    expect(dataSchema('get', '/api/thing/{id}/related', 200).properties.data).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/Category' },
      maxItems: 10,
    });
  });

  test('page: data is an array of the component, and meta is PageMeta', () => {
    expect(dataSchema('get', '/api/thing', 200)).toEqual({
      type: 'object',
      properties: {
        data: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
        meta: { $ref: '#/components/schemas/PageMeta' },
      },
      required: ['data', 'meta'],
    });
  });

  test('204 has a description and no content', () => {
    expect(operation('delete', '/api/thing/{id}').responses[204]).toEqual({ description: 'Deleted' });
  });

  test('302 documents a required Location header', () => {
    expect(operation('get', '/api/thing/{id}/image').responses[302]).toEqual({
      description: 'Redirects to the image',
      headers: { Location: { required: true, schema: { type: 'string', format: 'uri' } } },
    });
  });

  test('every documented error is a $ref to its response, and INTERNAL (500) is added to every operation', () => {
    for (const [, op] of allOperations()) {
      expect(op.responses[500]).toEqual({ $ref: '#/components/responses/INTERNAL' });
      for (const code of byId(op.operationId).errors) {
        expect(Object.values(op.responses)).toContainEqual({ $ref: `#/components/responses/${code}` });
      }
    }
    expect(operation('post', '/api/thing').responses).toMatchObject({
      400: { $ref: '#/components/responses/BAD_REQUEST' },
      401: { $ref: '#/components/responses/UNAUTHORIZED' },
      409: { $ref: '#/components/responses/CONFLICT' },
      413: { $ref: '#/components/responses/PAYLOAD_TOO_LARGE' },
      422: { $ref: '#/components/responses/VALIDATION_FAILED' },
    });
  });

  test.each([
    ['none', 'get', '/api/thing', undefined],
    ['bearer', 'post', '/api/thing', [{ bearerAuth: [] }]],
    ['optional', 'get', '/api/thing/{id}', [{}, { bearerAuth: [] }]],
  ])('security %s', (_security, method, path, expected) => {
    expect(operation(method, path).security).toEqual(expected);
  });
});

describe('buildOpenApiDocument: build-time invariants', () => {
  const op = (overrides: Partial<ApiOperation>): ApiOperation => ({
    ...byId('getThing'),
    ...overrides,
  });

  test('a duplicate operationId throws', () => {
    expect(() => buildOpenApiDocument([op({}), op({ path: '/api/other/{id}' })])).toThrow(
      'Duplicate operationId getThing',
    );
  });

  test('a duplicate (method, path) throws', () => {
    expect(() => buildOpenApiDocument([op({}), op({ operationId: 'getThingAgain' })])).toThrow(
      'Duplicate operation GET /api/thing/{id}',
    );
  });

  test.each([
    ['a {param} without a params key', { path: '/api/thing/{id}/{other}' as const }],
    ['a params key without a {param}', { path: '/api/thing' as const }],
    ['a {param} with no params schema at all', { params: undefined }],
  ])('a path/params mismatch throws: %s', (_case, overrides) => {
    expect(() => buildOpenApiDocument([op(overrides)])).toThrow(/the path .* has \{.*\} but params declares/);
  });

  test('a request schema that converts with a non-component $ref throws', () => {
    const shared = z.string().meta({ id: 'SyntheticShared' });
    const query = z.object({ a: shared, b: shared });

    expect(() => buildOpenApiDocument([op({ query })])).toThrow(
      'getThing query: the converted schema has a non-component $ref #/$defs/SyntheticShared',
    );
  });

  test.each(['$defs', '__shared'])('a request schema that converts with a %s bucket throws', (bucket) => {
    const body = {
      schema: z.object({ a: z.string().meta({ [bucket]: {} }) }),
      mediaType: 'application/json',
    } as const;

    expect(() => buildOpenApiDocument([op({ body })])).toThrow(
      `getThing body: the converted schema has a ${bucket} bucket`,
    );
  });

  test('a component $ref inside a request schema is allowed', () => {
    const body = {
      schema: z.object({ a: z.string().meta({ $ref: '#/components/schemas/User' }) }),
      mediaType: 'application/json',
    } as const;

    const built = asJson(buildOpenApiDocument([op({ body })]));

    expect(
      built.paths['/api/thing/{id}'].get.requestBody.content['application/json'].schema.properties.a.$ref,
    ).toBe('#/components/schemas/User');
  });
});

describe('tests/helpers/openapi', () => {
  test('resolvePointer follows a local pointer, unescapes ~1 and ~0, and is undefined otherwise', () => {
    const node = { a: { 'b/c': { 'd~e': 1 } } };

    expect(resolvePointer(node, '#/a/b~1c/d~0e')).toBe(1);
    expect(resolvePointer(node, '#/a/missing')).toBeUndefined();
    expect(resolvePointer(node, 'https://example.com/schema')).toBeUndefined();
  });

  test('pathParams lists the template segments in order', () => {
    expect(pathParams('/api/search/{collection}/{term}')).toEqual(['collection', 'term']);
    expect(pathParams('/api/category')).toEqual([]);
  });
});
