// The hand-written developer docs (M8 Decision 7) against the code they describe: README.md, .env.example,
// ERROR_CODES.md and api.http fail a test when the environment schema, the scripts, the error codes or the operation
// catalog change without them.
// Known gap (S6 review): the ERROR_CODES.md "How raw errors map" section is prose over
// src/core/errors/to-app-error.ts and is NOT bound here — spot-check it whenever that mapping changes.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { envSchema, loadConfig } from '../../../src/config';
import { ERROR_CATALOG, ERROR_CODES } from '../../../src/docs/error-catalog';
import { API_OPERATIONS } from '../../../src/docs/operations';

const ROOT = path.join(__dirname, '../../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

const README = read('README.md');
const ENV_EXAMPLE = read('.env.example');
const ERROR_CODES_MD = read('ERROR_CODES.md');
const ENV_KEYS = Object.keys(envSchema.shape);
const SCRIPTS = Object.keys(
  (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
);

/** The `KEY=value` lines of .env.example, comments and blank lines skipped. */
const exampleEntries = (): Record<string, string> =>
  Object.fromEntries(
    ENV_EXAMPLE.split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );

describe('README.md', () => {
  test.each(ENV_KEYS)('documents the %s variable', (key) => {
    expect(README).toContain(`\`${key}\``);
  });

  test.each(SCRIPTS)('documents `pnpm %s`', (name) => {
    expect(README).toContain(`\`pnpm ${name}\``);
  });

  test.each(['ARCHITECTURE.md', 'API_PROGRESS.md', 'ERROR_CODES.md'])('links %s', (file) => {
    expect(README).toContain(`](${file})`);
  });
});

describe('.env.example', () => {
  test.each(ENV_KEYS)('lists %s', (key) => {
    expect(ENV_EXAMPLE).toMatch(new RegExp(`^${key}=`, 'm'));
  });

  test('lists only variables the schema reads', () => {
    expect(Object.keys(exampleEntries()).filter((key) => !ENV_KEYS.includes(key))).toEqual([]);
  });

  test.each(['SECRET_KEY', 'CLOUDINARY_URL', 'SEED_ADMIN_PASSWORD'])('leaves %s empty', (key) => {
    expect(exampleEntries()[key]).toBe('');
  });

  test('carries no credential: no value is a URI with a user and a password', () => {
    for (const [key, value] of Object.entries(exampleEntries())) {
      expect(value, key).not.toMatch(/:\/\/[^/\s:@]+:[^@\s]+@/);
    }
  });

  test('with the empty required placeholders filled, it passes loadConfig', () => {
    const config = loadConfig({
      ...exampleEntries(),
      SECRET_KEY: 'a-local-development-secret-of-32-chars',
      GOOGLE_CLIENT_ID: 'local-client-id.apps.googleusercontent.com',
      CLOUDINARY_URL: 'cloudinary://key:secret@demo',
    });

    expect(config.env).toBe('development');
    expect(config.docs.enabled).toBe(true);
  });
});

// Table rows as `| \`CODE\` | STATUS |`, with Prettier's column padding allowed.
describe('ERROR_CODES.md', () => {
  test.each(ERROR_CODES)('has exactly one row for %s, with its status', (code) => {
    const row = new RegExp(`^\\| \`${code}\` +\\| ${ERROR_CATALOG[code].status} +\\|`, 'gm');

    expect(ERROR_CODES_MD.match(row)).toHaveLength(1);
  });

  test('has no row for a code that does not exist', () => {
    expect(ERROR_CODES_MD.match(/^\| `[A-Z_]+` +\| \d{3} +\|/gm)).toHaveLength(ERROR_CODES.length);
  });

  test('describes the envelope and the 422 details', () => {
    expect(ERROR_CODES_MD).toContain('"error"');
    expect(ERROR_CODES_MD).toContain('"details"');
    expect(ERROR_CODES_MD).toMatch(/`details` is present only on `VALIDATION_FAILED` \(422\)/);
  });
});

interface HttpRequest {
  name: string;
  method: string;
  /** The URL path after {{baseUrl}}, without the query string. */
  path: string;
  headers: string[];
}

/** The requests of api.http: one `###` block each, with `# @name`, the request line and its header lines. */
const httpRequests = (): HttpRequest[] =>
  read('api.http')
    .split(/^###.*$/m)
    .slice(1)
    .map((block) => {
      const lines = block.split('\n');
      const name = /^# @name (\S+)$/m.exec(block)?.[1] ?? '';
      const start = lines.findIndex((line) => /^(GET|POST|PUT|DELETE) /.test(line));
      const [method = '', url = ''] = (lines[start] ?? '').split(' ');
      const end = lines.findIndex((line, index) => index > start && line.trim() === '');
      return {
        name,
        method,
        path: url.replace('{{baseUrl}}', '').split('?')[0] ?? '',
        headers: lines.slice(start + 1, end === -1 ? undefined : end),
      };
    });

/** A path matches a template when every literal segment is equal; a `{param}` segment matches any one segment. */
const matchesTemplate = (path: string, template: string): boolean => {
  const actual = path.split('/');
  const expected = template.split('/');
  return (
    actual.length === expected.length &&
    expected.every((segment, index) => /^\{[^}]+\}$/.test(segment) || segment === actual[index])
  );
};

describe('api.http', () => {
  test('starts with the file variables the requests use', () => {
    const variables = [...read('api.http').matchAll(/^@(\w+) = /gm)].map(([, name]) => name);

    expect(variables).toEqual(['baseUrl', 'token', 'categoryId', 'productId', 'userId']);
  });

  test('has one request per catalog operation: its @name values are the 21 operationIds', () => {
    const names = httpRequests().map(({ name }) => name);
    const operationIds = API_OPERATIONS.map(({ operationId }) => operationId);

    expect(
      names.filter((name) => !operationIds.includes(name)),
      'requests with no operation',
    ).toEqual([]);
    expect(
      operationIds.filter((id) => !names.includes(id)),
      'operations with no request',
    ).toEqual([]);
    expect(names).toHaveLength(21);
  });

  test.each(API_OPERATIONS.map((op) => [op.operationId, op] as const))(
    '%s: the method and path match the operation',
    (operationId, op) => {
      const request = httpRequests().find(({ name }) => name === operationId);

      expect(request?.method).toBe(op.method.toUpperCase());
      expect(matchesTemplate(request?.path ?? '', op.path), `${request?.path} vs ${op.path}`).toBe(true);
    },
  );

  test.each(API_OPERATIONS.filter((op) => op.security === 'bearer').map((op) => op.operationId))(
    '%s sends Authorization: Bearer {{token}}',
    (operationId) => {
      const request = httpRequests().find(({ name }) => name === operationId);

      expect(request?.headers).toContain('Authorization: Bearer {{token}}');
    },
  );

  test('logoutAll is last, because it revokes the token', () => {
    expect(httpRequests().at(-1)?.name).toBe('logoutAll');
  });
});
