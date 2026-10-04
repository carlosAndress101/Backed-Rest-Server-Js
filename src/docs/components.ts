import { z } from 'zod';

import { ROLES } from '../core/security/roles';
import { ERROR_CODES } from './error-catalog';

// Docs-only response components (Decision 5). Coarse on purpose: each lists the stable fields and allows extras
// (z.looseObject), and a contract test parses real API responses with them, so they cannot drift silently.

const id = z.string().describe('The resource id (an ObjectId as 24 hex characters)');
const timestamp = z.iso.datetime();
/** A reference some reads populate (`product.service.ts`, `category.service.ts`): an id, or `{ id, name, … }`. */
const reference = z.union([id, z.looseObject({ id, name: z.string() })]);

export const ValidationIssue = z.object({ path: z.string(), message: z.string() });

export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.array(ValidationIssue).optional().describe('Present on 422 VALIDATION_FAILED only'),
  }),
});

export const PageMeta = z.object({
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
});

export const User = z.looseObject({
  id,
  uid: id.meta({ deprecated: true, description: 'The same value as `id`; removed in 4.0.0' }),
  name: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  state: z.boolean(),
  google: z.boolean(),
  image: z.string().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const Category = z.looseObject({
  id,
  name: z.string(),
  state: z.boolean(),
  user: reference,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const Product = z.looseObject({
  id,
  name: z.string(),
  state: z.boolean(),
  user: reference,
  price: z.number(),
  category: reference,
  description: z.string().optional(),
  available: z.boolean(),
  image: z.string().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const Session = z.looseObject({ token: z.string().describe('The session JWT'), user: User });

export const TokenGrant = z.looseObject({
  token: z.string().describe('A new session JWT; every earlier token is revoked'),
});

const COMPONENTS = { ValidationIssue, ErrorEnvelope, PageMeta, Category, Product, User, Session, TokenGrant };
export type ComponentName = keyof typeof COMPONENTS;

export type JsonSchema = Record<string, unknown>;

/**
 * The components as JSON Schema, keyed by name. One registry conversion, so shared components are real `$ref`s
 * (`Session.user` → `User`, `ErrorEnvelope.error.details.items` → `ValidationIssue`); `$id` and `$schema` are dropped.
 */
export function componentSchemas(): Record<ComponentName, JsonSchema> {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(COMPONENTS)) registry.add(schema, { id: name });

  const { schemas } = z.toJSONSchema(registry, {
    uri: (name) => `#/components/schemas/${name}`,
    io: 'input',
  });
  const components: Record<string, JsonSchema> = {};
  for (const [name, converted] of Object.entries(schemas)) {
    const schema: JsonSchema = { ...converted };
    delete schema.$id;
    delete schema.$schema;
    components[name] = schema;
  }
  return components;
}

/** The only security scheme. x-token is deliberately not a second scheme, so tools never offer it (ADR-032). */
export const BEARER_SCHEME = {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'Send `Authorization: Bearer <token>`. The deprecated `x-token` header is still read when there is no ' +
    '`Authorization` header; those responses carry `Deprecation: true`, and `x-token` is removed in 4.0.0.',
} as const;
