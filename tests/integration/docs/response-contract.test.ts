// The response components are executable (Decision 5): sampled real responses parse with them.
import type { Server } from 'node:http';

import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  Category,
  ErrorEnvelope,
  PageMeta,
  Product,
  Session,
  TokenGrant,
  User,
} from '../../../src/docs/components';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { changePassword } from '../../helpers/auth';
import { authHeader } from '../../helpers/factories';

const PASSWORD = 'contract-password-1';
const NEW_PASSWORD = 'contract-password-2';

describe('response components parse real API responses', () => {
  let app: Server;

  beforeAll(async () => {
    app = await startTestApp();
    await clearDatabase();
  });

  afterAll(stopTestApp);

  test('sign-up, log-in, categories, products and the password change', async () => {
    const signUp = await request(app)
      .post('/api/user')
      .send({ name: 'Contract User', email: 'contract@example.com', password: PASSWORD });
    expect(signUp.status).toBe(201);
    User.parse(signUp.body.data);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'contract@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
    const { token } = Session.parse(login.body.data);
    const auth = authHeader(token);

    const createdCategory = await request(app).post('/api/category').set(auth).send({ name: 'Keyboards' });
    expect(createdCategory.status).toBe(201);
    const category = Category.parse(createdCategory.body.data);

    const gotCategory = await request(app).get(`/api/category/${category.id}`);
    expect(gotCategory.status).toBe(200);
    Category.parse(gotCategory.body.data);

    const categories = await request(app).get('/api/category');
    expect(categories.status).toBe(200);
    expect(categories.body.data).toHaveLength(1);
    for (const item of categories.body.data) Category.parse(item);
    PageMeta.parse(categories.body.meta);

    const createdProduct = await request(app)
      .post('/api/product')
      .set(auth)
      .send({ name: 'Mechanical', category: category.id, price: 99 });
    expect(createdProduct.status).toBe(201);
    const product = Product.parse(createdProduct.body.data);

    const gotProduct = await request(app).get(`/api/product/${product.id}`);
    expect(gotProduct.status).toBe(200);
    // A get populates the creator and the category as `{ id, name }`.
    expect(Product.parse(gotProduct.body.data).category).toMatchObject({ id: category.id });

    const products = await request(app).get('/api/product');
    expect(products.status).toBe(200);
    expect(products.body.data).toHaveLength(1);
    for (const item of products.body.data) Product.parse(item);
    PageMeta.parse(products.body.meta);

    const changed = await changePassword(app, auth, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(200);
    TokenGrant.parse(changed.body.data);
  });

  test('a 404 and a 422 parse as the error envelope', async () => {
    const notFound = await request(app).get(`/api/product/${new mongoose.Types.ObjectId().toHexString()}`);
    expect(notFound.status).toBe(404);
    expect(ErrorEnvelope.parse(notFound.body).error.code).toBe('NOT_FOUND');

    const invalid = await request(app).get('/api/product/not-an-id');
    expect(invalid.status).toBe(422);
    const { error } = ErrorEnvelope.parse(invalid.body);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).not.toHaveLength(0);
  });
});
