// The auth rules (M3 design §5.2) against an in-memory model: no database, no vi.mock (ADR-023). F1 and C5 are
// asserted here on the service itself: every credential failure is one bcrypt compare and one generic 401.
import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';

import { UnauthorizedError } from '../../../src/core/errors';
import type { TokenService } from '../../../src/core/security/jwt';
import {
  createAuthService,
  type GoogleSignUp,
  type SignInUser,
} from '../../../src/modules/auth/auth.service';
import type { GoogleProfile, GoogleVerifier } from '../../../src/modules/auth/google.client';

interface Row extends SignInUser {
  _id: string;
  email?: string;
  name?: string;
}

const PASSWORD = 'correct-horse-battery';
const HASH = bcrypt.hashSync(PASSWORD, 4); // cheap: only the service's dummy has to cost 10
const COST_10_HASH = /^\$2[ab]\$10\$[./A-Za-z0-9]{53}$/;
const PROFILE: GoogleProfile = {
  name: 'Grace',
  email: 'grace@example.com',
  picture: 'https://example.com/g.png',
};

/** A hand-written User model holding `rows`, with only the two methods the service calls. */
function fakeUserModel(seed: Row[] = []) {
  const rows = seed.map((stored) => ({ ...stored }));
  const User = {
    findOne: vi.fn((filter: { email: string | undefined }) =>
      Promise.resolve(rows.find((stored) => stored.email === filter.email) ?? null),
    ),
    create: vi.fn((doc: GoogleSignUp) => {
      const created: Row = { _id: `id-${rows.length + 1}`, state: true, ...doc };
      rows.push(created);
      return Promise.resolve(created);
    }),
  };
  return { rows, User };
}

const fakeGoogle = (profile: GoogleProfile = PROFILE) => ({
  verify: vi.fn<GoogleVerifier['verify']>(() => Promise.resolve(profile)),
});

/** The service over fakes; `sign` is the token service's, which mints `token-for-<uid>`. */
const build = (seed: Row[] = [], google = fakeGoogle()) => {
  const { rows, User } = fakeUserModel(seed);
  const sign = vi.fn<TokenService['sign']>((uid) => Promise.resolve(`token-for-${uid}`));
  const tokens: TokenService = { sign, verify: vi.fn() };
  return { rows, User, sign, google, service: createAuthService({ User, tokens, google }) };
};

const rejectsWithInvalidCredentials = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(UnauthorizedError);
  expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'Invalid credentials' });
};

describe('createAuthService', () => {
  let compareSync: MockInstance<typeof bcrypt.compareSync>;

  beforeEach(() => {
    compareSync = vi.spyOn(bcrypt, 'compareSync');
  });

  describe('login (F1, C5)', () => {
    test('the right password on an active account signs a token for the user', async () => {
      const { service, sign, User } = build([
        { _id: '1', email: 'ada@example.com', password: HASH, state: true },
      ]);

      const session = await service.login({ email: 'ada@example.com', password: PASSWORD });

      expect(User.findOne).toHaveBeenCalledExactlyOnceWith({ email: 'ada@example.com' });
      expect(sign).toHaveBeenCalledExactlyOnceWith('1');
      expect(session).toEqual({
        token: 'token-for-1',
        user: { _id: '1', email: 'ada@example.com', password: HASH, state: true },
      });
      expect(compareSync).toHaveBeenCalledExactlyOnceWith(PASSWORD, HASH);
    });

    // [case, stored account (or none), password sent, whether the stored hash is the one compared]
    const failures: Array<[string, Row | undefined, string, boolean]> = [
      ['an unknown email', undefined, PASSWORD, false],
      ['an unknown email with the dummy password', undefined, 'dummy-password', false],
      ['a wrong password', { _id: '1', email: 'x@example.com', password: HASH, state: true }, 'wrong', true],
      [
        'an inactive account',
        { _id: '1', email: 'x@example.com', password: HASH, state: false },
        PASSWORD,
        true,
      ],
      [
        "a Google account's ':D'",
        { _id: '1', email: 'x@example.com', password: ':D', state: true },
        ':D',
        false,
      ],
      [
        'a Google account with the dummy password',
        { _id: '1', email: 'x@example.com', password: ':D', state: true },
        'dummy-password',
        false,
      ],
      [
        'a $2y$ hash (not one bcrypt works on here)',
        { _id: '1', email: 'x@example.com', password: HASH.replace('$2b$', '$2y$'), state: true },
        PASSWORD,
        false,
      ],
      [
        'a hash with cost 03',
        { _id: '1', email: 'x@example.com', password: HASH.replace('$04$', '$03$'), state: true },
        PASSWORD,
        false,
      ],
      [
        'a hash with cost 32',
        { _id: '1', email: 'x@example.com', password: HASH.replace('$04$', '$32$'), state: true },
        PASSWORD,
        false,
      ],
      [
        'a truncated hash',
        { _id: '1', email: 'x@example.com', password: HASH.slice(0, -1), state: true },
        PASSWORD,
        false,
      ],
      [
        'an empty stored password',
        { _id: '1', email: 'x@example.com', password: '', state: true },
        PASSWORD,
        false,
      ],
    ];

    test.each(failures)(
      '%s is the generic 401 after exactly one bcrypt compare',
      async (_case, stored, password, comparesStoredHash) => {
        const { service, sign } = build(stored ? [stored] : []);

        await rejectsWithInvalidCredentials(service.login({ email: 'x@example.com', password }));

        expect(compareSync).toHaveBeenCalledTimes(1);
        const [sent, hash] = compareSync.mock.calls[0]!;
        expect(sent).toBe(password);
        if (comparesStoredHash) expect(hash).toBe(stored!.password);
        else expect(hash).toMatch(COST_10_HASH); // the dummy: the production cost, whatever the account stores
        expect(sign).not.toHaveBeenCalled();
      },
    );

    test('every account without a usable hash is compared against the same dummy', async () => {
      const { service } = build([{ _id: '1', email: 'google@example.com', password: ':D', state: true }]);

      await rejectsWithInvalidCredentials(service.login({ email: 'ghost@example.com', password: PASSWORD }));
      await rejectsWithInvalidCredentials(service.login({ email: 'google@example.com', password: PASSWORD }));

      expect(compareSync.mock.calls[0]![1]).toBe(compareSync.mock.calls[1]![1]);
    });

    test('the dummy password matches the dummy hash, and an unknown email is still refused', async () => {
      const { service } = build();

      await rejectsWithInvalidCredentials(
        service.login({ email: 'ghost@example.com', password: 'dummy-password' }),
      );

      expect(compareSync.mock.results[0]).toEqual({ type: 'return', value: true });
    });

    test('a token that cannot be signed rejects with the original error, not a 401', async () => {
      const { service, sign } = build([{ _id: '1', email: 'ada@example.com', password: HASH, state: true }]);
      sign.mockRejectedValueOnce(new Error('secretOrPrivateKey must have a value'));

      await expect(service.login({ email: 'ada@example.com', password: PASSWORD })).rejects.toThrow(
        'secretOrPrivateKey must have a value',
      );
    });
  });

  describe('googleSignIn', () => {
    test('a first sign-in creates the account with the legacy shape and signs a token for it', async () => {
      const { service, User, sign, google, rows } = build();

      const session = await service.googleSignIn({ id_token: 'google-id-token' });

      expect(google.verify).toHaveBeenCalledExactlyOnceWith('google-id-token');
      expect(User.findOne).toHaveBeenCalledExactlyOnceWith({ email: PROFILE.email });
      expect(User.create).toHaveBeenCalledExactlyOnceWith({
        name: PROFILE.name,
        email: PROFILE.email,
        password: ':D',
        image: PROFILE.picture,
        google: true,
      });
      expect(sign).toHaveBeenCalledExactlyOnceWith('id-1');
      expect(session).toEqual({ token: 'token-for-id-1', user: rows[0] });
    });

    test('an existing active account signs in without being created again or changed', async () => {
      const existing: Row = { _id: '7', email: PROFILE.email, name: 'Old Name', password: ':D', state: true };
      const { service, User } = build([existing]);

      const session = await service.googleSignIn({ id_token: 'google-id-token' });

      expect(User.create).not.toHaveBeenCalled();
      expect(session).toEqual({ token: 'token-for-7', user: existing });
    });

    test('an inactive account is the generic 401, and no token is signed', async () => {
      const { service, User, sign } = build([
        { _id: '7', email: PROFILE.email, password: ':D', state: false },
      ]);

      await rejectsWithInvalidCredentials(service.googleSignIn({ id_token: 'google-id-token' }));

      expect(User.create).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    });

    test('a token Google rejects is the generic 401, before any lookup', async () => {
      const google = fakeGoogle();
      google.verify.mockRejectedValueOnce(new Error('Token used too late'));
      const { service, User } = build([], google);

      await rejectsWithInvalidCredentials(service.googleSignIn({ id_token: 'expired' }));

      expect(User.findOne).not.toHaveBeenCalled();
      expect(User.create).not.toHaveBeenCalled();
    });

    test('an account that cannot be created rejects with the model error, not a 401', async () => {
      const { service, User } = build();
      User.create.mockRejectedValueOnce(new Error('Path `name` is required.'));

      await expect(service.googleSignIn({ id_token: 'google-id-token' })).rejects.toThrow(
        'Path `name` is required.',
      );
    });

    test('Google sign-in never compares a password', async () => {
      const { service } = build();

      await service.googleSignIn({ id_token: 'google-id-token' });

      expect(compareSync).not.toHaveBeenCalled();
    });
  });
});
