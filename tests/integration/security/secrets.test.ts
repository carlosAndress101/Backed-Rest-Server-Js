// P20 (M4 design §10.4, AM-M4-1, AM-M4-8): the password hash never leaves the database, on any response, read or
// log line, and the first-admin seed secret is never logged.
import type { Server } from 'node:http';

import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';

import { loadConfig } from '../../../src/config';
import { createLogger } from '../../../src/core/logger';
import { CategoryModel } from '../../../src/modules/categories';
import { ProductModel } from '../../../src/modules/products';
import { UserModel } from '../../../src/modules/users';
import { loggedText, startTestApp, stopTestApp } from '../../helpers/app';
import { stubGoogleClient } from '../../helpers/auth';
import {
  authHeader,
  createCategory,
  createProduct,
  createUser,
  hashPassword,
  tokenFor,
} from '../../helpers/factories';
import { stubMediaClient } from '../../helpers/uploads';

const ADMIN_PASSWORD = 'admin-secret-7Qx!';
const USER_PASSWORD = 'user-secret-3Rv!';
const NEW_PASSWORD = 'renewed-secret-9Kw!';
const BCRYPT = /\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ASSET = 'https://res.cloudinary.com/demo/image/upload/v1/secrets-asset.png';

/** Nothing of a password, hashed or not, in `text`. */
const expectNoPassword = (text: string) => {
  expect(text).not.toMatch(/"password"/);
  expect(text).not.toMatch(BCRYPT);
  for (const secret of [ADMIN_PASSWORD, USER_PASSWORD, NEW_PASSWORD]) expect(text).not.toContain(secret);
};

describe('P20 the password hash never leaves the database', () => {
  let app: Server;
  let client = 0;

  beforeAll(async () => {
    // debug: every request line and every logged error is written; behind a trusted proxy each auth request is
    // its own client, so the C5 limiter never answers here.
    app = await startTestApp({ LOG_LEVEL: 'debug', TRUST_PROXY: '1' });
  });

  afterAll(stopTestApp);

  const auth = (path: string, body: object) =>
    request(app)
      .post(path)
      .set('X-Forwarded-For', `203.0.113.${(client += 1)}`)
      .send(body);

  test('no response on any user-bearing path carries it, and neither does any log line', async () => {
    const admin = await createUser({
      role: 'ADMIN_ROLE',
      email: 'root@example.com',
      password: hashPassword(ADMIN_PASSWORD),
    });
    const user = await createUser({ email: 'ada@example.com', password: hashPassword(USER_PASSWORD) });
    const adminToken = await tokenFor(admin);
    const userToken = await tokenFor(user);
    const category = await createCategory({ user: admin });
    const product = await createProduct({ user: admin, category: category._id });
    stubGoogleClient({ name: 'Grace', email: 'grace@example.com', picture: 'https://example.com/g.png' });
    stubMediaClient(ASSET);

    const as = (token: string) => authHeader(token);
    const responses: Array<[string, Response]> = [
      [
        'sign-up',
        await request(app)
          .post('/api/user')
          .send({ name: 'Bo', email: 'Bo@Example.com', password: USER_PASSWORD }),
      ],
      ['login', await auth('/api/auth/login', { email: 'ROOT@example.com', password: ADMIN_PASSWORD })],
      ['failed login', await auth('/api/auth/login', { email: 'ada@example.com', password: ADMIN_PASSWORD })],
      ['Google sign-in', await auth('/api/auth/google', { id_token: 'google-id-token' })],
      ['user list', await request(app).get('/api/user').set(as(adminToken))],
      [
        'self update with a new password',
        await request(app).put(`/api/user/${user.id}`).set(as(userToken)).send({ password: NEW_PASSWORD }),
      ],
      [
        'admin update',
        await request(app).put(`/api/user/${user.id}`).set(as(adminToken)).send({ role: 'USER_ROLE' }),
      ],
      ['user search', await request(app).get('/api/search/user/example').set(as(adminToken))],
      ['user search by id', await request(app).get(`/api/search/user/${user.id}`).set(as(adminToken))],
      ['category list (populates user)', await request(app).get('/api/category')],
      ['category by id (populates user)', await request(app).get(`/api/category/${category.id}`)],
      [
        'category create',
        await request(app).post('/api/category').set(as(adminToken)).send({ name: 'secrets' }),
      ],
      [
        'category update',
        await request(app).put(`/api/category/${category.id}`).set(as(adminToken)).send({ name: 'renamed' }),
      ],
      ['product list (populates user)', await request(app).get('/api/product')],
      ['product by id (populates user)', await request(app).get(`/api/product/${product.id}`)],
      [
        'product create',
        await request(app)
          .post('/api/product')
          .set(as(adminToken))
          .send({ name: 'secret-thing', category: category.id }),
      ],
      [
        'product update',
        await request(app).put(`/api/product/${product.id}`).set(as(adminToken)).send({ price: 3 }),
      ],
      ['product search', await request(app).get('/api/search/product/secret')],
      [
        'user image replacement (the media record is the user)',
        await request(app)
          .put(`/api/uploads/user/${user.id}`)
          .set(as(userToken))
          .attach('file', PNG, 'me.png'),
      ],
      ['user delete', await request(app).delete(`/api/user/${user.id}`).set(as(adminToken))],
    ];

    const statuses = Object.fromEntries(responses.map(([name, res]) => [name, res.status]));
    expect(statuses).toMatchObject({
      login: 200,
      'failed login': 401,
      'Google sign-in': 200,
      'user list': 200,
      'user search': 200,
    });
    expect(responses.filter(([, res]) => res.status >= 500)).toEqual([]);
    for (const [, res] of responses) expectNoPassword(res.text);

    // the hashes really are in the database: the absence above is not an empty-data artefact
    expect((await UserModel.findById(user.id, '+password').lean())?.password).toMatch(BCRYPT);
    // one request line per response at least, so the log check below is not vacuous
    const logged = loggedText();
    expect(logged.match(/"responseTime"/g)?.length ?? 0).toBeGreaterThanOrEqual(responses.length);
    expectNoPassword(logged);
  });

  // AM-M4-1 closes the .lean()/projection class: toJSON never runs on a lean document, so select: false is the
  // only thing between a raw read and the hash.
  test('.lean() and populated reads carry no password', async () => {
    const owner = await createUser({ password: hashPassword(USER_PASSWORD) });
    const category = await createCategory({ user: owner });
    await createProduct({ user: owner, category: category._id });

    const reads = [
      await UserModel.findById(owner.id).lean(),
      await UserModel.find().lean(),
      await UserModel.findOne({ email: owner.email }).lean(),
      await UserModel.findOneAndUpdate(
        { _id: owner.id },
        { name: 'Renamed' },
        { returnDocument: 'after' },
      ).lean(),
      await CategoryModel.findById(category.id).populate('user').lean(),
      await ProductModel.find().populate('user').populate('category').lean(),
    ];

    expectNoPassword(JSON.stringify(reads));
  });
});

describe('AM-M4-8 the seed secret is never logged', () => {
  const SEED_SECRET = 'seed-admin-secret-4Tp!';

  test.each([
    ['the whole config', (config: ReturnType<typeof loadConfig>) => ({ config })],
    ['config.seed', (config: ReturnType<typeof loadConfig>) => ({ seed: config.seed })],
    [
      'a seed options object',
      () => ({ options: { adminEmail: 'admin@example.com', adminPassword: SEED_SECRET } }),
    ],
    ['the raw variable', () => ({ SEED_ADMIN_PASSWORD: SEED_SECRET })],
    [
      'the environment',
      () => ({ env: { SEED_ADMIN_EMAIL: 'admin@example.com', SEED_ADMIN_PASSWORD: SEED_SECRET } }),
    ],
  ])('%s is logged with the secret [REDACTED]', (_case, fields) => {
    const config = loadConfig({
      ...process.env,
      MONGO_CLOUD: inject('mongoUri'),
      SEED_ADMIN_EMAIL: 'admin@example.com',
      SEED_ADMIN_PASSWORD: SEED_SECRET,
    });
    const lines: string[] = [];
    const log = createLogger({ logLevel: 'info' }, { write: (line: string) => void lines.push(line) });

    log.info(fields(config), 'seed');

    expect(config.seed.adminPassword).toBe(SEED_SECRET); // the secret really was there to redact
    expect(lines.join('')).not.toContain(SEED_SECRET);
    expect(lines.join('')).toContain('[REDACTED]');
  });
});
