// GET /docs and GET /docs/openapi.json (Decisions 2-4): serving, caching, the docs-only CSP, build-once and the
// DOCS_ENABLED flag (D5).
import { createServer, type Server } from 'node:http';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ConfigError } from '../../../src/config';
import { docsModule } from '../../../src/docs';
import { buildOpenApiDocument } from '../../../src/docs/openapi';
import { API_OPERATIONS } from '../../../src/docs/operations';
import { UI_BUNDLE_URL } from '../../../src/docs/page';
import { startTestApp, stopTestApp } from '../../helpers/app';

const GLOBAL_CSP =
  "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';" +
  "img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';" +
  "style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests";
const DOCS_CSP =
  "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';" +
  `img-src 'self' data: https://cdn.redoc.ly;object-src 'none';script-src ${UI_BUNDLE_URL};script-src-attr 'none';` +
  "style-src 'self' https: 'unsafe-inline';worker-src blob:";
const ROUTE_NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Route not found' } };

afterAll(stopTestApp);

describe('with docs enabled', () => {
  let app: Server;

  beforeAll(async () => {
    app = await startTestApp({ DOCS_ENABLED: 'true' });
  });

  test('GET /docs is the HTML page, revalidated on every load', async () => {
    const res = await request(app).get('/docs');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.text).toContain('<redoc spec-url="/docs/openapi.json">');
  });

  test('GET /docs/openapi.json is the document the catalog builds', async () => {
    const res = await request(app).get('/docs/openapi.json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument(API_OPERATIONS))));
  });

  test.each(['/docs', '/docs/openapi.json'])(
    '%s: the same ETag twice, and If-None-Match gives a 304',
    async (path) => {
      const first = await request(app).get(path);
      const second = await request(app).get(path);
      const revalidated = await request(app).get(path).set('If-None-Match', String(first.headers.etag));

      expect(first.headers.etag).toBeTruthy();
      expect(second.headers.etag).toBe(first.headers.etag);
      expect(revalidated.status).toBe(304);
    },
  );

  test('GET /docs carries the docs CSP: the pinned bundle as the only script, blob: workers', async () => {
    const res = await request(app).get('/docs');

    expect(res.headers['content-security-policy']).toBe(DOCS_CSP);
  });

  test.each(['/docs/openapi.json', '/api/category'])(
    '%s keeps the global CSP, without the CDN',
    async (path) => {
      const res = await request(app).get(path);

      expect(res.headers['content-security-policy']).toBe(GLOBAL_CSP);
      expect(res.headers['content-security-policy']).not.toContain('cdn.jsdelivr.net');
    },
  );

  test('any other /docs path is the standard 404', async () => {
    const res = await request(app).get('/docs/other');

    expect(res.status).toBe(404);
    expect(res.body).toEqual(ROUTE_NOT_FOUND);
  });
});

describe('docsModule builds the document once', () => {
  test('one build when the router is created, none per request (TEST-02: behind node:http on 127.0.0.1)', async () => {
    let builds = 0;
    const app = express().use(
      '/docs',
      docsModule({
        buildDocument: () => {
          builds += 1;
          return buildOpenApiDocument([]);
        },
      }),
    );
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      expect(builds).toBe(1);
      expect((await request(server).get('/docs/openapi.json')).status).toBe(200);
      expect((await request(server).get('/docs/openapi.json')).status).toBe(200);
      expect(builds).toBe(1);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

describe('DOCS_ENABLED (D5): mounted, or the standard 404', () => {
  test.each([
    ['development', '', true],
    ['development', 'true', true],
    ['development', 'false', false],
    ['test', '', true],
    ['test', 'true', true],
    ['test', 'false', false],
    ['production', '', false],
    ['production', 'true', true],
    ['production', 'false', false],
  ])('NODE_ENV=%s, DOCS_ENABLED=%j → mounted %s', async (NODE_ENV, DOCS_ENABLED, mounted) => {
    const app = await startTestApp({ NODE_ENV, DOCS_ENABLED });

    for (const path of ['/docs', '/docs/openapi.json']) {
      const res = await request(app).get(path);
      if (mounted) {
        expect(res.status, path).toBe(200);
      } else {
        expect(res.status, path).toBe(404);
        expect(res.body, path).toEqual(ROUTE_NOT_FOUND);
      }
    }
  });

  test('an invalid DOCS_ENABLED makes the app refuse to build', async () => {
    await expect(startTestApp({ DOCS_ENABLED: 'yes' })).rejects.toBeInstanceOf(ConfigError);
  });
});
