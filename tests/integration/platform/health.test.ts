// M9 platform routes (ADR-052): GET /health (liveness, no database touch) and GET /ready
// (readiness, a real DB ping). Both anonymous matrix rows #28/#29; the not-ready 500 goes through
// the standard envelope (D1). The rejecting fake proves the 500 path without touching the database.
import { createServer, type Server } from 'node:http';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { errorHandler } from '../../../src/middlewares/error-handler';
import { healthRouter, readyRouter } from '../../../src/platform/health';
import { startTestApp, stopTestApp } from '../../helpers/app';

afterAll(stopTestApp);

describe('platform routes on the live app', () => {
  let app: Server;

  beforeAll(async () => {
    app = await startTestApp();
  });

  test('GET /health is 200 with the status envelope and a request id', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok' } });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  test('GET /ready is 200 while the database answers', async () => {
    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok' } });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  test('an unknown platform sub-path is still the 404 envelope', async () => {
    const res = await request(app).get('/ready/now');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
});

describe('readyRouter with an injected checkDb', () => {
  const serveRouter = (checkDb: () => Promise<void>): Promise<Server> =>
    new Promise((resolve, reject) => {
      const host = express();
      host.use('/health', healthRouter());
      host.use('/ready', readyRouter({ checkDb }));
      host.use(errorHandler);
      const server = createServer(host);
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });

  test('a passing check is 200 with the status envelope', async () => {
    const server = await serveRouter(() => Promise.resolve());
    try {
      const res = await request(server).get('/ready');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { status: 'ok' } });
    } finally {
      server.close();
    }
  });

  test('a failing check is 500 INTERNAL with no internals leaked', async () => {
    const server = await serveRouter(() => Promise.reject(new Error('connection refused')));
    try {
      const res = await request(server).get('/ready');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Database not ready' } });
    } finally {
      server.close();
    }
  });
});
