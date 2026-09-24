import type { Server } from 'node:http';

import bcrypt from 'bcrypt';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from 'vitest';

import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { expectStatus } from '../../helpers/assert';
import { stubGoogleClient } from '../../helpers/auth';
import { createUser, hashPassword } from '../../helpers/factories';

const login = (app: Server, body: object) => request(app).post('/api/auth/login').send(body);
const googleSignin = (app: Server, idToken = 'fake-id-token') =>
  request(app).post('/api/auth/google').send({ id_token: idToken });

// C5: the one answer every credential failure gets (3.0.0: the error envelope).
const INVALID_CREDENTIALS = { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } };

describe('auth surface', () => {
  let app: Server;
  let googleVerify: ReturnType<typeof stubGoogleClient>;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await clearDatabase();
    googleVerify = stubGoogleClient();
  });

  describe('C5 credential failures return a generic 401', () => {
    test('unknown email is 401 with a generic message', async () => {
      const res = await login(app, { email: 'nobody@example.com', password: 'whatever-123' });

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
    });

    test('a disabled account is 401 with the same generic message', async () => {
      const disabled = await createUser({
        email: 'disabled@example.com',
        password: hashPassword('correct-password'),
        state: false,
      });

      const res = await login(app, { email: disabled.email, password: 'correct-password' });

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
    });

    test('a wrong password is 401 with the same generic message', async () => {
      const user = await createUser({
        email: 'wrong-pass@example.com',
        password: hashPassword('correct-password'),
      });

      const res = await login(app, { email: user.email, password: 'not-the-password' });

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
    });

    test('valid credentials still return a token (positive control)', async () => {
      const user = await createUser({
        email: 'valid@example.com',
        password: hashPassword('correct-password'),
      });

      const res = await login(app, { email: user.email, password: 'correct-password' });

      expectStatus(res, 200);
      expect(typeof res.body.data.token).toBe('string');
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
      expect(res.body).toEqual(INVALID_CREDENTIALS);
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
        expect(res.body).toEqual(INVALID_CREDENTIALS);
      });
      expect(unknownEmail.body).toEqual(disabledUser.body);
      expect(disabledUser.body).toEqual(wrongPassword.body);
    });

    // Timing: every failure must cost one full bcrypt comparison at the production
    // cost (10), whatever the account stores. Asserted on the compareSync call, not on
    // wall-clock time. The accounts use real cost-10 hashes, not the helper's cost 4.
    describe('every failure costs exactly one cost-10 bcrypt comparison', () => {
      const COST_10_HASH = /^\$2[ab]\$10\$[./A-Za-z0-9]{53}$/;
      let compareSync: MockInstance<typeof bcrypt.compareSync>;

      // This file shares one C5 budget (10 auth requests per IP) that the tests above
      // almost use up. Here every login comes from its own client behind a trusted
      // proxy (C9), so it gets its own bucket and the budget above is untouched.
      let proxiedApp: Server;
      let client = 0;
      const loginAsNewClient = (body: object) =>
        login(proxiedApp, body).set('X-Forwarded-For', `198.51.100.${(client += 1)}`);

      beforeAll(async () => {
        proxiedApp = await startTestApp({ TRUST_PROXY: '1' });
      });

      beforeEach(() => {
        compareSync = vi.spyOn(bcrypt, 'compareSync');
      });

      afterEach(() => {
        compareSync.mockRestore();
      });

      const cases: Array<[string, () => Promise<{ email: string; password: string }>]> = [
        [
          'an unknown email',
          async () => ({ email: 'timing-ghost@example.com', password: 'correct-password' }),
        ],
        [
          'a disabled account',
          async () => {
            const user = await createUser({
              email: 'timing-disabled@example.com',
              password: bcrypt.hashSync('correct-password', 10),
              state: false,
            });
            return { email: user.email, password: 'correct-password' };
          },
        ],
        [
          'a wrong password on a password account',
          async () => {
            const user = await createUser({
              email: 'timing-active@example.com',
              password: bcrypt.hashSync('correct-password', 10),
            });
            return { email: user.email, password: 'wrong-password' };
          },
        ],
        [
          'any password on a Google-created account',
          async () => {
            const user = await createUser({
              email: 'timing-google@example.com',
              password: ':D',
              google: true,
            });
            return { email: user.email, password: 'any-password-123' };
          },
        ],
      ];

      test.each(cases)('%s', async (name, setup) => {
        const body = await setup();
        compareSync.mockClear();

        const res = await loginAsNewClient(body);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual(INVALID_CREDENTIALS);
        expect(Object.keys(res.body)).toEqual(['error']);
        expect(compareSync).toHaveBeenCalledTimes(1);
        expect(compareSync.mock.calls[0]![1]).toMatch(COST_10_HASH);
      });

      test('a Google-created account answers exactly like an unknown email', async () => {
        const google = await createUser({
          email: 'timing-google-2@example.com',
          password: ':D',
          google: true,
        });

        const googleRes = await loginAsNewClient({ email: google.email, password: 'any-password-123' });
        const unknownRes = await loginAsNewClient({
          email: 'timing-ghost-2@example.com',
          password: 'any-password-123',
        });

        expect(googleRes.statusCode).toBe(unknownRes.statusCode);
        expect(googleRes.body).toEqual(unknownRes.body);
        expect(Object.keys(googleRes.body)).toEqual(Object.keys(unknownRes.body));
      });

      test('a Google-created account can never log in with a password, not even the dummy one', async () => {
        const google = await createUser({ email: 'google-only@example.com', password: ':D', google: true });

        for (const password of [':D', 'dummy-password', 'any-password-123']) {
          const res = await loginAsNewClient({ email: google.email, password });

          expect(res.statusCode).toBe(401);
          expect(res.body).toEqual(INVALID_CREDENTIALS);
        }
      });
    });
  });
});
