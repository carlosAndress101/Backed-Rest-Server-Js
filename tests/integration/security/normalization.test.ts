// DB-02 (M4 design §10.3, §10.5, AM-M4-5): emails are normalized and matched case-insensitively, names are unique
// whatever their case, and every schema cap has its DTO mirror, so oversize input is a 422, never the C1 400.
import type { Server } from 'node:http';

import bcrypt from 'bcrypt';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { CategoryModel } from '../../../src/modules/categories';
import { ProductModel } from '../../../src/modules/products';
import { UserModel } from '../../../src/modules/users';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { expectStatus } from '../../helpers/assert';
import { stubGoogleClient } from '../../helpers/auth';
import {
  authHeader,
  createAdmin,
  createCategory,
  createUser,
  hashPassword,
  tokenFor,
} from '../../helpers/factories';

const PASSWORD = 'correct-horse-battery';
const COST_10_HASH = /^\$2[ab]\$10\$[./A-Za-z0-9]{53}$/;
const EMAIL_TAKEN = { error: { code: 'CONFLICT', message: 'Email already registered' } };
const INVALID_CREDENTIALS = { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } };

/** The paths a 422 names. */
const detailPaths = (body: { error: { details?: Array<{ path: string }> } }) =>
  (body.error.details ?? []).map((issue) => issue.path);

describe('DB-02 email normalization, case-insensitive uniqueness and DTO caps', () => {
  let app: Server;
  let client = 0;

  beforeAll(async () => {
    // Behind a trusted proxy each auth request comes from its own client, so no test here meets the C5 limiter.
    app = await startTestApp({ TRUST_PROXY: '1' });
    await Promise.all([UserModel.init(), CategoryModel.init(), ProductModel.init()]); // the §3.1 unique indexes
  });

  afterAll(stopTestApp);

  beforeEach(async () => {
    await clearDatabase();
  });

  const signUp = (email: string, name = 'Ada') =>
    request(app).post('/api/user').send({ name, email, password: PASSWORD });
  const login = (email: string, password = PASSWORD) =>
    request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', `198.51.100.${(client = (client % 250) + 1)}`)
      .send({ email, password });

  describe('email (§10.3, §10.5)', () => {
    test('sign-up stores the email trimmed and lowercased', async () => {
      const res = await signUp('  Ada.Lovelace@Example.COM ');

      expectStatus(res, 201);
      expect(res.body.data.email).toBe('ada.lovelace@example.com');
      expect(await UserModel.countDocuments({ email: 'ada.lovelace@example.com' })).toBe(1);
    });

    test.each(['ADA@EXAMPLE.COM', 'Ada@Example.com', ' ada@example.com ', 'ada@EXAMPLE.com'])(
      'a case variant of a registered email (%j) is 409 "Email already registered", and no second account exists',
      async (variant) => {
        expectStatus(await signUp('ada@example.com'), 201);

        const res = await signUp(variant, 'Impostor');

        expect(res.status).toBe(409);
        expect(res.body).toEqual(EMAIL_TAKEN);
        expect(await UserModel.countDocuments()).toBe(1);
      },
    );

    test.each(['ADA@EXAMPLE.COM', 'Ada@Example.Com', '  ada@example.com  '])(
      'login with a differently cased or padded email (%j) is 200 for that account',
      async (variant) => {
        const user = await createUser({ email: 'ada@example.com', password: hashPassword(PASSWORD) });

        const res = await login(variant);

        expectStatus(res, 200);
        expect(res.body.data.user).toMatchObject({ id: user.id, email: 'ada@example.com' });
      },
    );

    test('a wrong password on a differently cased email is the generic 401, after exactly one cost-10 compare', async () => {
      await createUser({ email: 'ada@example.com', password: bcrypt.hashSync(PASSWORD, 10) });
      const compareSync = vi.spyOn(bcrypt, 'compareSync');

      const res = await login('ADA@EXAMPLE.COM', 'not-the-password');

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
      expect(compareSync).toHaveBeenCalledTimes(1);
      expect(compareSync.mock.calls[0]![1]).toMatch(COST_10_HASH); // the stored hash: select: false is lifted here
    });

    // The format check runs before the lowercasing, so a non-ASCII look-alike is refused rather than folded into
    // (or kept apart from) an ASCII address.
    test.each([
      ['the Kelvin sign (U+212A)', 'Kda@example.com'],
      ['a Cyrillic a (U+0430)', 'аda@example.com'],
      ['a fullwidth a (U+FF41)', 'ａda@example.com'],
      ['a zero-width space (U+200B)', 'ada@example.com​'],
    ])('a look-alike with %s is 422 on sign-up and on login', async (_case, lookAlike) => {
      await createUser({ email: 'ada@example.com', password: hashPassword(PASSWORD) });

      const signed = await signUp(lookAlike);
      const logged = await login(lookAlike);

      for (const res of [signed, logged]) {
        expect(res.status).toBe(422);
        expect(detailPaths(res.body)).toEqual(['email']);
      }
      expect(await UserModel.countDocuments()).toBe(1);
    });

    test('Google sign-in matches the account whatever the case of the Google address', async () => {
      const user = await createUser({ email: 'grace@example.com', google: true, password: ':D' });
      stubGoogleClient({ name: 'Grace', email: 'Grace@Example.COM', picture: 'https://example.com/g.png' });

      const res = await request(app)
        .post('/api/auth/google')
        .set('X-Forwarded-For', '198.51.100.251')
        .send({ id_token: 'google-id-token' });

      expectStatus(res, 200);
      expect(res.body.data.user).toMatchObject({ id: user.id, email: 'grace@example.com' });
      expect(await UserModel.countDocuments()).toBe(1);
    });
  });

  describe('category and product names (§10.3)', () => {
    let adminToken: string;

    beforeEach(async () => {
      adminToken = await tokenFor(await createAdmin());
    });

    const post = (path: string, body: object) =>
      request(app).post(path).set(authHeader(adminToken)).send(body);

    test('a case variant of an active category name is 409 "Category already exists"', async () => {
      expectStatus(await post('/api/category', { name: 'coffee' }), 201);

      const res = await post('/api/category', { name: '  Coffee ' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Category already exists' } });
    });

    // A row stored before M4 normalized names keeps its case until M002; the pre-check uses the index's collation,
    // so it still finds it and the specific message wins (without it, the index answers with the generic C1 409).
    test('an active category stored in another case (pre-M4 data) still gets the specific 409', async () => {
      const owner = await createUser();
      await CategoryModel.collection.insertOne({ name: 'Coffee', state: true, user: owner._id });

      const res = await post('/api/category', { name: 'COFFEE' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Category already exists' } });
    });

    test('a product name stored in another case (pre-M4 data) still gets the specific 409', async () => {
      const category = await createCategory();
      const owner = await createUser();
      await ProductModel.collection.insertOne({
        name: 'Keyboard',
        state: true,
        user: owner._id,
        category: category._id,
      });

      const res = await post('/api/product', { name: 'keyboard', category: category.id });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Product already exists' } });
    });

    test('a soft-deleted name is free again, whatever its case', async () => {
      await createCategory({ name: 'COFFEE', state: false });

      const res = await post('/api/category', { name: 'Coffee' });

      expectStatus(res, 201);
      expect(res.body.data.name).toBe('COFFEE');
    });
  });

  describe('AM-M4-5: oversize input is 422 with details, never the C1 400', () => {
    let adminToken: string;
    let categoryId: string;
    let productId: string;
    let userId: string;

    beforeEach(async () => {
      const admin = await createAdmin();
      adminToken = await tokenFor(admin);
      userId = admin.id;
      const category = await createCategory({ user: admin });
      categoryId = category.id;
      productId = (await ProductModel.create({ name: 'PRODUCT', user: admin._id, category: category._id }))
        .id;
    });

    const send = (method: 'post' | 'put', path: string, body: object) =>
      request(app)[method](path).set(authHeader(adminToken)).send(body);

    test.each<[string, () => [method: 'post' | 'put', path: string, body: object], string]>([
      [
        'a 121-character user name at sign-up',
        () => ['post', '/api/user', { name: 'n'.repeat(121), email: 'n@example.com', password: PASSWORD }],
        'name',
      ],
      [
        'a 255-character email at sign-up',
        () => [
          'post',
          '/api/user',
          { name: 'Ada', email: `${'e'.repeat(243)}@example.com`, password: PASSWORD },
        ],
        'email',
      ],
      [
        'a 121-character user name on update',
        () => ['put', `/api/user/${userId}`, { name: 'n'.repeat(121) }],
        'name',
      ],
      ['a 121-character category name', () => ['post', '/api/category', { name: 'c'.repeat(121) }], 'name'],
      [
        'a category name that grows past 120 when uppercased (61 × ß → 122 × S)',
        () => ['post', '/api/category', { name: 'ß'.repeat(61) }],
        'name',
      ],
      [
        'a 121-character category name on update',
        () => ['put', `/api/category/${categoryId}`, { name: 'c'.repeat(121) }],
        'name',
      ],
      [
        'a 121-character product name',
        () => ['post', '/api/product', { name: 'p'.repeat(121), category: categoryId }],
        'name',
      ],
      [
        'a 2001-character description',
        () => ['post', '/api/product', { name: 'LONG', category: categoryId, description: 'd'.repeat(2001) }],
        'description',
      ],
      [
        'a 2001-character description on update',
        () => ['put', `/api/product/${productId}`, { description: 'd'.repeat(2001) }],
        'description',
      ],
      [
        'a negative price',
        () => ['post', '/api/product', { name: 'CHEAP', category: categoryId, price: -1 }],
        'price',
      ],
      [
        'a 255-character email at login',
        () => ['post', '/api/auth/login', { email: `${'e'.repeat(243)}@example.com`, password: PASSWORD }],
        'email',
      ],
    ])('%s is 422 on %s', async (_case, build, path) => {
      const [method, url, body] = build();

      const res = await send(method, url, body).set('X-Forwarded-For', '198.51.100.252');

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Validation failed' });
      expect(detailPaths(res.body)).toEqual([path]);
    });

    test.each([
      [
        'a 120-character user name',
        'post',
        '/api/user',
        { name: 'n'.repeat(120), email: 'max@example.com', password: PASSWORD },
      ],
      ['a 120-character category name', 'post', '/api/category', { name: 'c'.repeat(120) }],
      [
        'a 2000-character description padded with spaces',
        'put',
        '',
        { description: ` ${'d'.repeat(2000)} ` },
      ],
    ] as const)('the cap itself is accepted: %s', async (_case, method, url, body) => {
      const res = await send(method, url || `/api/product/${productId}`, body);

      expect([200, 201]).toContain(res.status);
    });
  });
});
