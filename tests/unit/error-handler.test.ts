// P11 (M3 design §3.5): the error handler sends the envelope, including a ValidationError's details.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';

import { ValidationError } from '../../src/core/errors';
import { errorHandler } from '../../src/middlewares/error-handler';

const DETAILS = [
  { path: 'name', message: 'Too small: expected string to have >=1 characters' },
  { path: 'address.city', message: 'Invalid input: expected string, received undefined' },
];

describe('errorHandler', () => {
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

  test('a ValidationError is the 422 envelope with its details', async () => {
    const app = express();
    app.post('/items', () => {
      throw new ValidationError(DETAILS);
    });
    app.use(errorHandler);

    const res = await request(await serve(app)).post('/items');

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Validation failed', details: DETAILS },
    });
  });
});
