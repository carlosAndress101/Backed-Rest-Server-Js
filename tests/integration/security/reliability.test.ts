import type { Server } from 'node:http';

import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { CategoryModel as Category } from '../../../src/modules/categories';
import { ProductModel as Product } from '../../../src/modules/products';
import type { UserDocument } from '../../../src/modules/users';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { authHeader, createCategory, createUser, tokenFor } from '../../helpers/factories';

describe('crash safety and HTTP error handling', () => {
  let app: Server;
  let admin: UserDocument;
  let adminToken: string;

  beforeAll(async () => {
    app = await startTestApp();
    // Make sure the unique indexes the duplicate-key path relies on exist.
    await Category.init();
    await Product.init();
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await clearDatabase();
    admin = await createUser({ role: 'ADMIN_ROLE', email: 'admin-reliability@example.com' });
    adminToken = await tokenFor(admin);
  });

  describe('C2 unknown routes return a JSON 404', () => {
    test('an unknown path is 404 NOT_FOUND "Route not found"', async () => {
      const res = await request(app).get('/api/definitely-not-a-route');

      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    });

    test('an unknown non-api path is also a JSON 404', async () => {
      const res = await request(app).get('/nope/nope');

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    });
  });

  describe('C1 the error middleware maps Mongoose errors', () => {
    test('a duplicate key error is 409 CONFLICT', async () => {
      await createCategory({ name: 'DUP ONE' });
      const second = await createCategory({ name: 'DUP TWO' });

      const res = await request(app)
        .put(`/api/category/${second.id}`)
        .set(authHeader(adminToken))
        .send({ name: 'DUP ONE' });

      expect(res.statusCode).toBe(409);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
    });

    test('an invalid product price is rejected by the DTO: 422 VALIDATION_FAILED (AM-M3-5)', async () => {
      const category = await createCategory();

      const res = await request(app)
        .post('/api/product')
        .set(authHeader(adminToken))
        .send({ name: 'CAST-ERROR', price: 'not-a-number', category: category.id });

      expect(res.statusCode).toBe(422);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'price' })]),
      );
    });

    test('a product without a category is rejected by the DTO: 422 VALIDATION_FAILED (AM-M3-5)', async () => {
      const res = await request(app)
        .post('/api/product')
        .set(authHeader(adminToken))
        .send({ name: 'MISSING-CATEGORY' });

      expect(res.statusCode).toBe(422);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'category' })]),
      );
    });

    test('an unexpected error is 500 INTERNAL without a stack', async () => {
      const spy = vi.spyOn(Category, 'find').mockImplementationOnce(() => {
        throw new Error('simulated database outage');
      });

      const res = await request(app).get('/api/search/category/anything');

      spy.mockRestore();

      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    });
  });

  describe('C1 errors never leak a stack trace or a raw Mongoose object', () => {
    test('the 404 body has only an error key', async () => {
      const res = await request(app).get('/api/unknown');

      expect(Object.keys(res.body)).toEqual(['error']);
      expect(typeof res.body.error.message).toBe('string');
    });

    test('a ValidationError response has only an error key', async () => {
      const res = await request(app)
        .post('/api/product')
        .set(authHeader(adminToken))
        .send({ name: 'NO-CATEGORY-LEAK' });

      expect(Object.keys(res.body)).toEqual(['error']);
      expect(JSON.stringify(res.body)).not.toMatch(/ValidationError|CastError|\bat \b/);
    });
  });

  describe('REL-01 no request can terminate the process', () => {
    test('an invalid regular expression term returns a response and the next request works', async () => {
      await createCategory({ name: 'LAPTOP' });

      const res = await request(app).get('/api/search/category/%28');

      expect(typeof res.statusCode).toBe('number');
      expect(res.headers['content-type']).toMatch(/json/);

      const followUp = await request(app).get('/api/search/category/LAPTOP');
      expect(followUp.statusCode).toBe(200);
      expect(followUp.body.data).toHaveLength(1);
    });

    test('a well-formed id that does not exist returns a response and the next request works', async () => {
      await createCategory({ name: 'LAPTOP' });
      const missing = new mongoose.Types.ObjectId().toHexString();

      const res = await request(app).get(`/api/search/category/${missing}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual([]);

      const followUp = await request(app).get('/api/search/category/LAPTOP');
      expect(followUp.statusCode).toBe(200);
    });

    test('a case-variant duplicate product returns a response and the next creation works', async () => {
      const category = await createCategory({ user: admin });
      await Product.create({ name: 'PHONE', user: admin._id, category: category._id });

      const duplicate = await request(app)
        .post('/api/product')
        .set(authHeader(adminToken))
        .send({ name: 'phone', category: category.id });

      expect(typeof duplicate.statusCode).toBe('number');
      expect(duplicate.headers['content-type']).toMatch(/json/);

      const followUp = await request(app)
        .post('/api/product')
        .set(authHeader(adminToken))
        .send({ name: 'TABLET', category: category.id });

      expect(followUp.statusCode).toBe(201);
    });

    test('a product without a category returns a response and the next request works', async () => {
      const res = await request(app)
        .post('/api/product')
        .set(authHeader(adminToken))
        .send({ name: 'PRODUCT-WITHOUT-CATEGORY' });

      expect(typeof res.statusCode).toBe('number');
      expect(res.headers['content-type']).toMatch(/json/);

      const followUp = await request(app).get('/');
      expect(followUp.statusCode).toBe(200);
    });

    test('a forced database error in a list handler returns a response and the next request works', async () => {
      await createCategory({ name: 'LAPTOP' });
      const spy = vi.spyOn(Category, 'find').mockImplementationOnce(() => {
        throw new Error('simulated database outage');
      });

      const res = await request(app).get('/api/search/category/LAPTOP');

      spy.mockRestore();

      expect(typeof res.statusCode).toBe('number');
      expect(res.headers['content-type']).toMatch(/json/);

      const followUp = await request(app).get('/api/search/category/LAPTOP');
      expect(followUp.statusCode).toBe(200);
      expect(followUp.body.data).toHaveLength(1);
    });
  });
});
