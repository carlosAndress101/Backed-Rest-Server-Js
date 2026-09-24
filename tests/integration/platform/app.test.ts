import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { v2 as cloudinary } from 'cloudinary';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearLogs, loggedText, startTestApp, stopTestApp } from '../../helpers/app';
import { logRecords, requestSeenByApp, signIn, type SignedIn } from './support';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NEW_ASSET = 'https://res.cloudinary.com/demo/image/upload/v1/platform-asset.png';
const PNG = Buffer.from('not really a png: the upload route checks only the extension');

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

    test('a CastError is 400 BAD_REQUEST', async () => {
      const category = await createCategory('PLATFORM CAST');

      const res = await request(server)
        .post('/api/product')
        .set('x-token', admin.token)
        .send({ name: 'PLATFORM CAST PRODUCT', price: 'not-a-number', category: String(category._id) });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid request data' } });
    });

    test('malformed JSON is 400 BAD_REQUEST', async () => {
      const res = await request(server)
        .post('/api/category')
        .set('Content-Type', 'application/json')
        .send('{"name":');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid request data' } });
    });

    test('JSON over 100 kb is 413 BAD_REQUEST', async () => {
      const res = await request(server)
        .post('/api/category')
        .send({ name: 'x'.repeat(120 * 1024) });

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid request data' } });
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
      const res = await request(server).get('/hello').set('x-request-id', 'client-id_1.2:3');

      expect(res.headers['x-request-id']).toBe('client-id_1.2:3');
    });

    test('a UUID v4 is generated when the header is absent', async () => {
      const res = await request(server).get('/hello');

      expect(res.headers['x-request-id']).toMatch(UUID_V4);
    });

    test.each(['has spaces', 'x'.repeat(129), 'line\\nbreak', ''])(
      'an unsafe inbound id (case %#) is replaced by a UUID v4',
      async (inbound) => {
        const res = await request(server).get('/hello').set('x-request-id', inbound);

        expect(res.headers['x-request-id']).toMatch(UUID_V4);
      },
    );
  });

  describe('security headers and CORS', () => {
    test('there is no x-powered-by header', async () => {
      const res = await request(server).get('/hello');

      expect(res.headers).not.toHaveProperty('x-powered-by');
    });

    test('the CSP and COOP keep the T1.3 Google sign-in and font sources', async () => {
      const res = await request(server).get('/');
      const csp = res.headers['content-security-policy'];

      expect(csp).toContain("script-src 'self' https://accounts.google.com/gsi/client");
      expect(csp).toContain('https://accounts.google.com/gsi/style https://fonts.googleapis.com');
      expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
      expect(csp).toContain('frame-src https://accounts.google.com/gsi/');
      expect(csp).toContain("connect-src 'self' https://accounts.google.com/gsi/");
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });

    test('CORS allows any origin by default', async () => {
      const res = await request(server).get('/hello').set('Origin', 'https://anyone.example');

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    test('with CORS_ORIGINS, an allowlisted origin is echoed and any other gets no CORS header', async () => {
      const allowlisted = await startTestApp({ CORS_ORIGINS: 'https://shop.example, https://admin.example' });

      const allowed = await request(allowlisted).get('/hello').set('Origin', 'https://admin.example');
      const other = await request(allowlisted).get('/hello').set('Origin', 'https://evil.example');

      expect(allowed.headers['access-control-allow-origin']).toBe('https://admin.example');
      expect(other.headers).not.toHaveProperty('access-control-allow-origin');
    });
  });

  describe('the legacy mount', () => {
    test('GET /hello answers {name:"caan"}', async () => {
      const res = await request(server).get('/hello');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ name: 'caan' });
    });

    test('GET / serves the demo page from public/', async () => {
      const res = await request(server).get('/');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.text).toContain('<title>Login Google</title>');
    });

    test('a legacy request without a body sees req.body as {} (Express 4 parity)', async () => {
      const { req } = await requestSeenByApp(server, () => request(server).get('/api/category'));

      expect(req.body).toEqual({});
      expect(Object.getPrototypeOf(req.body)).toBe(Object.prototype);
    });

    test('a bodiless PUT /api/user/:id by the owner is a 200 no-op (Express 4 parity)', async () => {
      const res = await request(server).put(`/api/user/${user.id}`).set('x-token', user.token);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ uid: user.id, name: 'Platform User' });
    });

    test('C10: a multipart body sent to a non-upload route is ignored', async () => {
      const { req, res } = await requestSeenByApp(server, () =>
        request(server)
          .put(`/api/user/${user.id}`)
          .set('x-token', user.token)
          .field('name', 'Renamed Through Multipart'),
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ uid: user.id, name: 'Platform User' });
      expect(req.body).toEqual({});
    });

    // PUT /api/uploads/:collection/:id sends the file to Cloudinary (stubbed) and never writes under uploads/,
    // which tests/integration/security/uploads.test.ts owns and resets while other files run (TEST-03).
    describe('PUT /api/uploads/user/:id (C10 router-level parser)', () => {
      let upload: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        upload = vi
          .spyOn(cloudinary.uploader, 'upload')
          .mockResolvedValue({ secure_url: NEW_ASSET } as never);
        vi.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' });
      });

      const replaceImage = () =>
        request(server).put(`/api/uploads/user/${user.id}`).set('x-token', user.token);

      test('a file-only upload reaches the controller with req.body = {} (a plain object)', async () => {
        const { req, res } = await requestSeenByApp(server, () =>
          replaceImage().attach('file', PNG, 'avatar.png'),
        );

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ uid: user.id, image: NEW_ASSET });
        expect(upload).toHaveBeenCalledWith(expect.stringContaining(path.join(os.tmpdir(), 'upload-')));
        expect(req.body).toEqual({});
        expect(Object.getPrototypeOf(req.body)).toBe(Object.prototype);
      });

      test('the fields of a file + fields upload land on a plain object', async () => {
        const { req, res } = await requestSeenByApp(server, () =>
          replaceImage().field('note', 'hello').attach('file', PNG, 'avatar.png'),
        );

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ uid: user.id, image: NEW_ASSET });
        expect(upload).toHaveBeenCalledWith(expect.stringContaining(path.join(os.tmpdir(), 'upload-')));
        expect(req.body).toEqual({ note: 'hello' });
        expect(Object.getPrototypeOf(req.body)).toBe(Object.prototype);
      });
    });
  });
});
