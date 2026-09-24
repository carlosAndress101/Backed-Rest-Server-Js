import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import request, { type Test } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { expectStatus } from '../../helpers/assert';
import { authHeader, createAdmin, createProduct, createUser, tokenFor } from '../../helpers/factories';
import { legacyModels, stubCloudinary, type LegacyDoc } from '../../helpers/legacy';
import { listTempFiles, resetUploadDirs, waitForNoTempLeak } from '../../helpers/uploads';

const { User } = legacyModels();

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const SECURE_URL = 'https://res.cloudinary.com/demo/image/upload/v1/uploaded.png';

const UPLOADS_DIR = path.join(__dirname, '..', '..', '..', 'uploads');

const attach = (test: Test, filename = 'photo.jpg') => test.attach('file', JPEG, filename);

const writeUpload = (folder: string, name: string, bytes: Buffer) => {
  const target = path.join(UPLOADS_DIR, folder, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
};

describe('media write policy and file serving', () => {
  let app: Server;
  let upload: ReturnType<typeof stubCloudinary>['upload'];
  let destroy: ReturnType<typeof stubCloudinary>['destroy'];

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await stopTestApp();
    resetUploadDirs();
  });

  beforeEach(async () => {
    await clearDatabase();
    resetUploadDirs();
    ({ upload, destroy } = stubCloudinary());
    upload.mockResolvedValue({ secure_url: SECURE_URL });
    destroy.mockResolvedValue({ result: 'ok' });
  });

  describe('SEC-03 POST /api/uploads is admin-only', () => {
    test('without a token it is 401', async () => {
      const res = await attach(request(app).post('/api/uploads'));
      expect(res.statusCode).toBe(401);
    });

    test('with a non-admin token it is 403', async () => {
      const user = await createUser();
      const token = await tokenFor(user);

      const res = await attach(request(app).post('/api/uploads').set(authHeader(token)));
      expect(res.statusCode).toBe(403);
    });

    test('with an admin token it stores the file', async () => {
      const admin = await createAdmin();
      const token = await tokenFor(admin);

      const res = await attach(request(app).post('/api/uploads').set(authHeader(token)));

      expectStatus(res, 200);
      expect(typeof res.body.fullName).toBe('string');
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

  describe('SEC-04 GET /api/uploads/:collection/:id cannot read arbitrary files', () => {
    test('a traversal image value yields the placeholder, not the file', async () => {
      const user = await createUser({ image: '../../package.json' });

      const res = await request(app).get(`/api/uploads/user/${user.id}`);

      expectStatus(res, 200);
      expect(res.headers['content-type']).toMatch(/^image\//);
    });

    test('a nested value that is not a bare filename yields the placeholder', async () => {
      writeUpload('user', path.join('sub', 'secret.txt'), Buffer.from('TOP-SECRET-LEAK'));

      const user = await createUser({ image: 'sub/secret.txt' });
      const res = await request(app).get(`/api/uploads/user/${user.id}`);

      expectStatus(res, 200);
      expect(res.headers['content-type']).toMatch(/^image\//);
    });

    test('a normal bare filename is still served', async () => {
      const name = 'plain-ok.jpg';
      writeUpload('user', name, JPEG);

      const user = await createUser({ image: name });
      const res = await request(app).get(`/api/uploads/user/${user.id}`);

      expectStatus(res, 200);
      expect(res.headers['content-type']).toMatch(/^image\//);
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect(Buffer.compare(res.body, JPEG)).toBe(0);
    });
  });

  describe('SEC-08 upload hardening', () => {
    test('the extension check is case-insensitive', async () => {
      const admin = await createAdmin();
      const token = await tokenFor(admin);

      const res = await attach(request(app).post('/api/uploads').set(authHeader(token)), 'PHOTO.JPG');

      expectStatus(res, 200);
    });

    test('an upload larger than 5 MB is rejected with 413', async () => {
      const admin = await createAdmin();
      const token = await tokenFor(admin);
      const before = listTempFiles();
      const tooBig = Buffer.alloc(5 * 1024 * 1024 + 1024, 1);

      const res = await request(app)
        .post('/api/uploads')
        .set(authHeader(token))
        .attach('file', tooBig, 'too-big.jpg');

      expect(res.statusCode).toBe(413);
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
