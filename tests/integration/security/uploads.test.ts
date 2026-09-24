import type { Server } from 'node:http';

import request, { type Test } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { expectStatus } from '../../helpers/assert';
import { authHeader, createAdmin, createProduct, createUser, tokenFor } from '../../helpers/factories';
import { legacyModels, type LegacyDoc } from '../../helpers/legacy';
import { listTempFiles, stubMediaClient, waitForNoTempLeak } from '../../helpers/uploads';

const { User } = legacyModels();

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const SECURE_URL = 'https://res.cloudinary.com/demo/image/upload/v1/uploaded.png';

const attach = (test: Test, filename = 'photo.jpg') => test.attach('file', JPEG, filename);

describe('media write policy and file serving', () => {
  let app: Server;
  let upload: ReturnType<typeof stubMediaClient>['upload'];
  let destroy: ReturnType<typeof stubMediaClient>['destroy'];

  beforeAll(async () => {
    app = await startTestApp();
  });

  // ADR-030: nothing is ever written under uploads/ (TEST-03); the Cloudinary client is stubbed.
  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await clearDatabase();
    ({ upload, destroy } = stubMediaClient(SECURE_URL));
  });

  // ADR-030 (§6 #20): the local-disk upload is removed, so it is no longer a write route at all.
  describe('SEC-03 POST /api/uploads is removed (404)', () => {
    test('without a token it is 404', async () => {
      const res = await attach(request(app).post('/api/uploads'));
      expect(res.statusCode).toBe(404);
    });

    test('with a non-admin token it is 404', async () => {
      const user = await createUser();
      const token = await tokenFor(user);

      const res = await attach(request(app).post('/api/uploads').set(authHeader(token)));
      expect(res.statusCode).toBe(404);
    });

    test('with an admin token it is 404 and stores nothing', async () => {
      const admin = await createAdmin();
      const token = await tokenFor(admin);

      const res = await attach(request(app).post('/api/uploads').set(authHeader(token)));

      expectStatus(res, 404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
      expect(upload).not.toHaveBeenCalled();
    });
  });

  describe('SEC-03 PUT /api/uploads/user/:id is owner-or-admin', () => {
    test('without a token it is 401', async () => {
      const owner = await createUser();
      const res = await attach(request(app).put(`/api/uploads/user/${owner.id}`));
      expect(res.statusCode).toBe(401);
    });

    test('for another user it is 403', async () => {
      const owner = await createUser();
      const attacker = await createUser();
      const token = await tokenFor(attacker);

      const res = await attach(request(app).put(`/api/uploads/user/${owner.id}`).set(authHeader(token)));

      expect(res.statusCode).toBe(403);

      const untouched = await User.findById(owner.id);
      expect(untouched.image).toBeUndefined();
    });

    test('for the owner it is 200 and stores the Cloudinary URL', async () => {
      const owner = await createUser();
      const token = await tokenFor(owner);

      const res = await attach(request(app).put(`/api/uploads/user/${owner.id}`).set(authHeader(token)));

      expectStatus(res, 200);

      const updated = await User.findById(owner.id);
      expect(updated.image).toBe(SECURE_URL);
    });

    test('for an admin it is 200', async () => {
      const owner = await createUser();
      const admin = await createAdmin();
      const token = await tokenFor(admin);

      const res = await attach(request(app).put(`/api/uploads/user/${owner.id}`).set(authHeader(token)));

      expectStatus(res, 200);
    });
  });

  describe('C7 PUT /api/uploads/product/:id is admin-only', () => {
    let product: LegacyDoc;

    beforeEach(async () => {
      product = await createProduct();
    });

    test('without a token it is 401', async () => {
      const res = await attach(request(app).put(`/api/uploads/product/${product.id}`));
      expect(res.statusCode).toBe(401);
    });

    test('with a non-admin token it is 403', async () => {
      const user = await createUser();
      const token = await tokenFor(user);

      const res = await attach(request(app).put(`/api/uploads/product/${product.id}`).set(authHeader(token)));

      expect(res.statusCode).toBe(403);
    });

    test('with an admin token it is 200', async () => {
      const admin = await createAdmin();
      const token = await tokenFor(admin);

      const res = await attach(request(app).put(`/api/uploads/product/${product.id}`).set(authHeader(token)));

      expectStatus(res, 200);
    });
  });

  // ADR-030 / AM-M3-1: nothing is served from disk any more; a stored value that is not an asset of the app's
  // own Cloudinary cloud is a 404 (was the notFound.jpg placeholder, or the file itself for a bare filename).
  describe('SEC-04 GET /api/uploads/:collection/:id cannot read arbitrary files', () => {
    const imageNotFound = { error: { code: 'NOT_FOUND', message: 'Image not found' } };

    test('a traversal image value is 404, not the file', async () => {
      const user = await createUser({ image: '../../package.json' });

      const res = await request(app).get(`/api/uploads/user/${user.id}`);

      expectStatus(res, 404);
      expect(res.body).toEqual(imageNotFound);
    });

    test('a nested value that is not a bare filename is 404', async () => {
      const user = await createUser({ image: 'sub/secret.txt' });
      const res = await request(app).get(`/api/uploads/user/${user.id}`);

      expectStatus(res, 404);
      expect(res.body).toEqual(imageNotFound);
    });

    test('a bare filename is no longer served from disk: 404', async () => {
      const user = await createUser({ image: 'plain-ok.jpg' });
      const res = await request(app).get(`/api/uploads/user/${user.id}`);

      expectStatus(res, 404);
      expect(res.body).toEqual(imageNotFound);
    });

    test('only an own-cloud Cloudinary asset is served, as a 302 to it', async () => {
      const user = await createUser({ image: SECURE_URL });
      const res = await request(app).get(`/api/uploads/user/${user.id}`);

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(SECURE_URL);
    });
  });

  describe('SEC-08 upload hardening', () => {
    test('an upper-case extension is accepted: the type comes from the bytes', async () => {
      const owner = await createUser();
      const token = await tokenFor(owner);

      const res = await attach(
        request(app).put(`/api/uploads/user/${owner.id}`).set(authHeader(token)),
        'PHOTO.JPG',
      );

      expectStatus(res, 200);
    });

    test('a file whose bytes are not an image is rejected with 400, whatever its name', async () => {
      const owner = await createUser();
      const token = await tokenFor(owner);

      const res = await request(app)
        .put(`/api/uploads/user/${owner.id}`)
        .set(authHeader(token))
        .attach('file', Buffer.from('<script>alert(1)</script>'), 'photo.jpg');

      expectStatus(res, 400);
      expect(upload).not.toHaveBeenCalled();
    });

    test('an upload larger than 5 MB is rejected with 413', async () => {
      const owner = await createUser();
      const token = await tokenFor(owner);
      const before = listTempFiles();
      const tooBig = Buffer.alloc(5 * 1024 * 1024 + 1024, 1);

      const res = await request(app)
        .put(`/api/uploads/user/${owner.id}`)
        .set(authHeader(token))
        .attach('file', tooBig, 'too-big.jpg');

      expect(res.statusCode).toBe(413);
      expect(res.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'The file is larger than 5 MB' } });
      // C10: the aborted upload leaves nothing in the temp dir.
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });
  });

  describe('CQ-04 temp upload files are always cleaned up', () => {
    test('after a successful Cloudinary upload', async () => {
      const owner = await createUser();
      const token = await tokenFor(owner);
      const before = listTempFiles();

      const res = await attach(request(app).put(`/api/uploads/user/${owner.id}`).set(authHeader(token)));

      expectStatus(res, 200);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after a failed Cloudinary upload the request still answers and cleans up', async () => {
      upload.mockRejectedValueOnce(new Error('cloudinary is down'));

      const owner = await createUser();
      const token = await tokenFor(owner);
      const before = listTempFiles();

      const res = await attach(request(app).put(`/api/uploads/user/${owner.id}`).set(authHeader(token)));

      expect(typeof res.statusCode).toBe('number');
      expect(res.headers['content-type']).toMatch(/json/);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('a Cloudinary destroy failure is non-fatal and still cleans up', async () => {
      destroy.mockRejectedValueOnce(new Error('destroy is down'));

      const owner = await createUser({
        image: 'https://res.cloudinary.com/demo/image/upload/v1/old.png',
      });
      const token = await tokenFor(owner);
      const before = listTempFiles();

      const res = await attach(request(app).put(`/api/uploads/user/${owner.id}`).set(authHeader(token)));

      expectStatus(res, 200);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });
  });
});
