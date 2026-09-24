// The users contract, §6 rows #4–#7 (M3 design §5.1), over HTTP through createApp.
import type { Server } from 'node:http';

import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { UserModel } from '../../../src/modules/users';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { authHeader, createAdmin, createUser, tokenFor } from '../../helpers/factories';
import { generarJWT, type LegacyDoc } from '../../helpers/legacy';

const MISSING_ID = new mongoose.Types.ObjectId().toHexString();
const BAD_ID = 'not-an-id';
const PASSWORD = 'correct-horse-battery';

/** Every user the API returns carries `id` and the deprecated `uid` alias, and never `_id`, `__v` or the password. */
const expectApiShape = (user: Record<string, unknown>) => {
  expect(user).toHaveProperty('id');
  expect(user.uid).toBe(user.id);
  expect(user).not.toHaveProperty('_id');
  expect(user).not.toHaveProperty('__v');
  expect(user).not.toHaveProperty('password');
};

const notFound = { error: { code: 'NOT_FOUND', message: 'User not found' } };
const invalidId = {
  error: {
    code: 'VALIDATION_FAILED',
    message: 'Validation failed',
    details: [{ path: 'id', message: 'must be a Mongo id' }],
  },
};

describe('users module (§6 #4–#7)', () => {
  let app: Server;
  let admin: LegacyDoc;
  let adminToken: string;
  let user: LegacyDoc;
  let userToken: string;

  beforeAll(async () => {
    app = await startTestApp();
    await UserModel.init(); // the unique email index behind the sign-up race backstop
  });

  afterAll(stopTestApp);

  beforeEach(async () => {
    await clearDatabase();
    admin = await createAdmin();
    adminToken = await tokenFor(admin);
    user = await createUser({ name: 'Ada' });
    userToken = await tokenFor(user);
  });

  describe('#4 GET /api/user (admin)', () => {
    test('is 200 page(active users), never with a password', async () => {
      await createUser({ state: false });

      const res = await request(app).get('/api/user').set(authHeader(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ total: 2, limit: 5, offset: 0 });
      expect(res.body.data.map((item: { id: string }) => item.id).sort()).toEqual([admin.id, user.id].sort());
      for (const item of res.body.data) expectApiShape(item);
    });

    test('honours limit and offset', async () => {
      for (let i = 0; i < 3; i++) await createUser();

      const res = await request(app).get('/api/user?limit=2&offset=1').set(authHeader(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toEqual({ total: 5, limit: 2, offset: 1 });
    });

    test('without a token it is 401', async () => {
      const res = await request(app).get('/api/user');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'No token in the request' } });
    });

    test.each(['USER_ROLE', 'VENTAS_ROLE'])('a %s token is 403 (SEC-05)', async (role) => {
      const caller = await createUser({ role });

      const res = await request(app)
        .get('/api/user')
        .set(authHeader(await tokenFor(caller)));

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: 'Administrator role required' } });
    });

    test('a bad page is 422', async () => {
      const res = await request(app).get('/api/user?limit=0').set(authHeader(adminToken));

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'limit' }] });
    });
  });

  describe('#5 POST /api/user (public sign-up)', () => {
    test('is 201 env(user): USER_ROLE, active, and the password stored only as a bcrypt hash', async () => {
      const res = await request(app)
        .post('/api/user')
        .send({ name: '  Grace ', email: 'grace@example.com', password: PASSWORD });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
        id: expect.any(String),
        uid: res.body.data.id,
        name: 'Grace',
        email: 'grace@example.com',
        role: 'USER_ROLE',
        state: true,
        google: false,
      });
      expectApiShape(res.body.data);
      const stored = await UserModel.findById(res.body.data.id).lean();
      expect(stored?.password).not.toBe(PASSWORD);
      expect(bcrypt.compareSync(PASSWORD, stored!.password)).toBe(true);
    });

    test('takes only name, email and password: no role, state, google, image or id from the body (SEC-02)', async () => {
      const res = await request(app).post('/api/user').send({
        name: 'Mallory',
        email: 'mallory@example.com',
        password: PASSWORD,
        role: 'ADMIN_ROLE',
        state: false,
        google: true,
        image: 'https://evil.example/x.png',
        _id: MISSING_ID,
      });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ role: 'USER_ROLE', state: true, google: false });
      expect(res.body.data).not.toHaveProperty('image');
      expect(res.body.data.id).not.toBe(MISSING_ID);
    });

    test.each([
      ['an active account', true],
      ['a soft-deleted account', false],
    ])('an email %s already has is 409', async (_case, state) => {
      await createUser({ email: 'taken@example.com', state });

      const res = await request(app)
        .post('/api/user')
        .send({ name: 'Copycat', email: 'taken@example.com', password: PASSWORD });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Email already registered' } });
    });

    test.each([
      ['a missing name', { email: 'a@example.com', password: PASSWORD }, 'name'],
      ['a blank name', { name: '  ', email: 'a@example.com', password: PASSWORD }, 'name'],
      ['a non-string name (F3)', { name: 42, email: 'a@example.com', password: PASSWORD }, 'name'],
      ['an invalid email', { name: 'A', email: 'not-an-email', password: PASSWORD }, 'email'],
      [
        'a password under 8 characters',
        { name: 'A', email: 'a@example.com', password: 'short77' },
        'password',
      ],
      ['a non-string password', { name: 'A', email: 'a@example.com', password: [PASSWORD] }, 'password'],
    ])('%s is 422 with a detail for it', async (_case, body, path) => {
      const res = await request(app).post('/api/user').send(body);

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toContain(path);
    });

    test('a rejected password never comes back in the response (LOG-02)', async () => {
      const res = await request(app)
        .post('/api/user')
        .send({ name: 'A', email: 'a@example.com', password: 'secret7' });

      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).not.toContain('secret7');
    });
  });

  describe('#6 PUT /api/user/:id (self or admin)', () => {
    test('a user renames themself and changes their password: 200 env(user)', async () => {
      const res = await request(app)
        .put(`/api/user/${user.id}`)
        .set(authHeader(userToken))
        .send({ name: ' Ada Lovelace ', password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: user.id, name: 'Ada Lovelace', role: 'USER_ROLE' });
      expectApiShape(res.body.data);
      expect(bcrypt.compareSync(PASSWORD, (await UserModel.findById(user.id).lean())!.password)).toBe(true);
    });

    test('role and state from a non-admin are dropped, even an unknown role (C6)', async () => {
      const res = await request(app)
        .put(`/api/user/${user.id}`)
        .set(authHeader(userToken))
        .send({ role: 'NOT_A_ROLE', state: false });

      expect(res.status).toBe(200);
      expect(await UserModel.findById(user.id).lean()).toMatchObject({ role: 'USER_ROLE', state: true });
    });

    test('an administrator sets role and state (C6)', async () => {
      const res = await request(app)
        .put(`/api/user/${user.id}`)
        .set(authHeader(adminToken))
        .send({ role: 'VENTAS_ROLE', state: false });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ role: 'VENTAS_ROLE', state: false });
    });

    test('an administrator reactivates a soft-deleted user', async () => {
      const retired = await createUser({ state: false });

      const res = await request(app)
        .put(`/api/user/${retired.id}`)
        .set(authHeader(adminToken))
        .send({ state: true });

      expect(res.status).toBe(200);
      expect(await UserModel.findById(retired.id).lean()).toMatchObject({ state: true });
    });

    test('an administrator setting a role outside ROLES is 422 and changes nothing (ADR-007)', async () => {
      const res = await request(app)
        .put(`/api/user/${user.id}`)
        .set(authHeader(adminToken))
        .send({ role: 'SUPER_ROLE', name: 'Changed' });

      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Validation failed',
          details: [{ path: 'role', message: 'must be one of ADMIN_ROLE, USER_ROLE, VENTAS_ROLE' }],
        },
      });
      expect(await UserModel.findById(user.id).lean()).toMatchObject({ name: 'Ada', role: 'USER_ROLE' });
    });

    test('a bodiless PUT is the empty update: 200 and nothing changes', async () => {
      const res = await request(app).put(`/api/user/${user.id}`).set(authHeader(userToken));

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: user.id, name: 'Ada' });
    });

    test('without a token it is 401', async () => {
      const res = await request(app).put(`/api/user/${user.id}`).send({ name: 'X' });

      expect(res.status).toBe(401);
    });

    test('a non-admin on another user is 403, before the id and body are validated (SEC-01)', async () => {
      const res = await request(app).put(`/api/user/${BAD_ID}`).set(authHeader(userToken)).send({ name: 7 });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: 'Owner or administrator required' } });
    });

    test('a user that does not exist is 404', async () => {
      const res = await request(app)
        .put(`/api/user/${MISSING_ID}`)
        .set(authHeader(adminToken))
        .send({ name: 'X' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual(notFound);
    });

    test('a malformed id is 422', async () => {
      const res = await request(app)
        .put(`/api/user/${BAD_ID}`)
        .set(authHeader(adminToken))
        .send({ name: 'X' });

      expect(res.status).toBe(422);
      expect(res.body).toEqual(invalidId);
    });

    test('a password under 8 characters is 422', async () => {
      const res = await request(app)
        .put(`/api/user/${user.id}`)
        .set(authHeader(userToken))
        .send({ password: 'short77' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'password' }] });
    });
  });

  describe('#7 DELETE /api/user/:id (admin or VENTAS_ROLE)', () => {
    test('is 204 with no body; the user is soft-deleted, unlisted, and their token stops working', async () => {
      const res = await request(app).delete(`/api/user/${user.id}`).set(authHeader(adminToken));

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(await UserModel.findById(user.id).lean()).toMatchObject({ state: false });
      expect((await request(app).get('/api/user').set(authHeader(adminToken))).body.meta.total).toBe(1);
      expect((await request(app).put(`/api/user/${user.id}`).set(authHeader(userToken))).status).toBe(401);
    });

    test('VENTAS_ROLE may delete too', async () => {
      const sales = await createUser({ role: 'VENTAS_ROLE' });

      const res = await request(app)
        .delete(`/api/user/${user.id}`)
        .set(authHeader(await tokenFor(sales)));

      expect(res.status).toBe(204);
    });

    test('USER_ROLE is 403 and nothing is deleted', async () => {
      const victim = await createUser();

      const res = await request(app).delete(`/api/user/${victim.id}`).set(authHeader(userToken));

      expect(res.status).toBe(403);
      expect(await UserModel.findById(victim.id).lean()).toMatchObject({ state: true });
    });

    test('without a token it is 401', async () => {
      const res = await request(app).delete(`/api/user/${user.id}`);

      expect(res.status).toBe(401);
    });

    test('a second delete is 404', async () => {
      await request(app).delete(`/api/user/${user.id}`).set(authHeader(adminToken));

      const res = await request(app).delete(`/api/user/${user.id}`).set(authHeader(adminToken));

      expect(res.status).toBe(404);
      expect(res.body).toEqual(notFound);
    });

    test('a user that does not exist is 404', async () => {
      const res = await request(app).delete(`/api/user/${MISSING_ID}`).set(authHeader(adminToken));

      expect(res.status).toBe(404);
    });

    test('a malformed id is 422', async () => {
      const res = await request(app).delete(`/api/user/${BAD_ID}`).set(authHeader(adminToken));

      expect(res.status).toBe(422);
      expect(res.body).toEqual(invalidId);
    });
  });

  describe('authenticate reads User from this module (T3.1 Risk 1)', () => {
    test.each(['not-an-object-id', 'abcdefghijkl'])(
      'a signed token whose uid %s is not an ObjectId is 401, not 400',
      async (uid) => {
        const res = await request(app)
          .get('/api/user')
          .set(authHeader(await generarJWT(uid)));

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
      },
    );
  });
});
