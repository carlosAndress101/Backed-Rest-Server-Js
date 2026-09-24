import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import mongoose from 'mongoose';
import request, { type Test } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { expectStatus } from '../../helpers/assert';
import { authHeader, createAdmin, createProduct, createUser, tokenFor } from '../../helpers/factories';
import { legacyModels } from '../../helpers/legacy';
import { listTempFiles, newTempFiles, stubMediaClient, waitForNoTempLeak } from '../../helpers/uploads';

const { User } = legacyModels();

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const SECURE_URL = 'https://res.cloudinary.com/demo/image/upload/v1/uploaded.png';
const BOUNDARY = 'm1-t17-boundary';

const attach = (test: Test, field = 'file', filename = 'photo.jpg') => test.attach(field, JPEG, filename);

const filePartHead = (field: string, filename: string) =>
  Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      'Content-Type: image/jpeg\r\n\r\n',
  );

const sendRaw = (test: Test, body: Buffer) =>
  test.set('Content-Type', `multipart/form-data; boundary=${BOUNDARY}`).send(body);

/**
 * express-fileupload opens every temp file with fs.createWriteStream. Counting
 * those calls proves a request never wrote one, even a file removed right away.
 */
const tempWrites = () =>
  vi
    .mocked(fs.createWriteStream)
    .mock.calls.map(([file]) => String(file))
    .filter((file) => path.basename(file).startsWith('tmp-'));

describe('SEC-08 / C10 multipart bodies are parsed only by the upload routes, after auth', () => {
  let app: Server;
  let before: Set<string>;
  let upload: ReturnType<typeof stubMediaClient>['upload'];

  beforeAll(async () => {
    app = await startTestApp();
  });

  // Every request here is either rejected or goes to the stubbed Cloudinary client, so
  // nothing is written outside the per-request temp folder (ADR-030, TEST-03).
  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await clearDatabase();
    ({ upload } = stubMediaClient(SECURE_URL));
    vi.spyOn(fs, 'createWriteStream');
    before = listTempFiles();
  });

  describe('a rejected upload request never writes a temp file', () => {
    // Each case resolves to [method, url, token]; the request is built in the test.
    const cases: Array<
      [string, number, () => Promise<[method: 'post' | 'put', url: string, token?: string]>]
    > = [
      // ADR-030: POST /api/uploads is removed, so no parser runs for it at all.
      ['POST /api/uploads without a token', 404, async () => ['post', '/api/uploads']],
      [
        'POST /api/uploads with a USER token',
        404,
        async () => ['post', '/api/uploads', await tokenFor(await createUser())],
      ],
      [
        'PUT /api/uploads/user/:id without a token',
        401,
        async () => ['put', `/api/uploads/user/${(await createUser()).id}`],
      ],
      [
        'PUT /api/uploads/user/:id for another user',
        403,
        async () => {
          const victim = await createUser();
          return ['put', `/api/uploads/user/${victim.id}`, await tokenFor(await createUser())];
        },
      ],
      [
        'PUT /api/uploads/product/:id with a USER token',
        403,
        async () => [
          'put',
          `/api/uploads/product/${(await createProduct()).id}`,
          await tokenFor(await createUser()),
        ],
      ],
      [
        "PUT /api/uploads/product/:id whose _id is the caller's own user id (T1.2 anti-chain)",
        403,
        async () => {
          const user = await createUser();
          await createProduct({ _id: user._id });
          return ['put', `/api/uploads/product/${user.id}`, await tokenFor(user)];
        },
      ],
      [
        'PUT /api/uploads/user/:id with an invalid id',
        422,
        async () => ['put', '/api/uploads/user/not-a-mongo-id', await tokenFor(await createAdmin())],
      ],
      [
        'PUT /api/uploads/:collection/:id with a collection that is not allowed',
        422,
        async () => {
          const admin = await createAdmin();
          return ['put', `/api/uploads/role/${admin.id}`, await tokenFor(admin)];
        },
      ],
    ];

    test.each(cases)('%s is %i and writes nothing', async (name, status, setup) => {
      const [method, url, token] = await setup();
      const test = request(app)[method](url);

      const res = await attach(token ? test.set(authHeader(token)) : test);

      expect(res.statusCode).toBe(status);
      expect(tempWrites()).toEqual([]);
      expect(newTempFiles(before)).toEqual([]);
    });
  });

  describe('every other route ignores multipart bodies', () => {
    test('POST /api/auth/login does not parse multipart fields or files', async () => {
      const user = await createUser();

      const res = await attach(
        request(app)
          .post('/api/auth/login')
          .field('email', user.email)
          .field('password', 'test-password-123'),
      );

      expect(res.statusCode).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(tempWrites()).toEqual([]);
      expect(newTempFiles(before)).toEqual([]);
    });

    test('POST /api/user does not parse multipart fields or files', async () => {
      const res = await attach(
        request(app)
          .post('/api/user')
          .field('name', 'Multipart')
          .field('email', 'multipart@example.com')
          .field('password', 'multipart-pass-1'),
      );

      expect(res.statusCode).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(await User.countDocuments({ email: 'multipart@example.com' })).toBe(0);
      expect(tempWrites()).toEqual([]);
      expect(newTempFiles(before)).toEqual([]);
    });

    test('PUT /api/user/:id ignores multipart fields', async () => {
      const owner = await createUser({ name: 'Original' });

      const res = await attach(
        request(app)
          .put(`/api/user/${owner.id}`)
          .set(authHeader(await tokenFor(owner)))
          .field('name', 'Changed'),
      );

      expectStatus(res, 200);
      expect((await User.findById(owner.id)).name).toBe('Original');
      expect(tempWrites()).toEqual([]);
    });
  });

  describe('every temp file the parser writes is removed', () => {
    let adminToken: string;
    let target: string;

    beforeEach(async () => {
      adminToken = await tokenFor(await createAdmin());
      target = `/api/uploads/user/${(await createUser()).id}`;
    });

    test('after a no-file rejection (the file is not in the "file" field)', async () => {
      const res = await attach(request(app).put(target).set(authHeader(adminToken)), 'other');

      expect(res.statusCode).toBe(400);
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after a MIME rejection (the bytes are not an image)', async () => {
      const res = await request(app)
        .put(target)
        .set(authHeader(adminToken))
        .attach('file', Buffer.from('not an image'), 'evil.jpg');

      expect(res.statusCode).toBe(400);
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after a 413 for a file larger than 5 MB', async () => {
      const res = await request(app)
        .put(target)
        .set(authHeader(adminToken))
        .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1024, 1), 'too-big.jpg');

      expect(res.statusCode).toBe(413);
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('a two-file request writes and uploads only one file and leaves none', async () => {
      const owner = await createUser();

      const res = await attach(
        attach(
          request(app)
            .put(`/api/uploads/user/${owner.id}`)
            .set(authHeader(await tokenFor(owner))),
        ),
      );

      expectStatus(res, 200);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after a 404 (the record does not exist; the parser ran first)', async () => {
      const res = await attach(
        request(app)
          .put(`/api/uploads/user/${new mongoose.Types.ObjectId().toHexString()}`)
          .set(authHeader(adminToken)),
      );

      expect(res.statusCode).toBe(404);
      expect(upload).not.toHaveBeenCalled();
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after a controller error (Cloudinary upload fails)', async () => {
      upload.mockRejectedValueOnce(new Error('cloudinary is down'));
      const owner = await createUser();

      const res = await attach(
        request(app)
          .put(`/api/uploads/user/${owner.id}`)
          .set(authHeader(await tokenFor(owner))),
      );

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after a parse error that follows a complete file part', async () => {
      const body = Buffer.concat([
        filePartHead('file', 'photo.jpg'),
        JPEG,
        Buffer.from(
          `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nnever terminated`,
        ),
      ]);

      const res = await sendRaw(request(app).put(target).set(authHeader(adminToken)), body);

      expect(res.statusCode).toBe(400); // HTTP-02
      expect(res.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Malformed multipart body' } });
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after a body that ends in the middle of the file', async () => {
      const body = Buffer.concat([filePartHead('file', 'photo.jpg'), JPEG]);

      const res = await sendRaw(request(app).put(target).set(authHeader(adminToken)), body);

      expect(res.statusCode).toBe(400); // HTTP-02
      expect(await waitForNoTempLeak(before)).toEqual([]);

      // the process still serves the next request
      expect((await request(app).get('/api/uploads/user/not-a-mongo-id')).statusCode).toBe(422);
    });
  });
});
