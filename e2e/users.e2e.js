// ARC-03: load models/server before any other application module.
require('../models/server');

jest.mock('../helpers/google-verify', () => ({
  googleVerify: jest.fn(),
}));

const request = require('supertest');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const {
  connectDatabase,
  buildApp,
  closeServers,
  clearDatabase,
  createUser,
  seedRoles,
  tokenFor,
  authHeader,
  reload,
  User,
} = require('./helpers/db');

const USER_LIMIT = 10;

describe('user write policy and access control', () => {
  let app;

  beforeAll(async () => {
    await connectDatabase();
    app = await buildApp();
  });

  afterAll(async () => {
    await closeServers();
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  describe('DB-01 sign-up works on a database with no Role documents', () => {
    test('POST /api/user creates a USER_ROLE account with no seeded roles', async () => {
      const res = await request(app)
        .post('/api/user')
        .send({ name: 'Fresh User', email: 'fresh@example.com', password: 'password123' });

      expect(res.statusCode).toBe(200);
      expect(res.body.role).toBe('USER_ROLE');

      const stored = await User.findOne({ email: 'fresh@example.com' });
      expect(stored).not.toBeNull();
      expect(stored.role).toBe('USER_ROLE');
    });
  });

  describe('SEC-02 POST /api/user ignores a client-supplied role', () => {
    beforeEach(async () => {
      await seedRoles('ADMIN_ROLE', 'USER_ROLE');
    });

    test('a sign-up asking for ADMIN_ROLE is stored as USER_ROLE', async () => {
      const res = await request(app)
        .post('/api/user')
        .send({
          name: 'Wannabe Admin',
          email: 'wannabe@example.com',
          password: 'password123',
          role: 'ADMIN_ROLE',
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.role).toBe('USER_ROLE');

      const stored = await User.findOne({ email: 'wannabe@example.com' });
      expect(stored.role).toBe('USER_ROLE');
    });
  });

  describe('SEC-01 PUT /api/user/:id requires auth and ownership', () => {
    let victim;
    let attacker;
    let rolesToken;

    beforeEach(async () => {
      await seedRoles('ADMIN_ROLE', 'USER_ROLE');
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
      expect(bcrypt.compareSync('attacker-password', after.password)).toBe(false);
    });
  });

  describe('C6 owner self-update only changes the allowed fields', () => {
    beforeEach(async () => {
      await seedRoles('ADMIN_ROLE', 'USER_ROLE');
    });

    test('name and password change; email, role, state, image, google and _id are dropped', async () => {
      const owner = await createUser({ name: 'Owner', email: 'owner@example.com', image: 'original.png' });
      const other = await createUser({ email: 'other@example.com' });
      const token = await tokenFor(owner);

      const res = await request(app)
        .put(`/api/user/${owner.id}`)
        .set(authHeader(token))
        .send({
          name: 'Renamed Owner',
          password: 'brand-new-password',
          email: 'hacked@evil.example',
          role: 'ADMIN_ROLE',
          state: false,
          image: 'hacked.png',
          google: true,
          _id: other.id,
        });

      expect(res.statusCode).toBe(200);

      const updated = await reload(User, owner.id);
      expect(updated.name).toBe('Renamed Owner');
      expect(bcrypt.compareSync('brand-new-password', updated.password)).toBe(true);
      expect(updated.email).toBe('owner@example.com');
      expect(updated.role).toBe('USER_ROLE');
      expect(updated.state).toBe(true);
      expect(updated.image).toBe('original.png');
      expect(updated.google).toBe(false);
      expect(updated.id).toBe(owner.id);
    });
  });

  describe('C6 an admin may change role and state', () => {
    beforeEach(async () => {
      await seedRoles('ADMIN_ROLE', 'USER_ROLE');
    });

    test('an admin PUT can set role to an existing Role and toggle state', async () => {
      const admin = await createUser({ role: 'ADMIN_ROLE', email: 'admin@example.com' });
      const target = await createUser({ email: 'target@example.com' });
      const token = await tokenFor(admin);

      const res = await request(app)
        .put(`/api/user/${target.id}`)
        .set(authHeader(token))
        .send({ role: 'ADMIN_ROLE', state: false });

      expect(res.statusCode).toBe(200);

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

      expect(res.statusCode).toBe(400);

      const unchanged = await reload(User, target.id);
      expect(unchanged.role).toBe('USER_ROLE');
    });
  });

  describe('SEC-05 / C6 GET /api/user is admin-only', () => {
    let userToken;
    let adminToken;

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
      expect(res.statusCode).toBe(200);
      expect(res.body.user).toHaveLength(2);
    });

    test('the list is still paginated below the documented default', async () => {
      const res = await request(app).get('/api/user').set(authHeader(adminToken));
      expect(res.body.user.length).toBeLessThanOrEqual(USER_LIMIT);
    });
  });

  describe('HTTP-01 / C4 insufficient role is 403, not 401', () => {
    test('DELETE /api/user/:id with a non-admin token is 403', async () => {
      const user = await createUser({ email: 'deleter@example.com' });
      const victim = await createUser({ email: 'deleted@example.com' });
      const token = await tokenFor(user);

      const res = await request(app)
        .delete(`/api/user/${victim.id}`)
        .set(authHeader(token));

      expect(res.statusCode).toBe(403);
    });
  });
});
