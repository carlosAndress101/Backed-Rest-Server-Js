// P9 (M3 design §3.1): validate(part, schema) replaces express-validator.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { AppError, ValidationError } from '../../src/core/errors';
import { paginationQuerySchema } from '../../src/core/http/pagination';
import { validate } from '../../src/middlewares/validate';

const userBody = z.object({
  name: z.string().trim().min(1),
  address: z.object({ city: z.string() }),
});

/** Runs a middleware against a fake request; returns what it threw and how it called next. */
function run(middleware: RequestHandler, req: object) {
  const next = vi.fn();
  let thrown: unknown;
  try {
    void middleware(req as Request, {} as never, next);
  } catch (error) {
    thrown = error;
  }
  return { thrown, next };
}

/** A request whose `query` and `params` are prototype getters, as Express 5 defines `req.query`. */
function getterRequest(raw: { query?: object; params?: object }): Record<string, unknown> {
  const proto = {
    get query() {
      return raw.query;
    },
    get params() {
      return raw.params;
    },
  };
  return Object.create(proto) as Record<string, unknown>;
}

describe('validate with a fake request', () => {
  test('a valid body is replaced by the parsed value and next is called once, without an error', () => {
    const req = { body: { name: '  Ada ', address: { city: 'Cali' }, role: 'ADMIN_ROLE' } };

    const { thrown, next } = run(validate('body', userBody), req);

    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(req.body).toEqual({ name: 'Ada', address: { city: 'Cali' } }); // trimmed, unknown key stripped
  });

  test('an invalid body throws a ValidationError with one detail per issue and never calls next', () => {
    const req = { body: { name: '', address: { city: 7 } } };

    const { thrown, next } = run(validate('body', userBody), req);

    expect(next).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(ValidationError);
    const error = thrown as ValidationError;
    expect(error.status).toBe(422);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual([
      { path: 'name', message: expect.any(String) },
      { path: 'address.city', message: expect.any(String) }, // nested paths are joined with '.'
    ]);
    expect(req.body).toEqual({ name: '', address: { city: 7 } }); // left untouched
  });

  test('a missing body (no parser ran) is a validation failure, not a crash', () => {
    const { thrown } = run(validate('body', userBody), { body: undefined });

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).details).toEqual([{ path: '', message: expect.any(String) }]);
  });

  test.each(['query', 'params'] as const)('a valid %s shadows the getter with the parsed value', (part) => {
    const req = getterRequest({ [part]: { limit: '10', offset: '20', extra: 'x' } });

    const { thrown, next } = run(validate(part, paginationQuerySchema), req);

    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(req[part]).toEqual({ limit: 10, offset: 20 });
  });

  test.each(['query', 'params'] as const)('an invalid %s throws and keeps the raw getter', (part) => {
    const raw = { limit: '0' };
    const req = getterRequest({ [part]: raw });

    const { thrown, next } = run(validate(part, paginationQuerySchema), req);

    expect(next).not.toHaveBeenCalled();
    expect((thrown as ValidationError).details).toEqual([{ path: 'limit', message: expect.any(String) }]);
    expect(req[part]).toBe(raw);
  });
});

describe('validate inside Express 5', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /** Serves `app` on 127.0.0.1 (AM-5), one connection per request. */
  async function serve(app: express.Express): Promise<Server> {
    server = createServer((req, res) => {
      res.setHeader('Connection', 'close');
      app(req, res);
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
  }

  /** An app whose error handler reports the status and code of whatever reached it. */
  function appWith(...handlers: RequestHandler[]): express.Express {
    const app = express();
    app.use(express.json());
    app.post('/items/:id', ...handlers);
    app.get('/items/:id', ...handlers);
    const reportError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
      if (res.headersSent) return next(err);
      const appError = err instanceof AppError ? err : undefined;
      res.status(appError?.status ?? 500).json({ code: appError?.code, message: (err as Error).message });
    };
    app.use(reportError);
    return app;
  }

  const echo: RequestHandler = (req, res) => {
    res.json({ body: req.body, query: req.query, params: req.params });
  };

  test('the handler after validate reads the parsed query and params, not the raw strings', async () => {
    const idParams = z.object({ id: z.coerce.number().int() });
    const app = appWith(validate('params', idParams), validate('query', paginationQuerySchema), echo);

    const res = await request(await serve(app)).get('/items/42?limit=7');

    expect(res.status).toBe(200);
    expect(res.body.params).toEqual({ id: 42 });
    expect(res.body.query).toEqual({ limit: 7, offset: 0 });
  });

  test('the handler after validate reads the parsed body', async () => {
    const app = appWith(validate('body', userBody), echo);

    const res = await request(await serve(app))
      .post('/items/1')
      .send({ name: ' Ada ', address: { city: 'Cali' }, _id: 'x' });

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ name: 'Ada', address: { city: 'Cali' } });
  });

  test('a validation failure reaches the error handler as a 422 VALIDATION_FAILED', async () => {
    const app = appWith(validate('query', paginationQuerySchema), echo);

    const res = await request(await serve(app)).get('/items/1?limit=51');

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: 'VALIDATION_FAILED', message: 'Validation failed' });
  });

  test('an error thrown after params were replaced still reaches the error handler', async () => {
    // The router restores req.params on the way out; the replaced property must stay writable.
    const failing: RequestHandler = async () => {
      await Promise.resolve();
      throw new Error('controller failed');
    };
    const app = appWith(validate('params', z.object({ id: z.string() })), failing);

    const res = await request(await serve(app)).get('/items/1');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'controller failed' });
  });
});
