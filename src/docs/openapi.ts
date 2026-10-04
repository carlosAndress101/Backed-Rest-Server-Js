import { z } from 'zod';

import type { ErrorCode } from '../core/errors';
import { BEARER_SCHEME, componentSchemas, type ComponentName, type JsonSchema } from './components';
import { ERROR_CATALOG, ERROR_CODES } from './error-catalog';

/** Equals package.json `version` (tested); bumped with every release. Read at build time, never at runtime (ARC-02). */
export const API_VERSION = '3.0.0';

export type ApiTag = 'Auth' | 'Users' | 'Categories' | 'Products' | 'Search' | 'Media';
export type Security = 'none' | 'bearer' | 'optional';
export type ResponseBody =
  | { readonly envelope: 'data'; readonly of: ComponentName | readonly ComponentName[] } // array → anyOf
  | { readonly envelope: 'data-list'; readonly of: readonly ComponentName[]; readonly maxItems: number }
  | { readonly envelope: 'page'; readonly of: ComponentName };

export interface ApiOperation {
  /** Also the api.http `# @name`. */
  readonly operationId: string;
  readonly method: 'get' | 'post' | 'put' | 'delete';
  /** The OpenAPI template, e.g. /api/category/{id}. */
  readonly path: `/api/${string}`;
  readonly tag: ApiTag;
  readonly summary: string;
  /** Who may call it (API_PROGRESS "Auth") and the notable rules. */
  readonly description: string;
  readonly security: Security;
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: {
    readonly schema: z.ZodType;
    readonly mediaType: 'application/json' | 'multipart/form-data';
  };
  readonly success:
    | { readonly status: 200 | 201; readonly description: string; readonly body: ResponseBody }
    | { readonly status: 204 | 302; readonly description: string };
  readonly errors: readonly Exclude<ErrorCode, 'INTERNAL'>[];
}

export interface OpenApiDocument {
  readonly openapi: '3.1.1';
  readonly info: { readonly title: string; readonly version: string; readonly description: string };
  readonly servers: readonly { readonly url: string }[];
  readonly tags: readonly { readonly name: ApiTag }[];
  readonly paths: Record<string, Record<string, JsonSchema>>;
  readonly components: {
    readonly schemas: Record<ComponentName, JsonSchema>;
    readonly responses: Record<ErrorCode, JsonSchema>;
    readonly securitySchemes: { readonly bearerAuth: typeof BEARER_SCHEME };
  };
}

const TAGS: readonly ApiTag[] = ['Auth', 'Users', 'Categories', 'Products', 'Search', 'Media'];
const SCHEMA_REF = '#/components/schemas/';
const ref = (name: ComponentName) => ({ $ref: `${SCHEMA_REF}${name}` });
const oneOrAnyOf = (of: ComponentName | readonly ComponentName[]) =>
  typeof of === 'string' ? ref(of) : of.length === 1 ? ref(of[0] as ComponentName) : { anyOf: of.map(ref) };

/**
 * A zod schema as JSON Schema: always `io: 'input'`, the shape a client sends (a `.transform` would throw in output
 * mode), and the root `$schema` dropped. Throws on anything JSON Schema cannot represent.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const converted: JsonSchema = {
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }),
  };
  delete converted.$schema;
  return converted;
}

/** Throws unless a converted request schema is self-contained: no `$defs`, no `__shared`, no `$ref` but a component. */
function assertSelfContained(where: string, node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) assertSelfContained(where, item);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$defs' || key === '__shared')
      throw new Error(`${where}: the converted schema has a ${key} bucket`);
    if (key === '$ref' && !String(value).startsWith(SCHEMA_REF)) {
      throw new Error(`${where}: the converted schema has a non-component $ref ${String(value)}`);
    }
    assertSelfContained(where, value);
  }
}

function convert(where: string, schema: z.ZodType): JsonSchema {
  const converted = toJsonSchema(schema);
  assertSelfContained(where, converted);
  return converted;
}

function parameters(op: ApiOperation): JsonSchema[] {
  const out: JsonSchema[] = [];
  for (const [location, schema] of [
    ['path', op.params],
    ['query', op.query],
  ] as const) {
    if (!schema) continue;
    const converted = convert(`${op.operationId} ${location}`, schema);
    const properties = converted.properties as Record<string, JsonSchema>; // a ZodObject always has them
    const required = new Set((converted.required ?? []) as string[]);
    for (const [name, property] of Object.entries(properties)) {
      out.push({ name, in: location, required: location === 'path' || required.has(name), schema: property });
    }
  }
  return out;
}

function successBody(body: ResponseBody): JsonSchema {
  switch (body.envelope) {
    case 'data':
      return { type: 'object', properties: { data: oneOrAnyOf(body.of) }, required: ['data'] };
    case 'data-list':
      return {
        type: 'object',
        properties: { data: { type: 'array', items: oneOrAnyOf(body.of), maxItems: body.maxItems } },
        required: ['data'],
      };
    case 'page':
      return {
        type: 'object',
        properties: { data: { type: 'array', items: ref(body.of) }, meta: ref('PageMeta') },
        required: ['data', 'meta'],
      };
  }
}

function responses(op: ApiOperation): Record<string, JsonSchema> {
  const { success } = op;
  const out: Record<string, JsonSchema> = {};
  if (success.status === 200 || success.status === 201) {
    out[success.status] = {
      description: success.description,
      content: { 'application/json': { schema: successBody(success.body) } },
    };
  } else if (success.status === 302) {
    out[302] = {
      description: success.description,
      headers: { Location: { required: true, schema: { type: 'string', format: 'uri' } } },
    };
  } else {
    out[204] = { description: success.description };
  }
  for (const code of [...op.errors, 'INTERNAL' as const]) {
    out[ERROR_CATALOG[code].status] = { $ref: `#/components/responses/${code}` };
  }
  return out;
}

const SECURITY: Record<Security, JsonSchema[] | undefined> = {
  none: undefined,
  bearer: [{ bearerAuth: [] }],
  optional: [{}, { bearerAuth: [] }],
};

function operationObject(op: ApiOperation): JsonSchema {
  const params = parameters(op);
  const security = SECURITY[op.security];
  return {
    operationId: op.operationId,
    tags: [op.tag],
    summary: op.summary,
    description: op.description,
    ...(params.length > 0 && { parameters: params }),
    ...(op.body && {
      requestBody: {
        required: !op.body.schema.safeParse(undefined).success,
        content: { [op.body.mediaType]: { schema: convert(`${op.operationId} body`, op.body.schema) } },
      },
    }),
    responses: responses(op),
    ...(security && { security }),
  };
}

/** Throws unless the `{param}` segments of the path template are exactly the keys of the params schema. */
function assertPathParams(op: ApiOperation): void {
  const inPath = [...op.path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => name).sort();
  const inSchema = Object.keys(op.params?.shape ?? {}).sort();
  if (inPath.join() !== inSchema.join()) {
    throw new Error(
      `${op.operationId}: the path ${op.path} has {${inPath.join(', ')}} but params declares {${inSchema.join(', ')}}`,
    );
  }
}

/**
 * The OpenAPI 3.1 document for `operations`. Pure: no I/O. Throws on a duplicate operationId, a duplicate
 * (method, path), a path template whose `{param}`s differ from its params schema, or a request schema that does not
 * convert to a self-contained JSON Schema.
 */
export function buildOpenApiDocument(operations: readonly ApiOperation[]): OpenApiDocument {
  const operationIds = new Set<string>();
  const paths: Record<string, Record<string, JsonSchema>> = {};

  for (const op of operations) {
    if (operationIds.has(op.operationId)) throw new Error(`Duplicate operationId ${op.operationId}`);
    operationIds.add(op.operationId);
    const item = (paths[op.path] ??= {});
    if (item[op.method]) throw new Error(`Duplicate operation ${op.method.toUpperCase()} ${op.path}`);
    assertPathParams(op);
    item[op.method] = operationObject(op);
  }

  const errorResponses = {} as Record<ErrorCode, JsonSchema>;
  for (const code of ERROR_CODES) {
    errorResponses[code] = {
      description: ERROR_CATALOG[code].summary,
      content: { 'application/json': { schema: ref('ErrorEnvelope') } },
    };
  }

  return {
    openapi: '3.1.1',
    info: {
      title: 'Backed REST Server API',
      version: API_VERSION,
      description:
        'Every response body is JSON: `{ data }`, `{ data, meta }` for a page, or `{ error }` (see ERROR_CODES.md).',
    },
    servers: [{ url: '/' }],
    tags: TAGS.map((name) => ({ name })),
    paths,
    components: {
      schemas: componentSchemas(),
      responses: errorResponses,
      securitySchemes: { bearerAuth: BEARER_SCHEME },
    },
  };
}
