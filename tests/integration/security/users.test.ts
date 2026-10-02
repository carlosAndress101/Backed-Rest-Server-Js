import type { Server } from 'node:http';

import bcrypt from 'bcrypt';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { UserModel as User, type UserDocument } from '../../../src/modules/users';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { expectStatus } from '../../helpers/assert';
import { authHeader, createUser, reload, tokenFor } from '../../helpers/factories';

const USER_LIMIT = 10;

describe('user write policy and access control', () => {
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

  describe('DB-01 sign-up works on a database with no Role documents', () => {
    test('POST /api/user creates a USER_ROLE account with no seeded roles', async () => {
      const res = await request(app)
        .post('/api/user')
        .send({ name: 'Fresh User', email: 'fresh@example.com', password: 'password123' });

      expectStatus(res, 201);
      expect(res.body.data.role).toBe('USER_ROLE');

      const stored = await User.findOne({ email: 'fresh@example.com' });
      expect(stored).not.toBeNull();
      expect(stored!.role).toBe('USER_ROLE');
    });
  });

  describe('SEC-02 POST /api/user ignores a client-supplied role', () => {
    test('a sign-up asking for ADMIN_ROLE is stored as USER_ROLE', async () => {
      const res = await request(app).post('/api/user').send({
        name: 'Wannabe Admin',
        email: 'wannabe@example.com',
        password: 'password123',
        role: 'ADMIN_ROLE',
      });

      expectStatus(res, 201);
      expect(res.body.data.role).toBe('USER_ROLE');

      const stored = await User.findOne({ email: 'wannabe@example.com' });
      expect(stored!.role).toBe('USER_ROLE');
    });
  });

  describe('SEC-01 PUT /api/user/:id requires auth and ownership', () => {
    let victim: UserDocument;
    let attacker: UserDocument;
    let rolesToken: string;

    beforeEach(async () => {
      victim = await createUser({ name: 'Victim', email: 'victim@example.com' });
      attacker = await createUser({ name: 'Attacker', email: 'attacker@example.com' });
      rolesToken = await tokenFor(attacker);
    });

    test('an unauthenticated PUT is 401', async () => {
      const res = await request(app)
        .put(`/api/user/${victim.id}`)
        .send({ name: 'Owned', role: 'ADMIN_ROLE', password: 'attacker-password' });

      expect(res.statusCode).toBe(401);
    });

    test('an invalid token is 401 (C4)', async () => {
      const res = await request(app)
        .put(`/api/user/${victim.id}`)
        .set(authHeader('not-a-valid-jwt'))
        .send({ name: 'Owned', role: 'ADMIN_ROLE' });

      expect(res.statusCode).toBe(401);
    });

    test('a non-owner PUT is 403 and leaves the victim untouched', async () => {
      const res = await request(app)
        .put(`/api/user/${victim.id}`)
        .set(authHeader(rolesToken))
        .send({ name: 'Owned', role: 'ADMIN_ROLE', password: 'attacker-password' });

      expect(res.statusCode).toBe(403);

      const after = await reload(User, victim.id);
      expect(after.name).toBe('Victim');
      expect(after.role).toBe('USER_ROLE');
      const { password } = await User.findById(victim.id, '+password').orFail(); // select: false (AM-M4-1)
      expect(bcrypt.compareSync('attacker-password', password)).toBe(false);
    });
  });

  describe('C6 owner self-update only changes the allowed fields', () => {
    test('name changes; email, role, state, image, google and _id are dropped', async () => {
      const owner = await createUser({ name: 'Owner', email: 'owner@example.com', image: 'original.png' });
      const other = await createUser({ email: 'other@example.com' });
      const token = await tokenFor(owner);

      const res = await request(app).put(`/api/user/${owner.id}`).set(authHeader(token)).send({
        name: 'Renamed Owner',
        email: 'hacked@evil.example',
        role: 'ADMIN_ROLE',
        state: false,
        image: 'hacked.png',
        google: true,
        _id: other.id,
      });

      expectStatus(res, 200);

      const updated = await reload(User, owner.id);
      expect(updated.name).toBe('Renamed Owner');
      expect(updated.email).toBe('owner@example.com');
      expect(updated.role).toBe('USER_ROLE');
      expect(updated.state).toBe(true);
      expect(updated.image).toBe('original.png');
      expect(updated.google).toBe(false);
      expect(updated.id).toBe(owner.id);
    });
  });

  describe('AM-M5-10 a token alone cannot change its own password', () => {
    test('a password on your own account is 422 and nothing is written, not even the name', async () => {
      const owner = await createUser({ name: 'Owner', email: 'owner@example.com' });
      const token = await tokenFor(owner);
      const before = await User.findById(owner.id, '+password +tokenVersion').lean().orFail();

      const res = await request(app)
        .put(`/api/user/${owner.id}`)
        .set(authHeader(token))
        .send({ name: 'Stolen', password: 'attacker-password' });

      expect(res.statusCode).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'password' }] });
      expect(await User.findById(owner.id, '+password +tokenVersion').lean().orFail()).toEqual(before);
    });
  });

  describe('C6 an admin may change role and state', () => {
    test('an admin PUT can set role to one of ROLES and toggle state', async () => {
      const admin = await createUser({ role: 'ADMIN_ROLE', email: 'admin@example.com' });
      const target = await createUser({ email: 'target@example.com' });
      const token = await tokenFor(admin);

      const res = await request(app)
        .put(`/api/user/${target.id}`)
        .set(authHeader(token))
        .send({ role: 'ADMIN_ROLE', state: false });

      expectStatus(res, 200);

      const updated = await reload(User, target.id);
      expect(updated.role).toBe('ADMIN_ROLE');
      expect(updated.state).toBe(false);
    });

    test('an admin may not assign a role that does not exist', async () => {
      const admin = await createUser({ role: 'ADMIN_ROLE', email: 'admin2@example.com' });
      const target = await createUser({ email: 'target2@example.com' });
      const token = await tokenFor(admin);

      const res = await request(app)
        .put(`/api/user/${target.id}`)
        .set(authHeader(token))
        .send({ role: 'NOT_A_REAL_ROLE' });

      expect(res.statusCode).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'role' }] });

      const unchanged = await reload(User, target.id);
      expect(unchanged.role).toBe('USER_ROLE');
    });
  });

  describe('SEC-05 / C6 GET /api/user is admin-only', () => {
    let userToken: string;
    let adminToken: string;

    beforeEach(async () => {
      const user = await createUser({ email: 'plain@example.com' });
      const admin = await createUser({ role: 'ADMIN_ROLE', email: 'boss@example.com' });
      userToken = await tokenFor(user);
      adminToken = await tokenFor(admin);
    });

    test('no token is 401', async () => {
      const res = await request(app).get('/api/user');
      expect(res.statusCode).toBe(401);
    });

    test('a non-admin token is 403', async () => {
      const res = await request(app).get('/api/user').set(authHeader(userToken));
      expect(res.statusCode).toBe(403);
    });

    test('an admin token is 200', async () => {
      const res = await request(app).get('/api/user').set(authHeader(adminToken));
      expectStatus(res, 200);
      expect(res.body.data).toHaveLength(2);
    });

    test('the list is still paginated below the documented default', async () => {
      const res = await request(app).get('/api/user').set(authHeader(adminToken));
      expect(res.body.data.length).toBeLessThanOrEqual(USER_LIMIT);
    });
  });

  describe('HTTP-01 / C4 insufficient role is 403, not 401', () => {
    test('DELETE /api/user/:id with a non-admin token is 403', async () => {
      const user = await createUser({ email: 'deleter@example.com' });
      const victim = await createUser({ email: 'deleted@example.com' });
      const token = await tokenFor(user);

      const res = await request(app).delete(`/api/user/${victim.id}`).set(authHeader(token));

      expect(res.statusCode).toBe(403);
    });
  });
});
