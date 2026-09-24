import type { Server } from 'node:http';

import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { expectStatus } from '../../helpers/assert';
import { authHeader, createCategory, createProduct, createUser, tokenFor } from '../../helpers/factories';

const search = (app: Server, collection: string, term: string, token?: string) => {
  const req = request(app).get(`/api/search/${collection}/${encodeURIComponent(term)}`);
  return token ? req.set(authHeader(token)) : req;
};

describe('search policy', () => {
  let app: Server;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  describe('C8 category and product are public', () => {
    test('a category can be found without a token', async () => {
      await createCategory({ name: 'LAPTOP' });

      const res = await search(app, 'category', 'LAPTOP');

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    test('a product can be found without a token', async () => {
      await createProduct({ name: 'KEYBOARD' });

      const res = await search(app, 'product', 'KEYBOARD');

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('C8 / SEC-05 the user collection requires a token and admin', () => {
    test('without a token it is 401', async () => {
      await createUser({ name: 'Searchable', email: 'searchable@example.com' });

      const res = await search(app, 'user', 'Searchable');

      expect(res.statusCode).toBe(401);
    });

    test('with a non-admin token it is 403', async () => {
      const user = await createUser({ email: 'searcher@example.com' });
      const token = await tokenFor(user);

      const res = await search(app, 'user', 'searcher@example.com', token);

      expect(res.statusCode).toBe(403);
    });

    test('with an admin token it is 200', async () => {
      const admin = await createUser({ role: 'ADMIN_ROLE', email: 'admin-search@example.com' });
      await createUser({ name: 'Findme', email: 'findme@example.com' });
      const token = await tokenFor(admin);

      const res = await search(app, 'user', 'Findme', token);

      expectStatus(res, 200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('C8 role is not an allowed collection', () => {
    test('searching role is 400', async () => {
      const res = await search(app, 'role', 'ADMIN_ROLE');

      expect(res.statusCode).toBe(400);
    });
  });

  describe('C8 terms match literally (regex metacharacters are escaped)', () => {
    test('a wildcard-like term does not match everything', async () => {
      await createCategory({ name: 'LAPTOP' });

      const res = await search(app, 'category', '.*');

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    test('a grouping-like term does not match everything', async () => {
      await createCategory({ name: 'LAPTOP' });

      const res = await search(app, 'category', '(LAPTOP)');

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('C8 at most 20 results are returned', () => {
    test('25 matching categories return at most 20', async () => {
      for (let i = 0; i < 25; i++) {
        await createCategory({ name: `BULK ${String(i).padStart(2, '0')}` });
      }

      const res = await search(app, 'category', 'BULK');

      expect(res.statusCode).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data.length).toBeLessThanOrEqual(20);
    });
  });

  describe('C8 a non-existent id returns 200 with an empty result set', () => {
    test('category', async () => {
      const missing = new mongoose.Types.ObjectId();

      const res = await search(app, 'category', missing.toHexString());

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    test('user (with an admin token)', async () => {
      const admin = await createUser({ role: 'ADMIN_ROLE', email: 'admin-missing@example.com' });
      const token = await tokenFor(admin);
      const missing = new mongoose.Types.ObjectId();

      const res = await search(app, 'user', missing.toHexString(), token);

      expectStatus(res, 200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('C8 an existing id still returns the document', () => {
    test('category by id', async () => {
      const category = await createCategory({ name: 'BY-ID' });

      const res = await search(app, 'category', category.id);

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(category.id);
    });
  });
});
