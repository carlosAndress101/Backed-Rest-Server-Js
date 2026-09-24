// ARC-03: load models/server before any other application module.
require('../models/server');

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: {
      upload: jest.fn(),
      destroy: jest.fn(),
    },
  },
}));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const mongoose = require('mongoose');

const {
  connectDatabase,
  buildApp,
  closeServers,
  clearDatabase,
  createUser,
  createAdmin,
  tokenFor,
  authHeader,
  listTempFiles,
  newTempFiles,
  waitForNoTempLeak,
  User,
} = require('./helpers/db');

const cloudinary = require('cloudinary').v2;

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const SECURE_URL = 'https://res.cloudinary.com/demo/image/upload/v1/uploaded.png';
const BOUNDARY = 'm1-t17-boundary';

const attach = (test, field = 'file', filename = 'photo.jpg') => test.attach(field, JPEG, filename);

const filePartHead = (field, filename) =>
  Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      'Content-Type: image/jpeg\r\n\r\n'
  );

const sendRaw = (test, body) =>
  test.set('Content-Type', `multipart/form-data; boundary=${BOUNDARY}`).send(body);

/**
 * express-fileupload opens every temp file with fs.createWriteStream. Counting
 * those calls proves a request never wrote one, even a file removed right away.
 */
const tempWrites = () =>
  fs.createWriteStream.mock.calls
    .map(([file]) => String(file))
    .filter((file) => path.basename(file).startsWith('tmp-'));

describe('SEC-08 / C10 multipart bodies are parsed only by the upload routes, after auth', () => {
  let app;
  let before;

  beforeAll(async () => {
    await connectDatabase();
    app = await buildApp();
  });

  // Every request here is either rejected or goes to the mocked Cloudinary, so
  // nothing is written under uploads/ (uploads.e2e.js owns that tree).
  afterAll(async () => {
    await closeServers();
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await clearDatabase();
    cloudinary.uploader.upload.mockReset();
    cloudinary.uploader.upload.mockResolvedValue({ secure_url: SECURE_URL });
    cloudinary.uploader.destroy.mockReset();
    cloudinary.uploader.destroy.mockResolvedValue({ result: 'ok' });
    jest.spyOn(fs, 'createWriteStream');
    before = listTempFiles();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a rejected upload request never writes a temp file', () => {
    // Each case resolves to [method, url, token]; the request is built in the test.
    const cases = [
      ['POST /api/uploads without a token', 401, async () => ['post', '/api/uploads']],
      [
        'POST /api/uploads with a USER token',
        403,
        async () => ['post', '/api/uploads', await tokenFor(await createUser())],
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
        'PUT /api/uploads/user/:id with an invalid id',
        400,
        async () => ['put', '/api/uploads/user/not-a-mongo-id', await tokenFor(await createAdmin())],
      ],
      [
        'PUT /api/uploads/:collection/:id with a collection that is not allowed',
        400,
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
        request(app).post('/api/auth/login').field('email', user.email).field('password', 'test-password-123')
      );

      expect(res.statusCode).toBe(400);
      expect(tempWrites()).toEqual([]);
      expect(newTempFiles(before)).toEqual([]);
    });

    test('POST /api/user does not parse multipart fields or files', async () => {
      const res = await attach(
        request(app)
          .post('/api/user')
          .field('name', 'Multipart')
          .field('email', 'multipart@example.com')
          .field('password', 'multipart-pass-1')
      );

      expect(res.statusCode).toBe(400);
      expect(await User.countDocuments({ email: 'multipart@example.com' })).toBe(0);
      expect(tempWrites()).toEqual([]);
      expect(newTempFiles(before)).toEqual([]);
    });

    test('PUT /api/user/:id ignores multipart fields', async () => {
      const owner = await createUser({ name: 'Original' });

      const res = await attach(
        request(app).put(`/api/user/${owner.id}`).set(authHeader(await tokenFor(owner))).field('name', 'Changed')
      );

      expect(res.statusCode).toBe(200);
      expect((await User.findById(owner.id)).name).toBe('Original');
      expect(tempWrites()).toEqual([]);
    });
  });

  describe('every temp file the parser writes is removed', () => {
    let adminToken;

    beforeEach(async () => {
      adminToken = await tokenFor(await createAdmin());
    });

    test('after a fileValid rejection (the file is not in the "file" field)', async () => {
      const res = await attach(request(app).post('/api/uploads').set(authHeader(adminToken)), 'other');

      expect(res.statusCode).toBe(400);
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after an extension rejection', async () => {
      const res = await attach(request(app).post('/api/uploads').set(authHeader(adminToken)), 'file', 'evil.txt');

      expect(res.statusCode).toBe(400);
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after a 413 for a file larger than 5 MB', async () => {
      const res = await request(app)
        .post('/api/uploads')
        .set(authHeader(adminToken))
        .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1024, 1), 'too-big.jpg');

      expect(res.statusCode).toBe(413);
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('a two-file request writes and uploads only one file and leaves none', async () => {
      const owner = await createUser();

      const res = await attach(
        attach(request(app).put(`/api/uploads/user/${owner.id}`).set(authHeader(await tokenFor(owner))))
      );

      expect(res.statusCode).toBe(200);
      expect(cloudinary.uploader.upload).toHaveBeenCalledTimes(1);
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after a controller error (Cloudinary upload fails)', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      cloudinary.uploader.upload.mockRejectedValueOnce(new Error('cloudinary is down'));
      const owner = await createUser();

      const res = await attach(request(app).put(`/api/uploads/user/${owner.id}`).set(authHeader(await tokenFor(owner))));

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ msg: 'Internal server error' });
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after a parse error that follows a complete file part', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const body = Buffer.concat([
        filePartHead('file', 'photo.jpg'),
        JPEG,
        Buffer.from(`\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nnever terminated`),
      ]);

      const res = await sendRaw(request(app).post('/api/uploads').set(authHeader(adminToken)), body);

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(tempWrites()).toHaveLength(1);
      expect(await waitForNoTempLeak(before)).toEqual([]);
    });

    test('after a body that ends in the middle of the file', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const body = Buffer.concat([filePartHead('file', 'photo.jpg'), JPEG]);

      const res = await sendRaw(request(app).post('/api/uploads').set(authHeader(adminToken)), body);

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(await waitForNoTempLeak(before)).toEqual([]);

      // the process still serves the next request
      expect((await request(app).get('/api/uploads/user/not-a-mongo-id')).statusCode).toBe(400);
    });
  });
});
