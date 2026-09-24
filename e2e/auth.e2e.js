// ARC-03: load models/server before any other application module.
require('../models/server');

jest.mock('../helpers/google-verify', () => ({
  googleVerify: jest.fn(),
}));

const request = require('supertest');
const mongoose = require('mongoose');

const {
  connectDatabase,
  buildApp,
  clearDatabase,
  createUser,
  hashPassword,
} = require('./helpers/db');
const { googleVerify } = require('../helpers/google-verify');

const login = (app, body) => request(app).post('/api/auth/login').send(body);
const googleSignin = (app, idToken = 'fake-id-token') =>
  request(app).post('/api/auth/google').send({ id_token: idToken });

describe('auth surface', () => {
  let app;

  beforeAll(async () => {
    await connectDatabase();
    app = buildApp();
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await clearDatabase();
    jest.clearAllMocks();
  });

  describe('C5 credential failures return a generic 401', () => {
    test('unknown email is 401 with a generic message', async () => {
      const res = await login(app, { email: 'nobody@example.com', password: 'whatever-123' });

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid credentials' });
    });

    test('a disabled account is 401 with the same generic message', async () => {
      const disabled = await createUser({
        email: 'disabled@example.com',
        password: hashPassword('correct-password'),
        state: false,
      });

      const res = await login(app, { email: disabled.email, password: 'correct-password' });

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid credentials' });
    });

    test('a wrong password is 401 with the same generic message', async () => {
      const user = await createUser({
        email: 'wrong-pass@example.com',
        password: hashPassword('correct-password'),
      });

      const res = await login(app, { email: user.email, password: 'not-the-password' });

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid credentials' });
    });

    test('valid credentials still return a token (positive control)', async () => {
      const user = await createUser({
        email: 'valid@example.com',
        password: hashPassword('correct-password'),
      });

      const res = await login(app, { email: user.email, password: 'correct-password' });

      expect(res.statusCode).toBe(200);
      expect(typeof res.body.token).toBe('string');
    });

    test('google sign-in for a disabled user is 401 with the generic message', async () => {
      const disabled = await createUser({
        email: 'disabled-google@example.com',
        state: false,
        google: true,
      });
      googleVerify.mockResolvedValueOnce({
        name: 'Disabled Google',
        picture: 'https://example.com/p.png',
        email: disabled.email,
      });

      const res = await googleSignin(app);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid credentials' });
    });
  });

  describe('SEC-07 login enumeration: every credential failure is indistinguishable', () => {
    test('unknown email, disabled user and wrong password share status and body', async () => {
      const active = await createUser({
        email: 'active@example.com',
        password: hashPassword('correct-password'),
      });
      const disabled = await createUser({
        email: 'disabled-enum@example.com',
        password: hashPassword('correct-password'),
        state: false,
      });

      const unknownEmail = await login(app, { email: 'ghost@example.com', password: 'correct-password' });
      const disabledUser = await login(app, { email: disabled.email, password: 'correct-password' });
      const wrongPassword = await login(app, { email: active.email, password: 'wrong-password' });

      [unknownEmail, disabledUser, wrongPassword].forEach((res) => {
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ msg: 'Invalid credentials' });
      });
      expect(unknownEmail.body).toEqual(disabledUser.body);
      expect(disabledUser.body).toEqual(wrongPassword.body);
    });
  });
});
