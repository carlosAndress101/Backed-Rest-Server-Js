// The products contract, §6 rows #14–#18 (M3 design §5.3), over HTTP through createApp.
import type { Server } from 'node:http';

import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { ProductModel } from '../../../src/modules/products';
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

const MISSING_ID = new mongoose.Types.ObjectId().toHexString();
/** A well-formed id that need not exist: validation passes, the service decides (VAL-01). */
const ANY_CATEGORY_ID = new mongoose.Types.ObjectId().toHexString();
const BAD_ID = 'not-an-id';

/** Every product the API returns carries `id` and never `_id` or `uid` (P13). */
const expectApiShape = (product: Record<string, unknown>) => {
  expect(product).toHaveProperty('id');
  expect(product).not.toHaveProperty('_id');
  expect(product).not.toHaveProperty('uid');
};

const notFound = { error: { code: 'NOT_FOUND', message: 'Product not found' } };
const categoryNotFound = { error: { code: 'NOT_FOUND', message: 'Category not found' } };
const invalidId = {
  error: {
    code: 'VALIDATION_FAILED',
    message: 'Validation failed',
    details: [{ path: 'id', message: 'must be a Mongo id' }],
  },
};

describe('products module (§6 #14–#18)', () => {
  let app: Server;
  let admin: UserDocument;
  let adminToken: string;
  let user: UserDocument;
  let userToken: string;

  beforeAll(async () => {
    app = await startTestApp();
    await ProductModel.init(); // the unique index behind the rename conflict
  });

  afterAll(stopTestApp);

  beforeEach(async () => {
    await clearDatabase();
    admin = await createAdmin();
    adminToken = await tokenFor(admin);
    user = await createUser();
    userToken = await tokenFor(user);
  });

  describe('#14 GET /api/product (public)', () => {
    test('is 200 page(active products), with owner and category names and the default page', async () => {
      const category = await createCategory({ user: admin });
      await createProduct({ name: 'KEYBOARD', user: admin, category: category.id });
      await createProduct({ name: 'MOUSE', user: admin, category: category.id });
      await createProduct({ name: 'RETIRED', user: admin, category: category.id, state: false });

      const res = await request(app).get('/api/product');

      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ total: 2, limit: 5, offset: 0 });
      expect(res.body.data.map((product: { name: string }) => product.name).sort()).toEqual([
        'KEYBOARD',
        'MOUSE',
      ]);
      for (const product of res.body.data) {
        expectApiShape(product);
        expect(product).toMatchObject({
          state: true,
          price: 0,
          available: true,
          user: { name: 'Admin User' },
          category: { name: category.name },
        });
        expect(product.user).not.toHaveProperty('_id');
        expect(product.category).not.toHaveProperty('_id');
      }
    });

    test('honours limit and offset', async () => {
      const category = await createCategory();
      for (const name of ['A', 'B', 'C']) await createProduct({ name, category: category.id });

      const res = await request(app).get('/api/product?limit=2&offset=1');

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
      const res = await request(app).get(`/api/product?${query}`);

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: field }] });
    });
  });

  describe('#15 GET /api/product/:id (public)', () => {
    test('is 200 env(product)', async () => {
      const category = await createCategory({ user: admin, name: 'HARDWARE' });
      const product = await createProduct({ name: 'KEYBOARD', user: admin, category: category.id });

      const res = await request(app).get(`/api/product/${product.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        id: product.id,
        name: 'KEYBOARD',
        state: true,
        user: expect.anything(),
        price: 0,
        category: expect.anything(),
        available: true,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(res.body.data.user).toMatchObject({ name: 'Admin User' });
      expect(res.body.data.category).toMatchObject({ name: 'HARDWARE' });
      expectApiShape(res.body.data);
    });

    test('a product that does not exist is 404', async () => {
      const res = await request(app).get(`/api/product/${MISSING_ID}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(notFound);
    });

    test('a soft-deleted product is 404', async () => {
      const product = await createProduct({ state: false });

      const res = await request(app).get(`/api/product/${product.id}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(notFound);
    });

    test('a malformed id is 422', async () => {
      const res = await request(app).get(`/api/product/${BAD_ID}`);

      expect(res.status).toBe(422);
      expect(res.body).toEqual(invalidId);
    });
  });

  describe('#16 POST /api/product (any authenticated user)', () => {
    test('is 201 env(product): the name is trimmed and uppercased, the caller is the owner', async () => {
      const category = await createCategory();

      const res = await request(app)
        .post('/api/product')
        .set(authHeader(userToken))
        .send({ name: '  keyboard ', category: category.id });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
        id: expect.any(String),
        name: 'KEYBOARD',
        state: true,
        user: user.id,
        price: 0,
        category: category.id,
        available: true,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expectApiShape(res.body.data);
      expect(await ProductModel.findById(res.body.data.id).lean()).toMatchObject({
        name: 'KEYBOARD',
        state: true,
      });
    });

    test('ignores every field but the DTO: no _id, user, image or state from the body (VAL-02)', async () => {
      const category = await createCategory();

      const res = await request(app).post('/api/product').set(authHeader(userToken)).send({
        name: 'keyboard',
        category: category.id,
        price: 25,
        _id: MISSING_ID,
        user: admin.id,
        image: 'attacker.png',
        state: false,
      });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ name: 'KEYBOARD', state: true, user: user.id, price: 25 });
      expect(res.body.data.id).not.toBe(MISSING_ID);

      const stored = await ProductModel.findById(res.body.data.id).lean();
      expect(String(stored?.user)).toBe(user.id);
      expect(stored?.image).toBeUndefined();
      expect(stored?.state).toBe(true);
    });

    test('a missing category is 404', async () => {
      const res = await request(app)
        .post('/api/product')
        .set(authHeader(userToken))
        .send({ name: 'ORPHAN', category: MISSING_ID });

      expect(res.status).toBe(404);
      expect(res.body).toEqual(categoryNotFound);
    });

    test('a soft-deleted category is 404', async () => {
      const category = await createCategory({ state: false });

      const res = await request(app)
        .post('/api/product')
        .set(authHeader(userToken))
        .send({ name: 'ORPHAN', category: category.id });

      expect(res.status).toBe(404);
      expect(res.body).toEqual(categoryNotFound);
    });

    test.each([
      ['no token', {}, { code: 'UNAUTHORIZED', message: 'No token in the request' }],
      ['an invalid token', authHeader('not-a-jwt'), { code: 'UNAUTHORIZED', message: 'Invalid token' }],
    ])('with %s it is 401, before the body is validated', async (_case, headers, error) => {
      const res = await request(app)
        .post('/api/product')
        .set(headers)
        .send({ name: '', category: ANY_CATEGORY_ID });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error });
    });

    test.each([
      ['a missing name', {}, 'name'],
      ['a blank name', { name: '   ' }, 'name'],
      ['a non-string name (F3)', { name: 123 }, 'name'],
      ['a non-number price', { name: 'X', price: 'not-a-number' }, 'price'],
      ['a negative price', { name: 'X', price: -1 }, 'price'],
    ])('%s is 422 with a detail for %s', async (_case, extra, path) => {
      const res = await request(app)
        .post('/api/product')
        .set(authHeader(userToken))
        .send({ category: ANY_CATEGORY_ID, ...extra });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path }] });
    });

    test('a missing category is 422 with a detail for category', async () => {
      const res = await request(app).post('/api/product').set(authHeader(userToken)).send({ name: 'X' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'category' }] });
    });

    test('a name an active product already has is 409, whatever its case', async () => {
      const category = await createCategory();
      await createProduct({ name: 'KEYBOARD', category: category.id });

      const res = await request(app)
        .post('/api/product')
        .set(authHeader(userToken))
        .send({ name: 'keyboard', category: category.id });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Product already exists' } });
    });

    test('a name only a soft-deleted product has can be reused: 201 (M4 partial unique index)', async () => {
      const category = await createCategory();
      await createProduct({ name: 'RETIRED', category: category.id, state: false });

      const res = await request(app)
        .post('/api/product')
        .set(authHeader(userToken))
        .send({ name: 'retired', category: category.id });

      expect(res.status).toBe(201);
      const followUp = await request(app).get(`/api/product/${res.body.data.id}`);
      expect(followUp.status).toBe(200);
      expect(followUp.body.data).toMatchObject({ id: res.body.data.id, name: 'RETIRED', state: true });
    });
  });

  describe('#17 PUT /api/product/:id (admin, VENTAS_ROLE, or the creator)', () => {
    // ADR-041: the fix. Before M6, every editor (admin included) silently became the new owner.
    test('is 200 env(product): renamed, uppercased, and the creator is unchanged', async () => {
      const category = await createCategory();
      const product = await createProduct({ name: 'KEYBOARD', user, category: category.id });

      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(authHeader(adminToken))
        .send({ name: 'mouse', price: 10, available: false });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: product.id,
        name: 'MOUSE',
        state: true,
        price: 10,
        available: false,
        user: { name: 'Test User' },
      });
      expectApiShape(res.body.data);
      expect(String((await ProductModel.findById(product.id).lean())?.user)).toBe(user.id);
    });

    test('without a token it is 401', async () => {
      const product = await createProduct();

      const res = await request(app).put(`/api/product/${product.id}`).send({ name: 'X' });

      expect(res.status).toBe(401);
    });

    // ADR-039: ownership is now a service-level check, so a non-owner still reaches validation first
    // (authorize's deferToService lets every authenticated caller through the route).
    test('a malformed id is 422 even for a non-owner, non-privileged caller (ADR-039)', async () => {
      const res = await request(app).put(`/api/product/${BAD_ID}`).set(authHeader(userToken)).send({});

      expect(res.status).toBe(422);
      expect(res.body).toEqual(invalidId);
    });

    test('a non-owner, non-privileged caller is 403 and the product is untouched (ADR-039)', async () => {
      const category = await createCategory();
      const product = await createProduct({ name: 'KEYBOARD', category: category.id }); // owned by another user

      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(authHeader(userToken))
        .send({ name: 'mouse' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: 'Only the creator, an administrator or VENTAS_ROLE may update this product',
        },
      });
      expect(await ProductModel.findById(product.id).lean()).toMatchObject({ name: 'KEYBOARD' });
    });

    test('the creator updates their own product (ADR-041, additive)', async () => {
      const category = await createCategory();
      const product = await createProduct({ name: 'KEYBOARD', user, category: category.id });

      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(authHeader(userToken))
        .send({ name: 'mouse' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ name: 'MOUSE' });
    });

    test('a product that does not exist is 404', async () => {
      const res = await request(app)
        .put(`/api/product/${MISSING_ID}`)
        .set(authHeader(adminToken))
        .send({ name: 'X' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual(notFound);
    });

    test('a soft-deleted product is 404 and stays unchanged', async () => {
      const product = await createProduct({ name: 'RETIRED', state: false });

      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(authHeader(adminToken))
        .send({ name: 'REVIVED' });

      expect(res.status).toBe(404);
      expect(await ProductModel.findById(product.id).lean()).toMatchObject({
        name: 'RETIRED',
        state: false,
      });
    });

    test('a malformed id is 422', async () => {
      const res = await request(app)
        .put(`/api/product/${BAD_ID}`)
        .set(authHeader(adminToken))
        .send({ name: 'X' });

      expect(res.status).toBe(422);
      expect(res.body).toEqual(invalidId);
    });

    test('a blank name is 422', async () => {
      const product = await createProduct();

      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(authHeader(adminToken))
        .send({ name: '' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'name' }] });
    });

    test('moving a product to a category that is not active is 404 and nothing changes', async () => {
      const category = await createCategory();
      const product = await createProduct({ name: 'KEYBOARD', category: category.id });

      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(authHeader(adminToken))
        .send({ category: MISSING_ID });

      expect(res.status).toBe(404);
      expect(res.body).toEqual(categoryNotFound);
      expect(String((await ProductModel.findById(product.id).lean())?.category)).toBe(category.id);
    });

    test('renaming to a name another product has is 409', async () => {
      const category = await createCategory();
      await createProduct({ name: 'KEYBOARD', category: category.id });
      const mouse = await createProduct({ name: 'MOUSE', category: category.id });

      const res = await request(app)
        .put(`/api/product/${mouse.id}`)
        .set(authHeader(adminToken))
        .send({ name: 'keyboard' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'CONFLICT' });
    });
  });

  describe('#18 DELETE /api/product/:id (admin, VENTAS_ROLE, or the creator)', () => {
    test('is 204 with no body, and only soft-deletes', async () => {
      const product = await createProduct({ name: 'KEYBOARD' });

      const res = await request(app).delete(`/api/product/${product.id}`).set(authHeader(adminToken));

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(await ProductModel.findById(product.id).lean()).toMatchObject({
        name: 'KEYBOARD',
        state: false,
      });
      expect((await request(app).get(`/api/product/${product.id}`)).status).toBe(404);
      expect((await request(app).get('/api/product')).body.meta.total).toBe(0);
    });

    test('a second delete is 404', async () => {
      const product = await createProduct();
      await request(app).delete(`/api/product/${product.id}`).set(authHeader(adminToken));

      const res = await request(app).delete(`/api/product/${product.id}`).set(authHeader(adminToken));

      expect(res.status).toBe(404);
      expect(res.body).toEqual(notFound);
    });

    test('a product that does not exist is 404', async () => {
      const res = await request(app).delete(`/api/product/${MISSING_ID}`).set(authHeader(adminToken));

      expect(res.status).toBe(404);
    });

    test('without a token it is 401', async () => {
      const product = await createProduct();

      const res = await request(app).delete(`/api/product/${product.id}`);

      expect(res.status).toBe(401);
    });

    test('a non-owner, non-privileged caller is 403 and nothing is deleted (ADR-039)', async () => {
      const product = await createProduct(); // owned by a different user, not `user`

      const res = await request(app).delete(`/api/product/${product.id}`).set(authHeader(userToken));

      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only the creator, an administrator or VENTAS_ROLE may delete this product',
      });
      expect(await ProductModel.findById(product.id).lean()).toMatchObject({ state: true });
    });

    test('the creator deletes their own product (ADR-041, additive)', async () => {
      const product = await createProduct({ user });

      const res = await request(app).delete(`/api/product/${product.id}`).set(authHeader(userToken));

      expect(res.status).toBe(204);
      expect(await ProductModel.findById(product.id).lean()).toMatchObject({ state: false });
    });

    test('a malformed id is 422', async () => {
      const res = await request(app).delete(`/api/product/${BAD_ID}`).set(authHeader(adminToken));

      expect(res.status).toBe(422);
      expect(res.body).toEqual(invalidId);
    });
  });
});
