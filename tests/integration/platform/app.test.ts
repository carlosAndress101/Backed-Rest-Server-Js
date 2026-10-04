import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearLogs, loggedText, startTestApp, stopTestApp } from '../../helpers/app';
import { stubMediaClient } from '../../helpers/uploads';
import { logRecords, requestSeenByApp, signIn, type SignedIn } from './support';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NEW_ASSET = 'https://res.cloudinary.com/demo/image/upload/v1/platform-asset.png';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // the media module sniffs the magic bytes

describe('createApp', () => {
  let server: Server;
  let admin: SignedIn;
  let user: SignedIn;

  beforeAll(async () => {
    server = await startTestApp();
    await mongoose.model('Category').init(); // the unique index the duplicate-key case relies on
    admin = await signIn(server, 'ADMIN_ROLE');
    user = await signIn(server);
  });

  afterAll(stopTestApp);

  const createCategory = (name: string) =>
    mongoose.model('Category').create({ name, user: new mongoose.Types.ObjectId(admin.id) });

  describe('C2 and C1 bodies are the error envelope (3.0.0, ADR-021)', () => {
    test('an unknown route is 404 NOT_FOUND "Route not found"', async () => {
      const res = await request(server).get('/api/definitely-not-a-route');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    });

    test('a duplicate key is 409 CONFLICT', async () => {
      await createCategory('PLATFORM DUP ONE');
      const second = await createCategory('PLATFORM DUP TWO');

      const res = await request(server)
        .put(`/api/category/${String(second._id)}`)
        .set('x-token', admin.token)
        .send({ name: 'PLATFORM DUP ONE' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
    });

    test('an invalid product price is rejected by the DTO: 422 VALIDATION_FAILED (AM-M3-5)', async () => {
      const category = await createCategory('PLATFORM CAST');

      const res = await request(server)
        .post('/api/product')
        .set('x-token', admin.token)
        .send({ name: 'PLATFORM CAST PRODUCT', price: 'not-a-number', category: String(category._id) });

      expect(res.status).toBe(422);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'price' })]),
      );
    });

    test('malformed JSON is 400 BAD_REQUEST', async () => {
      const res = await request(server)
        .post('/api/category')
        .set('Content-Type', 'application/json')
        .send('{"name":');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid request data' } });
    });

    test('JSON over 100 kb is 413 PAYLOAD_TOO_LARGE (AM-M3-10)', async () => {
      const res = await request(server)
        .post('/api/category')
        .send({ name: 'x'.repeat(120 * 1024) });

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' } });
    });

    test('a bad percent escape in a path param is 400 BAD_REQUEST', async () => {
      const res = await request(server).get('/api/category/%E0%A4%A');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid request data' } });
    });

    test('an unexpected error is 500 INTERNAL', async () => {
      vi.spyOn(mongoose.model('Category'), 'find').mockImplementationOnce(() => {
        throw new Error('simulated database outage');
      });

      const res = await request(server).get('/api/category');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    });

    test('a thrown non-Error is 500 INTERNAL', async () => {
      vi.spyOn(mongoose.model('Category'), 'find').mockImplementationOnce(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'not an Error';
      });

      const res = await request(server).get('/api/category');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    });
  });

  describe('logging', () => {
    let logged: Server;

    beforeAll(async () => {
      logged = await startTestApp({ LOG_LEVEL: 'info' });
    });

    test('a 500 writes one error line with the request id and the cause', async () => {
      vi.spyOn(mongoose.model('Category'), 'find').mockImplementationOnce(() => {
        throw new Error('simulated database outage');
      });
      clearLogs();

      const res = await request(logged).get('/api/category').set('x-request-id', 'platform-500');

      expect(res.status).toBe(500);
      const lines = logRecords(loggedText()).filter((line) => line.reqId === 'platform-500');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 50,
        err: { message: 'simulated database outage', stack: expect.stringContaining('Error') },
        res: { statusCode: 500 },
      });
    });

    test('an HTTP-layer 4xx writes one warn line with the cause', async () => {
      clearLogs();

      const res = await request(logged)
        .post('/api/category')
        .set('x-request-id', 'platform-400')
        .set('Content-Type', 'application/json')
        .send('{"name":');

      expect(res.status).toBe(400);
      const lines = logRecords(loggedText()).filter((line) => line.reqId === 'platform-400');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 40, err: { type: 'SyntaxError' }, res: { statusCode: 400 } });
    });

    test('the C2 404 writes one warn line without an error', async () => {
      clearLogs();

      await request(logged).get('/nope').set('x-request-id', 'platform-404');

      const lines = logRecords(loggedText()).filter((line) => line.reqId === 'platform-404');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 40, res: { statusCode: 404 } });
      expect(lines[0]).not.toHaveProperty('err');
    });
  });

  describe('request id', () => {
    test('a valid inbound x-request-id is echoed', async () => {
      const res = await request(server).get('/').set('x-request-id', 'client-id_1.2:3');

      expect(res.headers['x-request-id']).toBe('client-id_1.2:3');
    });

    test('a UUID v4 is generated when the header is absent', async () => {
      const res = await request(server).get('/');

      expect(res.headers['x-request-id']).toMatch(UUID_V4);
    });

    test.each(['has spaces', 'x'.repeat(129), 'line\\nbreak', ''])(
      'an unsafe inbound id (case %#) is replaced by a UUID v4',
      async (inbound) => {
        const res = await request(server).get('/').set('x-request-id', inbound);

        expect(res.headers['x-request-id']).toMatch(UUID_V4);
      },
    );
  });

  describe('security headers and CORS', () => {
    test('there is no x-powered-by header', async () => {
      const res = await request(server).get('/');

      expect(res.headers).not.toHaveProperty('x-powered-by');
    });

    test('the global headers are helmet defaults plus CORP cross-origin, with no demo-page allowances (CQ-07)', async () => {
      const res = await request(server).get('/');
      const csp = res.headers['content-security-policy'];

      expect(csp).toBe(
        "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';" +
          "img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';" +
          "style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests",
      );
      expect(csp).not.toContain('accounts.google.com');
      expect(csp).not.toContain('fonts.g');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });

    test('CORS allows any origin by default', async () => {
      const res = await request(server).get('/').set('Origin', 'https://anyone.example');

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    test('with CORS_ORIGINS, an allowlisted origin is echoed and any other gets no CORS header', async () => {
      const allowlisted = await startTestApp({ CORS_ORIGINS: 'https://shop.example, https://admin.example' });

      const allowed = await request(allowlisted).get('/').set('Origin', 'https://admin.example');
      const other = await request(allowlisted).get('/').set('Origin', 'https://evil.example');

      expect(allowed.headers['access-control-allow-origin']).toBe('https://admin.example');
      expect(other.headers).not.toHaveProperty('access-control-allow-origin');
    });
  });

  describe('the 2.x surface: removed routes and request bodies', () => {
    test('GET /hello is removed: 404 (CQ-02, §6 #1)', async () => {
      const res = await request(server).get('/hello');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    });

    test('GET / is 404 NOT_FOUND: the demo page is removed (CQ-07)', async () => {
      const res = await request(server).get('/');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    });

    test('a bodiless PUT /api/user/:id by the owner is a 200 no-op (Express 4 parity)', async () => {
      const res = await request(server).put(`/api/user/${user.id}`).set('x-token', user.token);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ uid: user.id, name: 'Platform User' });
    });

    test('C10: a multipart body sent to a non-upload route is ignored', async () => {
      const { req, res } = await requestSeenByApp(server, () =>
        request(server)
          .put(`/api/user/${user.id}`)
          .set('x-token', user.token)
          .field('name', 'Renamed Through Multipart'),
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ uid: user.id, name: 'Platform User' });
      expect(req.body).toEqual({});
    });
  });

  // The media module (T3.7) runs the multipart parser itself, after auth. Its Cloudinary client is stubbed, so
  // nothing is written outside the request's own temp folder (TEST-03).
  // AM-M5-9: JWT_TTL reaches the token service through createApp (config.auth.jwtTtlSeconds, ADR-034).
  describe('JWT_TTL', () => {
    /** exp - iat of a token, read from its payload. */
    const lifetime = (token: string) => {
      const { iat, exp } = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
        iat: number;
        exp: number;
      };
      return exp - iat;
    };

    test('sets the lifetime of the tokens the login issues: 4h by default, 90s when JWT_TTL=90s', async () => {
      const shortLived = await startTestApp({ JWT_TTL: '90s' });

      const { token } = await signIn(shortLived);

      expect(lifetime(user.token)).toBe(4 * 60 * 60); // the default app of this file
      expect(lifetime(token)).toBe(90);
    });
  });

  describe('PUT /api/uploads/user/:id (C10 route-level parser)', () => {
    let upload: ReturnType<typeof stubMediaClient>['upload'];

    beforeEach(() => {
      ({ upload } = stubMediaClient(NEW_ASSET));
    });

    const replaceImage = () => request(server).put(`/api/uploads/user/${user.id}`).set('x-token', user.token);

    test('a file-only upload reaches the media controller from its per-request temp folder', async () => {
      const res = await replaceImage().attach('file', PNG, 'avatar.png');

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ uid: user.id, image: NEW_ASSET });
      expect(upload).toHaveBeenCalledWith(expect.stringContaining(path.join(os.tmpdir(), 'upload-')));
    });

    test('the fields of a file + fields upload never reach the record', async () => {
      const res = await replaceImage()
        .field('name', 'Renamed Through Multipart')
        .field('image', 'https://evil.example/x.png')
        .attach('file', PNG, 'avatar.png');

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ uid: user.id, name: 'Platform User', image: NEW_ASSET });
      expect(upload).toHaveBeenCalledWith(expect.stringContaining(path.join(os.tmpdir(), 'upload-')));
    });
  });
});
