// The auth contract, §6 rows #2–#3 (M3 design §5.2), over HTTP through createApp. The C5/F1 invariants live in
// security/auth.test.ts, the limiter in security/rate-limit.test.ts.
import type { Server } from 'node:http';

import { OAuth2Client, type LoginTicket } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';

import { UserModel } from '../../../src/modules/users';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { expectStatus } from '../../helpers/assert';
import { changePassword, logoutAll, stubGoogleClient } from '../../helpers/auth';
import { authHeader, createUser, hashPassword, tokenFor } from '../../helpers/factories';

const SECRET = 'test-secret-at-least-32-characters-long'; // SECRET_KEY in vitest.config.mts
const GOOGLE_CLIENT_ID = 'test-client-id'; // GOOGLE_CLIENT_ID in vitest.config.mts
const PASSWORD = 'correct-horse-battery';
const PROFILE = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  picture: 'https://example.com/grace.png',
};
const INVALID_CREDENTIALS = { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } };

/** Every user the API returns carries `id` and the deprecated `uid` alias, and never `_id`, `__v` or the password. */
const expectApiShape = (user: Record<string, unknown>) => {
  expect(user).toHaveProperty('id');
  expect(user.uid).toBe(user.id);
  expect(user).not.toHaveProperty('_id');
  expect(user).not.toHaveProperty('__v');
  expect(user).not.toHaveProperty('password');
};

/** The paths a 422 names. */
const detailPaths = (body: { error: { details: Array<{ path: string }> } }) =>
  body.error.details.map((issue) => issue.path);

describe('auth module (§6 #2–#3)', () => {
  let app: Server;
  let googleVerify: ReturnType<typeof stubGoogleClient>;

  // A new app per test: a new limiter, so no test here runs into another's 429.
  beforeEach(async () => {
    app = await startTestApp();
    await clearDatabase();
    googleVerify = stubGoogleClient(PROFILE);
  });

  afterAll(stopTestApp);

  describe('#2 POST /api/auth/login', () => {
    const login = (body: unknown) =>
      request(app)
        .post('/api/auth/login')
        .send(body as object);

    test('is 200 env({ token, user }): the token in the body, the user with id and uid, never the password', async () => {
      const user = await createUser({ name: 'Ada', password: hashPassword(PASSWORD) });

      const res = await login({ email: user.email, password: PASSWORD });

      expectStatus(res, 200);
      expect(Object.keys(res.body)).toEqual(['data']);
      expect(Object.keys(res.body.data)).toEqual(['token', 'user']);
      expectApiShape(res.body.data.user);
      expect(res.body.data.user).toMatchObject({ id: user.id, name: 'Ada', email: user.email, state: true });
      expect(jwt.verify(res.body.data.token, SECRET)).toMatchObject({ uid: user.id });
    });

    test('the token is an x-token authenticate accepts (M5 moves it to Bearer)', async () => {
      const user = await createUser({ password: hashPassword(PASSWORD) });
      const { body } = await login({ email: user.email, password: PASSWORD });

      const res = await request(app)
        .put(`/api/user/${user.id}`)
        .set('x-token', body.data.token)
        .send({ name: 'Renamed' });

      expectStatus(res, 200);
      expect(res.body.data).toMatchObject({ id: user.id, name: 'Renamed' });
    });

    test('a wrong password is 401 UNAUTHORIZED "Invalid credentials"', async () => {
      const user = await createUser({ password: hashPassword(PASSWORD) });

      const res = await login({ email: user.email, password: 'not-the-password' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
    });

    test.each([
      ['an empty body', {}, ['email', 'password']],
      ['a malformed email', { email: 'not-an-email', password: PASSWORD }, ['email']],
      ['an empty password', { email: 'ada@example.com', password: '' }, ['password']],
      ['a non-string password', { email: 'ada@example.com', password: 12345678 }, ['password']],
      ['an operator object as the email', { email: { $gt: '' }, password: PASSWORD }, ['email']],
      ['an array as the email', { email: ['ada@example.com'], password: PASSWORD }, ['email']],
    ])('%s is 422 VALIDATION_FAILED naming the field', async (_case, body, paths) => {
      const res = await login(body);

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Validation failed' });
      expect(detailPaths(res.body)).toEqual(paths);
    });

    test('a request with no JSON body is 422 VALIDATION_FAILED', async () => {
      const res = await request(app).post('/api/auth/login').type('text').send('ada@example.com:password');

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(detailPaths(res.body)).toEqual(['']);
    });
  });

  describe('#3 POST /api/auth/google', () => {
    const googleSignin = (body: unknown = { id_token: 'google-id-token' }) =>
      request(app)
        .post('/api/auth/google')
        .send(body as object);

    test('a first sign-in creates the account and is 200 env({ token, user })', async () => {
      const res = await googleSignin();

      expectStatus(res, 200);
      expect(googleVerify).toHaveBeenCalledExactlyOnceWith('google-id-token');
      expect(Object.keys(res.body.data)).toEqual(['token', 'user']);
      expectApiShape(res.body.data.user);
      expect(res.body.data.user).toMatchObject({
        name: PROFILE.name,
        email: PROFILE.email,
        image: PROFILE.picture,
        google: true,
        role: 'USER_ROLE',
        state: true,
      });
      expect(jwt.verify(res.body.data.token, SECRET)).toMatchObject({ uid: res.body.data.user.id });
    });

    test("the users module's model stores a Google account with no password at all (ADR-036, SEC-12)", async () => {
      const { body } = await googleSignin();

      const stored = await UserModel.findById(body.data.user.id, '+password').lean(); // select: false (AM-M4-1)

      expect(stored).toMatchObject({
        name: PROFILE.name,
        email: PROFILE.email,
        image: PROFILE.picture,
        google: true,
        role: 'USER_ROLE',
        state: true,
      });
      expect(stored).not.toHaveProperty('password'); // no ':D' placeholder any more
    });

    test('a second sign-in reuses the account', async () => {
      const first = await googleSignin();
      googleVerify.mockResolvedValueOnce({
        ...PROFILE,
        name: 'Another Name',
        picture: 'https://example.com/b.png',
        emailVerified: true,
      });

      const second = await googleSignin();

      expectStatus(second, 200);
      expect(second.body.data.user).toMatchObject({
        id: first.body.data.user.id,
        name: PROFILE.name,
        image: PROFILE.picture,
      });
      expect(await UserModel.countDocuments({ email: PROFILE.email })).toBe(1);
    });

    test('createApp verifies Google tokens for config.auth.googleClientId', async () => {
      googleVerify.mockRestore(); // one layer down: the real GoogleClient, over a stubbed SDK
      const verifyIdToken = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken') as unknown as MockInstance<
        (options: { idToken: string; audience?: string }) => Promise<LoginTicket>
      >;
      verifyIdToken.mockResolvedValue({
        getPayload: () => ({
          ...PROFILE,
          email_verified: true,
          iss: 'https://accounts.google.com',
          sub: '1',
          aud: '',
          iat: 0,
          exp: 0,
        }),
      } as LoginTicket);

      const res = await googleSignin();

      expectStatus(res, 200);
      expect(verifyIdToken).toHaveBeenCalledExactlyOnceWith({
        idToken: 'google-id-token',
        audience: GOOGLE_CLIENT_ID,
      });
    });

    test('a token Google does not verify is 401 "Invalid credentials" and creates nothing', async () => {
      googleVerify.mockRejectedValueOnce(new Error('Wrong recipient, payload audience != requiredAudience'));

      const res = await googleSignin();

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
      expect(await UserModel.countDocuments()).toBe(0);
    });

    test('an inactive account is 401 "Invalid credentials"', async () => {
      await createUser({ email: PROFILE.email, state: false, google: true });

      const res = await googleSignin();

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
    });

    test('a verified profile without a name is rejected by the model, as today: 400 BAD_REQUEST', async () => {
      googleVerify.mockResolvedValueOnce({
        email: PROFILE.email,
        picture: PROFILE.picture,
        emailVerified: true,
      });

      const res = await googleSignin();

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(await UserModel.countDocuments()).toBe(0);
    });

    // ADR-036 / P27: an address Google has not verified proves nothing; the answer is every failure's answer.
    test('an unverified address (email_verified false) is 401 "Invalid credentials" and creates nothing', async () => {
      googleVerify.mockResolvedValueOnce({ ...PROFILE, emailVerified: false });

      const res = await googleSignin();

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
      expect(await UserModel.countDocuments()).toBe(0);
    });

    test('a Google payload without email_verified is 401, through the real GoogleClient', async () => {
      googleVerify.mockRestore(); // the SDK answers; GoogleClient reads the claim
      const verifyIdToken = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken') as unknown as MockInstance<
        (options: { idToken: string; audience?: string }) => Promise<LoginTicket>
      >;
      verifyIdToken.mockResolvedValue({
        getPayload: () => ({
          ...PROFILE,
          iss: 'https://accounts.google.com',
          sub: '1',
          aud: '',
          iat: 0,
          exp: 0,
        }),
      } as LoginTicket);

      const res = await googleSignin();

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
      expect(await UserModel.countDocuments()).toBe(0);
    });

    // AM-M5-1: no silent account link. The password account is untouched, and its own login still works.
    test('a password account\'s address is 401 "Invalid credentials", and the account is untouched', async () => {
      const owner = await createUser({
        email: PROFILE.email,
        name: 'Owner',
        password: hashPassword(PASSWORD),
      });
      const before = await UserModel.findById(owner.id, '+password').lean();

      const res = await googleSignin();

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
      expect(await UserModel.findById(owner.id, '+password').lean()).toEqual(before);
      expect(await UserModel.countDocuments()).toBe(1);
      expectStatus(
        await request(app).post('/api/auth/login').send({ email: PROFILE.email, password: PASSWORD }),
        200,
      );
    });

    test('a Google-only account never logs in with a password, whatever it sends', async () => {
      await googleSignin();

      for (const password of ['dummy-password', ':D', PASSWORD]) {
        const res = await request(app).post('/api/auth/login').send({ email: PROFILE.email, password });

        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID_CREDENTIALS);
      }
    });

    test.each([
      ['an empty body', {}],
      ['an empty id_token', { id_token: '' }],
      ['a non-string id_token', { id_token: 123 }],
    ])('%s is 422 VALIDATION_FAILED on id_token, and Google is never asked', async (_case, body) => {
      const res = await googleSignin(body);

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(detailPaths(res.body)).toEqual(['id_token']);
      expect(googleVerify).not.toHaveBeenCalled();
    });
  });

  // §2.1 #24 (ADR-033, AM-M5-4): every token of the user stops verifying, the caller's included.
  describe('#24 POST /api/auth/logout-all', () => {
    const INVALID_TOKEN = { error: { code: 'UNAUTHORIZED', message: 'Invalid token' } };
    const login = (email: string, password = PASSWORD) =>
      request(app).post('/api/auth/login').send({ email, password });
    /** A protected route the caller may use on itself. */
    const rename = (id: string, token: string) =>
      request(app).put(`/api/user/${id}`).set(authHeader(token)).send({ name: 'Renamed' });
    const tvOf = (token: string) => (jwt.decode(token) as { tv: number }).tv;

    test('is 204 with no body, and every token of the user is refused afterwards (the replay is 401)', async () => {
      const user = await createUser({ password: hashPassword(PASSWORD) });
      const first = (await login(user.email)).body.data.token as string;
      const second = (await login(user.email)).body.data.token as string;

      const res = await logoutAll(app, authHeader(first));

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      for (const token of [first, second]) {
        const replay = await rename(user.id, token);
        expect(replay.status).toBe(401);
        expect(replay.body).toEqual(INVALID_TOKEN); // the same answer as any other invalid token (P23)
      }
      expect((await logoutAll(app, authHeader(first))).status).toBe(401);
    });

    // AM-M5-9: login signs the user's own tokenVersion, or a logout-all would lock the user out for good.
    test('a login after it is 200 with the new tv, and that token works', async () => {
      const user = await createUser({ password: hashPassword(PASSWORD) });
      const before = (await login(user.email)).body.data.token as string;
      await logoutAll(app, authHeader(before));

      const res = await login(user.email);

      expectStatus(res, 200);
      expect(tvOf(before)).toBe(0);
      expect(tvOf(res.body.data.token)).toBe(1);
      expectStatus(await rename(user.id, res.body.data.token), 200);
    });

    test("another user's tokens are untouched", async () => {
      const user = await createUser({ password: hashPassword(PASSWORD) });
      const other = await createUser({ password: hashPassword(PASSWORD) });
      const otherToken = (await login(other.email)).body.data.token as string;

      await logoutAll(app, authHeader((await login(user.email)).body.data.token));

      expectStatus(await rename(other.id, otherToken), 200);
    });

    test('without a token is 401', async () => {
      const res = await logoutAll(app, {});

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'No token in the request' } });
    });
  });

  // §2.1 #25: the current password is checked F1-flat; the new one follows the policy (P26); every earlier token
  // stops verifying, and the answer carries a fresh one so the caller stays signed in (AM-M5-4).
  describe('#25 PUT /api/auth/password', () => {
    const NEW_PASSWORD = 'a-brand-new-password';
    const login = (email: string, password = PASSWORD) =>
      request(app).post('/api/auth/login').send({ email, password });
    const rename = (id: string, token: string) =>
      request(app).put(`/api/user/${id}`).set(authHeader(token)).send({ name: 'Renamed' });

    test('is 200 env({ token }): the fresh token works, every earlier one is refused, the new password logs in', async () => {
      const user = await createUser({ password: hashPassword(PASSWORD) });
      const current = (await login(user.email)).body.data.token as string;
      const elsewhere = (await login(user.email)).body.data.token as string;

      const res = await changePassword(app, authHeader(current), {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      expectStatus(res, 200);
      expect(Object.keys(res.body)).toEqual(['data']);
      expect(Object.keys(res.body.data)).toEqual(['token']);
      expect(jwt.verify(res.body.data.token, SECRET)).toMatchObject({ uid: user.id, tv: 1 });
      expectStatus(await rename(user.id, res.body.data.token), 200);
      for (const token of [current, elsewhere]) expect((await rename(user.id, token)).status).toBe(401);
      expect((await login(user.email)).status).toBe(401);
      expectStatus(await login(user.email, NEW_PASSWORD), 200);
      const stored = await UserModel.findById(user.id, '+password').lean();
      expect(stored?.password).toMatch(/^\$2[ab]\$10\$/); // config.auth.bcryptCost
    });

    test('a wrong current password is 401 "Invalid credentials", and nothing changes', async () => {
      const user = await createUser({ password: hashPassword(PASSWORD) });
      const token = (await login(user.email)).body.data.token as string;

      const res = await changePassword(app, authHeader(token), {
        currentPassword: 'not-the-password',
        newPassword: NEW_PASSWORD,
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
      expectStatus(await rename(user.id, token), 200); // tokenVersion unchanged
      expectStatus(await login(user.email), 200); // the password too
    });

    test('a Google-only account has no password to change: 401 "Invalid credentials"', async () => {
      const google = await createUser({ google: true, password: undefined });
      const token = await tokenFor(google);

      const res = await changePassword(app, authHeader(token), {
        currentPassword: 'anything-at-all',
        newPassword: NEW_PASSWORD,
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
      expect(await UserModel.findById(google.id, '+password').lean()).not.toHaveProperty('password');
    });

    test.each([
      ['a 73-byte new password', { currentPassword: PASSWORD, newPassword: 'p'.repeat(73) }, ['newPassword']],
      ['19 emoji (76 bytes)', { currentPassword: PASSWORD, newPassword: '😀'.repeat(19) }, ['newPassword']],
      [
        'a 7-character new password',
        { currentPassword: PASSWORD, newPassword: 'p'.repeat(7) },
        ['newPassword'],
      ],
      ['no current password', { newPassword: NEW_PASSWORD }, ['currentPassword']],
      ['an empty body', {}, ['currentPassword', 'newPassword']],
    ])('%s is 422 VALIDATION_FAILED naming the field, and nothing changes', async (_case, body, paths) => {
      const user = await createUser({ password: hashPassword(PASSWORD) });
      const token = await tokenFor(user);

      const res = await changePassword(app, authHeader(token), body);

      expect(res.status).toBe(422);
      expect(detailPaths(res.body)).toEqual(paths);
      expectStatus(await rename(user.id, token), 200);
    });

    test('without a token is 401, and the body is never read', async () => {
      const res = await changePassword(app, {}, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'No token in the request' } });
    });

    test('is not throttled (AM-M5-5): the 12th wrong attempt is still the generic 401', async () => {
      const user = await createUser({ password: hashPassword(PASSWORD) });
      const token = await tokenFor(user);

      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push(
          (
            await changePassword(app, authHeader(token), {
              currentPassword: 'wrong',
              newPassword: NEW_PASSWORD,
            })
          ).status,
        );
      }

      expect(statuses).toEqual(Array(12).fill(401));
    });
  });
});
