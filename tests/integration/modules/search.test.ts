// The search contract, §6 row #19 (M3 design §5.4), over HTTP through createApp.
import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { UserDocument } from '../../../src/modules/users';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import {
  authHeader,
  createAdmin,
  createCategory,
  createProduct,
  createUser,
  tokenFor,
} from '../../helpers/factories';

const PERMITTED = 'user,category,product';

const get = (app: Server, path: string, token?: string) => {
  const req = request(app).get(path);
  return token ? req.set(authHeader(token)) : req;
};

describe('search module (§6 #19)', () => {
  let app: Server;
  let admin: UserDocument;
  let adminToken: string;
  let user: UserDocument;
  let userToken: string;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(stopTestApp);

  beforeEach(async () => {
    await clearDatabase();
    admin = await createAdmin();
    adminToken = await tokenFor(admin);
    user = await createUser();
    userToken = await tokenFor(user);
  });

  describe('C8 category and product are public', () => {
    test('a category is found by name: 200 env(items) with id and no _id or uid', async () => {
      await createCategory({ name: 'LAPTOP' });

      const res = await get(app, '/api/search/category/LAPTOP');

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ name: 'LAPTOP', state: true });
      expect(res.body.data[0]).toHaveProperty('id');
      expect(res.body.data[0]).not.toHaveProperty('_id');
      expect(res.body.data[0]).not.toHaveProperty('uid');
    });

    test('a product is found by name and by description', async () => {
      await createProduct({ name: 'KEYBOARD', user: admin });
      await createProduct({ name: 'MOUSE', description: 'wireless pointer', user: admin });

      const byName = await get(app, '/api/search/product/KEYBOARD');
      const byDescription = await get(app, '/api/search/product/wireless');

      expect(byName.statusCode).toBe(200);
      expect(byName.body.data.map((item: { name: string }) => item.name)).toEqual(['KEYBOARD']);
      expect(byDescription.statusCode).toBe(200);
      expect(byDescription.body.data.map((item: { name: string }) => item.name)).toEqual(['MOUSE']);
    });
  });

  describe('C8 / SEC-05 the user collection requires a token and admin', () => {
    test('with an admin token: 200 env(items) with id + uid and never a password', async () => {
      await createUser({ name: 'Findme', email: 'findme@example.com' });

      const res = await get(app, '/api/search/user/Findme', adminToken);

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ name: 'Findme', email: 'findme@example.com' });
      expect(res.body.data[0]).toHaveProperty('id');
      expect(res.body.data[0]).toHaveProperty('uid');
      expect(res.body.data[0]).not.toHaveProperty('_id');
      expect(res.body.data[0]).not.toHaveProperty('password');
    });

    // The param is percent-decoded before the guard decides, so an encoded 'user' cannot skip it (SEC-05).
    test('an encoded collection (us%65r) is still 401 without a token, 403 for a non-admin and 200 for an admin', async () => {
      await createUser({ name: 'Findme', email: 'findme2@example.com' });

      const anonymous = await get(app, '/api/search/us%65r/Findme');
      const nonAdmin = await get(app, '/api/search/us%65r/Findme', userToken);
      const asAdmin = await get(app, '/api/search/us%65r/Findme', adminToken);

      expect(anonymous.statusCode).toBe(401);
      expect(nonAdmin.statusCode).toBe(403);
      expect(asAdmin.statusCode).toBe(200);
      expect(asAdmin.body.data).toHaveLength(1);
    });
  });

  describe('C8 a soft-deleted document is missing', () => {
    test('it is excluded from the text search and from the id lookup', async () => {
      const category = await createCategory({ name: 'RETIRED', state: false, user: admin });

      const byText = await get(app, '/api/search/category/RETIRED');
      const byId = await get(app, `/api/search/category/${category.id}`);

      expect(byText.statusCode).toBe(200);
      expect(byText.body.data).toEqual([]);
      expect(byId.statusCode).toBe(200);
      expect(byId.body.data).toEqual([]);
    });
  });

  describe('C8 an id term returns the document', () => {
    test('a product by id has its category populated', async () => {
      const category = await createCategory({ name: 'HARDWARE', user: admin });
      const product = await createProduct({ name: 'KEYBOARD', category: category.id, user: admin });

      const res = await get(app, `/api/search/product/${product.id}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ name: 'KEYBOARD' });
      expect(res.body.data[0].category).toMatchObject({ name: 'HARDWARE' });
      expect(res.body.data[0].category).not.toHaveProperty('_id');
    });
  });

  describe('C8 the collection allowlist', () => {
    test('role is 400 BAD_REQUEST with the legacy message, with or without a token', async () => {
      const withoutToken = await get(app, '/api/search/role/ADMIN_ROLE');
      const withToken = await get(app, '/api/search/role/ADMIN_ROLE', adminToken);

      expect(withoutToken.statusCode).toBe(400);
      expect(withoutToken.body).toEqual({
        error: { code: 'BAD_REQUEST', message: `The permitted collections are: ${PERMITTED}` },
      });
      expect(withToken.statusCode).toBe(400);
    });

    // F1 (T3.6R): a collection named like an Object.prototype key must be the legacy 400, never a 500.
    test.each(['constructor', '__proto__'])('%s is 400, not a 500', async (collection) => {
      const res = await get(app, `/api/search/${collection}/x`);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: { code: 'BAD_REQUEST', message: `The permitted collections are: ${PERMITTED}` },
      });
    });
  });

  describe('C8 at most 20 results are returned', () => {
    test('25 matching categories return 20', async () => {
      for (let i = 0; i < 25; i++) {
        await createCategory({ name: `BULK ${String(i).padStart(2, '0')}`, user: admin });
      }

      const res = await get(app, '/api/search/category/BULK');

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toHaveLength(20);
    });
  });
});
