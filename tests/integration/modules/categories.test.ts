// The categories contract, §6 rows #9–#13 (M3 design §4.7), over HTTP through createApp.
import type { Server } from 'node:http';

import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { CategoryModel } from '../../../src/modules/categories';
import type { UserDocument } from '../../../src/modules/users';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { authHeader, createAdmin, createCategory, createUser, tokenFor } from '../../helpers/factories';

const MISSING_ID = new mongoose.Types.ObjectId().toHexString();
const BAD_ID = 'not-an-id';

/** Every category the API returns carries `id` and never `_id` or `uid` (P13). */
const expectApiShape = (category: Record<string, unknown>) => {
  expect(category).toHaveProperty('id');
  expect(category).not.toHaveProperty('_id');
  expect(category).not.toHaveProperty('uid');
};

const notFound = { error: { code: 'NOT_FOUND', message: 'Category not found' } };
const invalidId = {
  error: {
    code: 'VALIDATION_FAILED',
    message: 'Validation failed',
    details: [{ path: 'id', message: 'must be a Mongo id' }],
  },
};

describe('categories module (§6 #9–#13)', () => {
  let app: Server;
  let admin: UserDocument;
  let adminToken: string;
  let user: UserDocument;
  let userToken: string;

  beforeAll(async () => {
    app = await startTestApp();
    await CategoryModel.init(); // the unique index behind the rename conflict
  });

  afterAll(stopTestApp);

  beforeEach(async () => {
    await clearDatabase();
    admin = await createAdmin();
    adminToken = await tokenFor(admin);
    user = await createUser();
    userToken = await tokenFor(user);
  });

  describe('#9 GET /api/category (public)', () => {
    test('is 200 page(active categories), with the owner name and the default page', async () => {
      await createCategory({ name: 'COFFEE', user: admin });
      await createCategory({ name: 'TEA', user: admin });
      await createCategory({ name: 'RETIRED', state: false });

      const res = await request(app).get('/api/category');

      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ total: 2, limit: 5, offset: 0 });
      expect(res.body.data.map((category: { name: string }) => category.name).sort()).toEqual([
        'COFFEE',
        'TEA',
      ]);
      for (const category of res.body.data) {
        expectApiShape(category);
        expect(category).toMatchObject({ state: true, user: { name: 'Admin User' } });
        expect(category.user).not.toHaveProperty('_id');
      }
    });

    test('honours limit and offset', async () => {
      for (const name of ['A', 'B', 'C']) await createCategory({ name });

      const res = await request(app).get('/api/category?limit=2&offset=1');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toEqual({ total: 3, limit: 2, offset: 1 });
    });

    test.each([
      ['limit', 'limit=0'],
      ['limit', 'limit=51'],
      ['limit', 'limit=ten'],
      ['offset', 'offset=-1'],
    ])('a bad %s (%s) is 422 VALIDATION_FAILED', async (field, query) => {
      const res = await request(app).get(`/api/category?${query}`);

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: field }] });
    });
  });

  describe('#10 GET /api/category/:id (public)', () => {
    test('is 200 env(category)', async () => {
      const category = await createCategory({ name: 'COFFEE', user: admin });

      const res = await request(app).get(`/api/category/${category.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        id: category.id,
        name: 'COFFEE',
        state: true,
        user: expect.anything(),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(res.body.data.user).toMatchObject({ name: 'Admin User' });
      expectApiShape(res.body.data);
    });

    test('a category that does not exist is 404', async () => {
      const res = await request(app).get(`/api/category/${MISSING_ID}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(notFound);
    });

    test('a soft-deleted category is 404', async () => {
      const category = await createCategory({ state: false });

      const res = await request(app).get(`/api/category/${category.id}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(notFound);
    });

    test('a malformed id is 422', async () => {
      const res = await request(app).get(`/api/category/${BAD_ID}`);

      expect(res.status).toBe(422);
      expect(res.body).toEqual(invalidId);
    });
  });

  describe('#11 POST /api/category (any authenticated user)', () => {
    test('is 201 env(category): the name is trimmed and uppercased, the caller is the owner', async () => {
      const res = await request(app)
        .post('/api/category')
        .set(authHeader(userToken))
        .send({ name: '  coffee ' });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
        id: expect.any(String),
        name: 'COFFEE',
        state: true,
        user: user.id,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expectApiShape(res.body.data);
      expect(await CategoryModel.findById(res.body.data.id).lean()).toMatchObject({
        name: 'COFFEE',
        state: true,
      });
    });

    test('ignores every field but name: no state, owner or id from the body (VAL-02)', async () => {
      const res = await request(app)
        .post('/api/category')
        .set(authHeader(userToken))
        .send({ name: 'tea', state: false, user: admin.id, _id: MISSING_ID });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ name: 'TEA', state: true, user: user.id });
      expect(res.body.data.id).not.toBe(MISSING_ID);
    });

    test.each([
      ['no token', {}, { code: 'UNAUTHORIZED', message: 'No token in the request' }],
      ['an invalid token', authHeader('not-a-jwt'), { code: 'UNAUTHORIZED', message: 'Invalid token' }],
    ])('with %s it is 401, before the body is validated', async (_case, headers, error) => {
      const res = await request(app).post('/api/category').set(headers).send({ name: '' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error });
    });

    test.each([
      ['a missing name', {}],
      ['a blank name', { name: '   ' }],
      ['a non-string name (F3)', { name: 123 }],
    ])('%s is 422 with a detail for name', async (_case, body) => {
      const res = await request(app).post('/api/category').set(authHeader(userToken)).send(body);

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'name' }] });
    });

    test('a name an active category already has is 409, whatever its case', async () => {
      await createCategory({ name: 'COFFEE' });

      const res = await request(app)
        .post('/api/category')
        .set(authHeader(userToken))
        .send({ name: 'coffee' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Category already exists' } });
    });
    test('a name only a soft-deleted category has can be reused: 201 (M4 partial unique index)', async () => {
      await createCategory({ name: 'RETIRED', state: false });

      const res = await request(app)
        .post('/api/category')
        .set(authHeader(userToken))
        .send({ name: 'retired' });

      expect(res.status).toBe(201);
      const followUp = await request(app).get(`/api/category/${res.body.data.id}`);
      expect(followUp.status).toBe(200);
      expect(followUp.body.data).toMatchObject({ id: res.body.data.id, name: 'RETIRED', state: true });
    });
  });

  describe('#12 PUT /api/category/:id (admin)', () => {
    test('is 200 env(category): renamed, uppercased, and owned by the editor', async () => {
      const category = await createCategory({ name: 'COFFEE', user });

      const res = await request(app)
        .put(`/api/category/${category.id}`)
        .set(authHeader(adminToken))
        .send({ name: 'espresso' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: category.id,
        name: 'ESPRESSO',
        state: true,
        user: { name: 'Admin User' },
      });
      expectApiShape(res.body.data);
      expect(String((await CategoryModel.findById(category.id).lean())?.user)).toBe(admin.id);
    });

    test('without a token it is 401', async () => {
      const category = await createCategory();

      const res = await request(app).put(`/api/category/${category.id}`).send({ name: 'X' });

      expect(res.status).toBe(401);
    });

    test('a non-admin is 403, before the id and body are validated', async () => {
      const res = await request(app).put(`/api/category/${BAD_ID}`).set(authHeader(userToken)).send({});

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: 'Not allowed' } });
    });

    test('a category that does not exist is 404', async () => {
      const res = await request(app)
        .put(`/api/category/${MISSING_ID}`)
        .set(authHeader(adminToken))
        .send({ name: 'X' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual(notFound);
    });

    test('a soft-deleted category is 404 and stays unchanged', async () => {
      const category = await createCategory({ name: 'RETIRED', state: false });

      const res = await request(app)
        .put(`/api/category/${category.id}`)
        .set(authHeader(adminToken))
        .send({ name: 'REVIVED' });

      expect(res.status).toBe(404);
      expect(await CategoryModel.findById(category.id).lean()).toMatchObject({
        name: 'RETIRED',
        state: false,
      });
    });

    test('a malformed id is 422', async () => {
      const res = await request(app)
        .put(`/api/category/${BAD_ID}`)
        .set(authHeader(adminToken))
        .send({ name: 'X' });

      expect(res.status).toBe(422);
      expect(res.body).toEqual(invalidId);
    });

    test('a blank name is 422', async () => {
      const category = await createCategory();

      const res = await request(app)
        .put(`/api/category/${category.id}`)
        .set(authHeader(adminToken))
        .send({ name: '' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'name' }] });
    });

    test('renaming to a name another category has is 409', async () => {
      await createCategory({ name: 'COFFEE' });
      const tea = await createCategory({ name: 'TEA' });

      const res = await request(app)
        .put(`/api/category/${tea.id}`)
        .set(authHeader(adminToken))
        .send({ name: 'coffee' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'CONFLICT' });
    });
  });

  describe('#13 DELETE /api/category/:id (admin)', () => {
    test('is 204 with no body, and only soft-deletes', async () => {
      const category = await createCategory({ name: 'COFFEE' });

      const res = await request(app).delete(`/api/category/${category.id}`).set(authHeader(adminToken));

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(await CategoryModel.findById(category.id).lean()).toMatchObject({
        name: 'COFFEE',
        state: false,
      });
      expect((await request(app).get(`/api/category/${category.id}`)).status).toBe(404);
      expect((await request(app).get('/api/category')).body.meta.total).toBe(0);
    });

    test('a second delete is 404', async () => {
      const category = await createCategory();
      await request(app).delete(`/api/category/${category.id}`).set(authHeader(adminToken));

      const res = await request(app).delete(`/api/category/${category.id}`).set(authHeader(adminToken));

      expect(res.status).toBe(404);
      expect(res.body).toEqual(notFound);
    });

    test('a category that does not exist is 404', async () => {
      const res = await request(app).delete(`/api/category/${MISSING_ID}`).set(authHeader(adminToken));

      expect(res.status).toBe(404);
    });

    test('without a token it is 401', async () => {
      const category = await createCategory();

      const res = await request(app).delete(`/api/category/${category.id}`);

      expect(res.status).toBe(401);
    });

    test('a non-admin is 403 and nothing is deleted', async () => {
      const category = await createCategory();

      const res = await request(app).delete(`/api/category/${category.id}`).set(authHeader(userToken));

      expect(res.status).toBe(403);
      expect(await CategoryModel.findById(category.id).lean()).toMatchObject({ state: true });
    });

    test('a malformed id is 422', async () => {
      const res = await request(app).delete(`/api/category/${BAD_ID}`).set(authHeader(adminToken));

      expect(res.status).toBe(422);
      expect(res.body).toEqual(invalidId);
    });
  });
});
