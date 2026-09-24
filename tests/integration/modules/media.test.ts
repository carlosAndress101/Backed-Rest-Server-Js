// The media contract, §6 rows #20–#22 (M3 design §5.5, ADR-030, AM-M3-1), over HTTP through createApp.
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import mongoose from 'mongoose';
import request, { type Test } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { expectStatus } from '../../helpers/assert';
import { authHeader, createAdmin, createProduct, createUser, tokenFor } from '../../helpers/factories';
import { legacyModels, type LegacyDoc } from '../../helpers/legacy';
import { listTempFiles, newTempFiles, stubMediaClient, waitForNoTempLeak } from '../../helpers/uploads';

const { User, Product } = legacyModels();

// The test env's CLOUDINARY_URL is cloudinary://key:secret@demo, so the app's own cloud is "demo".
const NEW_URL = 'https://res.cloudinary.com/demo/image/upload/v1700000000/new-image.png';
const OWN_URL = 'https://res.cloudinary.com/demo/image/upload/v1690000000/shop/avatar.jpg';
const MISSING_ID = new mongoose.Types.ObjectId().toHexString();

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const GIF = Buffer.from('474946383961010001000000003b', 'hex');
const BOUNDARY = 'media-boundary';

const envelopeError = (code: string, message: string) => ({ error: { code, message } });
const notAnImage = envelopeError('BAD_REQUEST', 'The file must be a PNG, JPEG or GIF image');
const malformed = envelopeError('BAD_REQUEST', 'Malformed multipart body');
const imageNotFound = envelopeError('NOT_FOUND', 'Image not found');
const invalidParam = (param: string) =>
  expect.objectContaining({
    error: expect.objectContaining({
      code: 'VALIDATION_FAILED',
      details: [expect.objectContaining({ path: param })],
    }),
  });

describe('media module (§6 #20–#22)', () => {
  let app: Server;
  let upload: ReturnType<typeof stubMediaClient>['upload'];
  let owner: LegacyDoc;
  let ownerToken: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(stopTestApp);

  beforeEach(async () => {
    await clearDatabase();
    ({ upload } = stubMediaClient(NEW_URL));
    owner = await createUser();
    ownerToken = await tokenFor(owner);
    adminToken = await tokenFor(await createAdmin());
  });

  const put = (url: string, token?: string): Test =>
    token ? request(app).put(url).set(authHeader(token)) : request(app).put(url);

  describe('#20 POST /api/uploads (removed, ADR-008)', () => {
    test('is 404 NOT_FOUND even for an admin with a file, and nothing is parsed', async () => {
      const before = listTempFiles();

      const res = await request(app)
        .post('/api/uploads')
        .set(authHeader(adminToken))
        .attach('file', JPEG, 'photo.jpg');

      expect(res.status).toBe(404);
      expect(res.body).toEqual(envelopeError('NOT_FOUND', 'Route not found'));
      expect(newTempFiles(before)).toEqual([]);
    });
  });

  describe('#21 PUT /api/uploads/:collection/:id', () => {
    test('the owner replaces their image: 200 env(record), stored, uploaded from a per-request temp folder', async () => {
      const res = await put(`/api/uploads/user/${owner.id}`, ownerToken).attach('file', JPEG, 'photo.jpg');

      expectStatus(res, 200);
      expect(res.body.data).toMatchObject({ name: owner.name, email: owner.email, image: NEW_URL });
      expect(res.body.data).not.toHaveProperty('password');
      expect((await User.findById(owner.id)).image).toBe(NEW_URL);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(upload).toHaveBeenCalledWith(expect.stringContaining(path.join(os.tmpdir(), 'upload-')));
    });

    test("an admin replaces another user's image: 200", async () => {
      const res = await put(`/api/uploads/user/${owner.id}`, adminToken).attach('file', JPEG, 'photo.jpg');

      expectStatus(res, 200);
      expect(res.body.data.image).toBe(NEW_URL);
    });

    test('an admin replaces a product image: 200 env(product)', async () => {
      const product = await createProduct();

      const res = await put(`/api/uploads/product/${product.id}`, adminToken).attach(
        'file',
        JPEG,
        'photo.jpg',
      );

      expectStatus(res, 200);
      expect(res.body.data).toMatchObject({ name: product.name, image: NEW_URL });
      expect((await Product.findById(product.id)).image).toBe(NEW_URL);
    });

    test.each([
      ['PNG', PNG, 'image.png'],
      ['JPEG', JPEG, 'image.jpg'],
      ['GIF', GIF, 'image.gif'],
    ])('a %s is accepted by its magic bytes, whatever its name', async (_type, bytes, name) => {
      const res = await put(`/api/uploads/user/${owner.id}`, ownerToken).attach('file', bytes, {
        filename: name.replace(/\.\w+$/, '.bin'),
        contentType: 'application/octet-stream',
      });

      expectStatus(res, 200);
    });

    describe('SEC-03 authorization, before anything is parsed', () => {
      test.each(['user', 'product'])('without a token a %s image is 401', async (collection) => {
        const res = await put(`/api/uploads/${collection}/${owner.id}`).attach('file', JPEG, 'photo.jpg');

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      });

      test("another user's image is 403 and stays unchanged", async () => {
        const res = await put(`/api/uploads/user/${owner.id}`, await tokenFor(await createUser())).attach(
          'file',
          JPEG,
          'photo.jpg',
        );

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect((await User.findById(owner.id)).image).toBeUndefined();
        expect(upload).not.toHaveBeenCalled();
      });

      test('a product image is 403 for a non-admin', async () => {
        const product = await createProduct();

        const res = await put(`/api/uploads/product/${product.id}`, ownerToken).attach(
          'file',
          JPEG,
          'photo.jpg',
        );

        expect(res.status).toBe(403);
        expect(upload).not.toHaveBeenCalled();
      });

      test("T1.2 anti-chain: a product whose _id is the caller's own user id is still admin-only (403)", async () => {
        const product = await createProduct({ _id: owner._id });

        const res = await put(`/api/uploads/product/${owner.id}`, ownerToken).attach(
          'file',
          JPEG,
          'photo.jpg',
        );

        expect(res.status).toBe(403);
        expect((await Product.findById(product.id)).image).toBeUndefined();
        expect(upload).not.toHaveBeenCalled();
      });
    });

    describe('the param DTO (422) and the record (404)', () => {
      test('an invalid id is 422 with details', async () => {
        const res = await put('/api/uploads/user/not-a-mongo-id', adminToken).attach(
          'file',
          JPEG,
          'photo.jpg',
        );

        expect(res.status).toBe(422);
        expect(res.body).toEqual(invalidParam('id'));
      });

      test('a collection that is not allowed is 422 with details', async () => {
        const res = await put(`/api/uploads/role/${owner.id}`, adminToken).attach('file', JPEG, 'photo.jpg');

        expect(res.status).toBe(422);
        expect(res.body).toEqual(invalidParam('collection'));
      });

      test.each([
        ['user', 'User not found'],
        ['product', 'Product not found'],
      ])('a missing %s is 404 and nothing is uploaded', async (collection, message) => {
        const res = await put(`/api/uploads/${collection}/${MISSING_ID}`, adminToken).attach(
          'file',
          JPEG,
          'photo.jpg',
        );

        expect(res.status).toBe(404);
        expect(res.body).toEqual(envelopeError('NOT_FOUND', message));
        expect(upload).not.toHaveBeenCalled();
      });

      test('a soft-deleted user is 404 and nothing is uploaded', async () => {
        const retired = await createUser({ state: false });

        const res = await put(`/api/uploads/user/${retired.id}`, adminToken).attach(
          'file',
          JPEG,
          'photo.jpg',
        );

        expect(res.status).toBe(404);
        expect(res.body).toEqual(envelopeError('NOT_FOUND', 'User not found'));
        expect(upload).not.toHaveBeenCalled();
      });
    });

    describe('the file: one PNG, JPEG or GIF of at most 5 MB', () => {
      test('no multipart body is 400', async () => {
        const res = await put(`/api/uploads/user/${owner.id}`, ownerToken).send({ file: 'photo.jpg' });

        expect(res.status).toBe(400);
        expect(res.body).toEqual(envelopeError('BAD_REQUEST', 'No file was uploaded in the "file" field'));
      });

      test('a file in another field is 400', async () => {
        const res = await put(`/api/uploads/user/${owner.id}`, ownerToken).attach(
          'avatar',
          JPEG,
          'photo.jpg',
        );

        expect(res.status).toBe(400);
        expect(res.body).toEqual(envelopeError('BAD_REQUEST', 'No file was uploaded in the "file" field'));
      });

      test.each([
        [
          'a script named .png and sent as image/png',
          Buffer.from('<?php system($_GET["c"]); ?>'),
          'photo.png',
        ],
        [
          'an SVG',
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
          'x.svg',
        ],
        ['an HTML page', Buffer.from('<!doctype html><script>alert(1)</script>'), 'photo.jpg'],
        ['a PDF', Buffer.from('%PDF-1.7\n'), 'photo.gif'],
        ['a truncated PNG signature', PNG.subarray(0, 3), 'photo.png'],
        ['an empty file', Buffer.alloc(0), 'photo.jpg'],
      ])('%s is 400 by its magic bytes and never uploaded', async (_name, bytes, filename) => {
        const res = await put(`/api/uploads/user/${owner.id}`, ownerToken).attach('file', bytes, {
          filename,
          contentType: 'image/png',
        });

        expect(res.status).toBe(400);
        expect(res.body).toEqual(notAnImage);
        expect(upload).not.toHaveBeenCalled();
      });

      test('a malformed multipart body is 400 (HTTP-02)', async () => {
        const res = await put(`/api/uploads/user/${owner.id}`, ownerToken)
          .set('Content-Type', `multipart/form-data; boundary=${BOUNDARY}`)
          .send(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nnever terminated`);

        expect(res.status).toBe(400);
        expect(res.body).toEqual(malformed);
      });

      test('a multipart content type with an empty boundary is 400 (HTTP-02), though busboy throws', async () => {
        const res = await put(`/api/uploads/user/${owner.id}`, ownerToken)
          .set('Content-Type', 'multipart/form-data; boundary=')
          .send('whatever');

        expect(res.status).toBe(400);
        expect(res.body).toEqual(malformed);
      });

      test('a file larger than 5 MB is 413 with the JSON envelope (F4), never uploaded, and leaves no temp file', async () => {
        const before = listTempFiles();

        const res = await put(`/api/uploads/user/${owner.id}`, ownerToken).attach(
          'file',
          Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]),
          'too-big.jpg',
        );

        expect(res.status).toBe(413);
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(res.body).toEqual(envelopeError('PAYLOAD_TOO_LARGE', 'The file is larger than 5 MB'));
        expect(upload).not.toHaveBeenCalled();
        expect(await waitForNoTempLeak(before)).toEqual([]);
      });
    });
  });

  describe('#22 GET /api/uploads/:collection/:id (public)', () => {
    test('an own-cloud user image is a 302 to it', async () => {
      const user = await createUser({ image: OWN_URL });

      const res = await request(app).get(`/api/uploads/user/${user.id}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(OWN_URL);
    });

    test('an own-cloud product image is a 302 to it', async () => {
      const product = await createProduct({ image: NEW_URL });

      const res = await request(app).get(`/api/uploads/product/${product.id}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(NEW_URL);
    });

    // AM-M3-1: one test per rejected shape. Stored values are not trusted (image was mass-assignable before M1).
    test.each([
      ['no image', undefined],
      ['an empty image', ''],
      ['a Google avatar', 'https://lh3.googleusercontent.com/a/ACg8ocJ-avatar=s96-c'],
      ['a legacy bare filename (SEC-04)', '0c9e7b1e-3d4f-4a51-9d7e-2b8f6a1c5e90.jpg'],
      ['a traversal filename (SEC-04)', '../../package.json'],
      ['a nested relative path (SEC-04)', 'sub/secret.txt'],
      ['another host', 'https://evil.example/image.png'],
      ['a javascript: URL', 'javascript:alert(document.domain)'],
      ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
      ['a protocol-relative URL', '//evil.example/image.png'],
      ['a look-alike host', 'https://res.cloudinary.com.evil.example/demo/image/upload/v1/x.png'],
      ['userinfo before another host', 'https://res.cloudinary.com@evil.example/demo/image/upload/v1/x.png'],
      ['a different cloud', 'https://res.cloudinary.com/other-cloud/image/upload/v1/x.png'],
      ['a cloud whose name starts with ours', 'https://res.cloudinary.com/demo-evil/image/upload/v1/x.png'],
      ['plain http', 'http://res.cloudinary.com/demo/image/upload/v1/x.png'],
      ['an upper-case host', 'https://RES.CLOUDINARY.COM/demo/image/upload/v1/x.png'],
      ['an explicit port', 'https://res.cloudinary.com:443/demo/image/upload/v1/x.png'],
      [
        'a dot-dot step into another cloud',
        'https://res.cloudinary.com/demo/../other-cloud/image/upload/v1/x.png',
      ],
      ['an encoded dot-dot step', 'https://res.cloudinary.com/demo/%2e%2e/other-cloud/image/upload/v1/x.png'],
      ['a backslash step', 'https://res.cloudinary.com/demo/..\\other-cloud/image/upload/v1/x.png'],
      ['an encoded slash step', 'https://res.cloudinary.com/demo/..%2Fother-cloud/image/upload/v1/x.png'],
      [
        'a double-encoded dot-dot step',
        'https://res.cloudinary.com/demo/%252e%252e/other-cloud/image/upload/v1/x.png',
      ],
      [
        'an encoded control character after a dot-dot',
        'https://res.cloudinary.com/demo/%2e%2e%09/other-cloud/x.png',
      ],
      ['a query string', 'https://res.cloudinary.com/demo/image/upload/v1/x.png?next=https://evil.example'],
      [
        'a tab hidden in a dot-dot step',
        'https://res.cloudinary.com/demo/.\t./other-cloud/image/upload/v1/x.png',
      ],
      ['a CRLF header injection', 'https://res.cloudinary.com/demo/x.png\r\nSet-Cookie: session=evil'],
    ])('%s is 404, never a redirect', async (_shape, image) => {
      const user = await createUser({ image });

      const res = await request(app).get(`/api/uploads/user/${user.id}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(imageNotFound);
      expect(res.headers).not.toHaveProperty('location');
      expect(res.headers).not.toHaveProperty('set-cookie');
    });

    test.each([
      ['user', 'User not found'],
      ['product', 'Product not found'],
    ])('a missing %s is 404', async (collection, message) => {
      const res = await request(app).get(`/api/uploads/${collection}/${MISSING_ID}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(envelopeError('NOT_FOUND', message));
    });

    test('a soft-deleted user is 404, even with an own-cloud image', async () => {
      const retired = await createUser({ state: false, image: OWN_URL });

      const res = await request(app).get(`/api/uploads/user/${retired.id}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(envelopeError('NOT_FOUND', 'User not found'));
    });

    test('an invalid id is 422 with details', async () => {
      const res = await request(app).get('/api/uploads/user/not-a-mongo-id');

      expect(res.status).toBe(422);
      expect(res.body).toEqual(invalidParam('id'));
    });

    test('a collection that is not allowed is 422 with details', async () => {
      const res = await request(app).get(`/api/uploads/role/${owner.id}`);

      expect(res.status).toBe(422);
      expect(res.body).toEqual(invalidParam('collection'));
    });
  });
});
