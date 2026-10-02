// The auth rules (M3 design §5.2, M5 §3.4) against an in-memory model: no database, no vi.mock (ADR-023). F1 and C5
// are asserted here on the service itself: every credential failure is one bcrypt compare and one generic 401.
import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';

import { UnauthorizedError } from '../../../src/core/errors';
import type { TokenService } from '../../../src/core/security/jwt';
import {
  createAuthService,
  type GoogleSignUp,
  type SignInUserWithPassword,
} from '../../../src/modules/auth/auth.service';
import type { GoogleProfile, GoogleVerifier } from '../../../src/modules/auth/google.client';

interface Row extends SignInUserWithPassword {
  _id: string;
  email?: string;
  name?: string;
}
/** A stored user as a test writes it: tokenVersion defaults to 0, as the schema's does. */
type Seed = Omit<Row, 'tokenVersion'> & { tokenVersion?: number };

const COST = 10; // config.auth.bcryptCost in these tests
const PASSWORD = 'correct-horse-battery';
const HASH = bcrypt.hashSync(PASSWORD, 4); // cheap, and of another cost than COST: a login rehashes it (P25)
const COST_10_HASH = /^\$2[ab]\$10\$[./A-Za-z0-9]{53}$/;
const PROFILE: GoogleProfile = {
  name: 'Grace',
  email: 'grace@example.com',
  picture: 'https://example.com/g.png',
  emailVerified: true,
};

/** A found user as Mongoose returns it under `select: false` (AM-M4-1): without the password. */
const withoutPassword = (row: Row): Omit<Row, 'password'> => {
  const found: Partial<Row> = { ...row };
  delete found.password;
  return found as Omit<Row, 'password'>;
};

/**
 * A hand-written User model holding `rows`, with only the two methods the service calls. Like the real one, a found
 * user carries its password only when the read's projection is '+password'.
 */
function fakeUserModel(seed: Seed[] = []) {
  const rows: Row[] = seed.map((stored) => ({ tokenVersion: 0, ...stored }));
  const User = {
    findOne: vi.fn((filter: { email: string | undefined }, projection?: '+password') => {
      const row = rows.find((stored) => stored.email === filter.email) ?? null;
      // a read returns a copy, as a database does
      return Promise.resolve(row && (projection === '+password' ? { ...row } : withoutPassword(row)));
    }),
    create: vi.fn((doc: GoogleSignUp) => {
      const created: Row = { _id: `id-${rows.length + 1}`, state: true, tokenVersion: 0, ...doc };
      rows.push(created);
      return Promise.resolve(created);
    }),
    findById: vi.fn((id: string, projection?: '+password') => {
      const row = rows.find((stored) => stored._id === id) ?? null;
      return Promise.resolve(row && (projection === '+password' ? { ...row } : withoutPassword(row)));
    }),
    // The rehash's compare-and-swap (the hash changes only if it is still the one in the filter), and logout-all's $inc.
    updateOne: vi.fn(
      (
        filter: { _id: unknown; password?: string },
        update: { password?: string; $inc?: { tokenVersion: number } },
      ) => {
        const row = rows.find(
          (stored) =>
            stored._id === filter._id &&
            (filter.password === undefined || stored.password === filter.password),
        );
        if (row && update.password !== undefined) row.password = update.password;
        if (row && update.$inc) row.tokenVersion += update.$inc.tokenVersion;
        return Promise.resolve({ matchedCount: row ? 1 : 0 });
      },
    ),
    // The password change: new hash and next tokenVersion together, on an active account only.
    findOneAndUpdate: vi.fn(
      (
        filter: { _id: string; state: true },
        update: { password: string; $inc: { tokenVersion: number } },
      ) => {
        const row = rows.find((stored) => stored._id === filter._id && stored.state === filter.state);
        if (row) {
          row.password = update.password;
          row.tokenVersion += update.$inc.tokenVersion;
        }
        return Promise.resolve(row ? withoutPassword(row) : null);
      },
    ),
  };
  return { rows, User };
}

const fakeGoogle = (profile: GoogleProfile = PROFILE) => ({
  verify: vi.fn<GoogleVerifier['verify']>(() => Promise.resolve(profile)),
});

/** The service over fakes; `sign` is the token service's, which mints `token-for-<uid>`. */
const build = (seed: Seed[] = [], google = fakeGoogle(), bcryptCost = COST) => {
  const { rows, User } = fakeUserModel(seed);
  const sign = vi.fn<TokenService['sign']>((uid) => Promise.resolve(`token-for-${uid}`));
  const tokens: TokenService = { sign, verify: vi.fn() };
  const log = { warn: vi.fn() };
  return {
    rows,
    User,
    sign,
    google,
    log,
    service: createAuthService({ User, tokens, google, bcryptCost }),
  };
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
  let compare: MockInstance<typeof bcrypt.compare>;

  beforeEach(() => {
    compare = vi.spyOn(bcrypt, 'compare');
  });

  describe('login (F1, C5)', () => {
    test('the right password on an active account signs a token for the user', async () => {
      const { service, sign, User, log } = build([
        { _id: '1', email: 'ada@example.com', password: HASH, state: true },
      ]);

      const session = await service.login({ email: 'ada@example.com', password: PASSWORD }, log);

      // AM-M4-1: the login's read is the one that asks for the select: false hash.
      expect(User.findOne).toHaveBeenCalledExactlyOnceWith({ email: 'ada@example.com' }, '+password');
      expect(sign).toHaveBeenCalledExactlyOnceWith('1', 0); // AM-M5-9: at the user's tokenVersion
      expect(session).toEqual({
        token: 'token-for-1',
        user: { _id: '1', email: 'ada@example.com', password: HASH, state: true, tokenVersion: 0 },
      });
      expect(compare).toHaveBeenCalledExactlyOnceWith(PASSWORD, HASH);
    });

    // [case, stored account (or none), password sent, whether the stored hash is the one compared]
    const failures: Array<[string, Seed | undefined, string, boolean]> = [
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
        const { service, sign, User, log } = build(stored ? [stored] : []);

        await rejectsWithInvalidCredentials(service.login({ email: 'x@example.com', password }, log));

        expect(compare).toHaveBeenCalledTimes(1);
        const [sent, hash] = compare.mock.calls[0]!;
        expect(sent).toBe(password);
        if (comparesStoredHash) expect(hash).toBe(stored!.password);
        else expect(hash).toMatch(COST_10_HASH); // the dummy: the configured cost, whatever the account stores
        expect(sign).not.toHaveBeenCalled();
        expect(User.updateOne).not.toHaveBeenCalled(); // P25: a failed login never rehashes
      },
    );

    test('every account without a usable hash is compared against the same dummy', async () => {
      const { service, log } = build([
        { _id: '1', email: 'google@example.com', password: ':D', state: true },
      ]);

      await rejectsWithInvalidCredentials(
        service.login({ email: 'ghost@example.com', password: PASSWORD }, log),
      );
      await rejectsWithInvalidCredentials(
        service.login({ email: 'google@example.com', password: PASSWORD }, log),
      );

      expect(compare.mock.calls[0]![1]).toBe(compare.mock.calls[1]![1]);
    });

    test('the dummy password matches the dummy hash, and an unknown email is still refused', async () => {
      const { service, log } = build();

      await rejectsWithInvalidCredentials(
        service.login({ email: 'ghost@example.com', password: 'dummy-password' }, log),
      );

      await expect(compare.mock.results[0]!.value).resolves.toBe(true);
    });

    // ADR-035: the dummy costs what every hash the API writes costs, so an unknown email is as slow as a real one.
    test('the dummy is hashed at the configured cost', async () => {
      const { service, log } = build([], fakeGoogle(), 11);

      await rejectsWithInvalidCredentials(
        service.login({ email: 'ghost@example.com', password: PASSWORD }, log),
      );

      expect(compare.mock.calls[0]![1]).toMatch(/^\$2[ab]\$11\$/);
    });

    test("a token is signed at the user's own tokenVersion (AM-M5-9)", async () => {
      const { service, sign, log } = build([
        { _id: '1', email: 'ada@example.com', password: HASH, state: true, tokenVersion: 3 },
      ]);

      await service.login({ email: 'ada@example.com', password: PASSWORD }, log);

      expect(sign).toHaveBeenCalledExactlyOnceWith('1', 3);
    });

    test('a token that cannot be signed rejects with the original error, not a 401', async () => {
      const { service, sign, log } = build([
        { _id: '1', email: 'ada@example.com', password: HASH, state: true },
      ]);
      sign.mockRejectedValueOnce(new Error('secretOrPrivateKey must have a value'));

      await expect(service.login({ email: 'ada@example.com', password: PASSWORD }, log)).rejects.toThrow(
        'secretOrPrivateKey must have a value',
      );
    });
  });

  describe('googleSignIn', () => {
    test('a first sign-in creates a Google-only account with no password and signs a token for it', async () => {
      const { service, User, sign, google, rows } = build();

      const session = await service.googleSignIn({ id_token: 'google-id-token' });

      expect(google.verify).toHaveBeenCalledExactlyOnceWith('google-id-token');
      expect(User.findOne).toHaveBeenCalledExactlyOnceWith({ email: PROFILE.email });
      expect(User.create).toHaveBeenCalledExactlyOnceWith({
        name: PROFILE.name,
        email: PROFILE.email,
        image: PROFILE.picture,
        google: true,
      }); // ADR-036: no ':D' placeholder, no password field at all
      expect(sign).toHaveBeenCalledExactlyOnceWith('id-1', 0);
      expect(session).toEqual({ token: 'token-for-id-1', user: rows[0] });
    });

    // §10.5: the Google address is matched as sign-up and login store it. This fake matches emails exactly (no
    // Mongoose casting), so only the service's own normalization can find the account.
    test('an existing account is found whatever the case or padding of the Google address', async () => {
      const google = fakeGoogle({ ...PROFILE, email: '  Grace@Example.COM ' });
      const { service, User } = build(
        [{ _id: '9', email: 'grace@example.com', state: true, google: true }],
        google,
      );

      const session = await service.googleSignIn({ id_token: 'google-id-token' });

      expect(User.findOne).toHaveBeenCalledExactlyOnceWith({ email: 'grace@example.com' });
      expect(User.create).not.toHaveBeenCalled();
      expect(session.token).toBe('token-for-9');
    });

    test('an existing active account signs in without being created again or changed', async () => {
      const existing: Seed = { _id: '7', email: PROFILE.email, name: 'Old Name', state: true, google: true };
      const { service, User } = build([existing]);

      const session = await service.googleSignIn({ id_token: 'google-id-token' });

      expect(User.create).not.toHaveBeenCalled();
      // AM-M4-1: this read does not select the password, so the session's user never carries it.
      expect(session).toEqual({
        token: 'token-for-7',
        user: {
          _id: '7',
          email: PROFILE.email,
          name: 'Old Name',
          state: true,
          google: true,
          tokenVersion: 0,
        },
      });
    });

    test('an inactive account is the generic 401, and no token is signed', async () => {
      const { service, User, sign } = build([{ _id: '7', email: PROFILE.email, state: false, google: true }]);

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

    // ADR-036 / P27: each of these is the same generic 401, and nothing is looked up, created or signed.
    test.each([
      ['an unverified address', { ...PROFILE, emailVerified: false }],
      ['a verified profile without an address', { ...PROFILE, email: undefined }],
      ['a blank address', { ...PROFILE, email: '   ' }],
    ])('%s is the generic 401, before any lookup', async (_case, profile) => {
      const { service, User, sign } = build([], fakeGoogle(profile));

      await rejectsWithInvalidCredentials(service.googleSignIn({ id_token: 'google-id-token' }));

      expect(User.findOne).not.toHaveBeenCalled();
      expect(User.create).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    });

    // AM-M5-1: a Google sign-in never enters a password account (no silent link, SEC-12).
    test("a password account's address is the generic 401: nothing is created, changed or signed", async () => {
      const owner: Seed = { _id: '5', email: PROFILE.email, password: HASH, state: true, google: false };
      const { service, User, sign, rows } = build([owner]);

      await rejectsWithInvalidCredentials(service.googleSignIn({ id_token: 'google-id-token' }));

      expect(User.create).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
      expect(rows).toEqual([{ ...owner, tokenVersion: 0 }]);
    });

    test('an account with no google flag is treated as a password account', async () => {
      const { service, User } = build([{ _id: '5', email: PROFILE.email, password: HASH, state: true }]);

      await rejectsWithInvalidCredentials(service.googleSignIn({ id_token: 'google-id-token' }));

      expect(User.create).not.toHaveBeenCalled();
    });

    test('Google sign-in never compares a password', async () => {
      const { service } = build();

      await service.googleSignIn({ id_token: 'google-id-token' });

      expect(compare).not.toHaveBeenCalled();
    });
  });

  // ADR-035 / P25: a hash of another cost converges to the configured one on the next successful login, strictly
  // after the compare has decided and without delaying the answer.
  describe('rehash-on-login (P25)', () => {
    const cost4 = { _id: '1', email: 'ada@example.com', password: HASH, state: true };

    test('a hash of another cost is replaced by one at the configured cost, if it is still the stored one', async () => {
      const { service, User, rows, log } = build([cost4]);

      await service.login({ email: 'ada@example.com', password: PASSWORD }, log);

      await vi.waitFor(() => expect(User.updateOne).toHaveBeenCalledTimes(1));
      const [filter, update] = User.updateOne.mock.calls[0]!;
      expect(filter).toEqual({ _id: '1', password: HASH }); // compare-and-swap on the hash the login compared
      expect(update.password).toMatch(COST_10_HASH);
      expect(bcrypt.compareSync(PASSWORD, update.password!)).toBe(true);
      expect(rows[0]!.password).toBe(update.password);
    });

    test('the answer never waits for it: a rehash that never finishes still lets the login answer', async () => {
      const { service, User, log } = build([cost4]);
      User.updateOne.mockImplementation(() => new Promise(() => undefined)); // the swap never completes

      await expect(
        service.login({ email: 'ada@example.com', password: PASSWORD }, log),
      ).resolves.toMatchObject({
        token: 'token-for-1',
      });
    });

    test('a password changed meanwhile is never overwritten', async () => {
      const { service, User, rows, log } = build([cost4]);
      const login = service.login({ email: 'ada@example.com', password: PASSWORD }, log);
      rows[0]!.password = bcrypt.hashSync('a-new-password-9', 4); // a password change lands before the rehash

      await login;
      await vi.waitFor(() => expect(User.updateOne).toHaveBeenCalledTimes(1));
      expect(bcrypt.compareSync('a-new-password-9', rows[0]!.password)).toBe(true);
    });

    test.each([
      ['a wrong password', { ...cost4 }, 'wrong-password'],
      ['an inactive account', { ...cost4, state: false }, PASSWORD],
    ])('%s is never rehashed', async (_case, stored, password) => {
      const { service, User, log } = build([stored]);
      const hash = vi.spyOn(bcrypt, 'hash');

      await rejectsWithInvalidCredentials(service.login({ email: 'ada@example.com', password }, log));

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(hash).not.toHaveBeenCalled();
      expect(User.updateOne).not.toHaveBeenCalled();
    });

    test('a hash already at the configured cost is left alone', async () => {
      const { service, User, log } = build([{ ...cost4, password: bcrypt.hashSync(PASSWORD, COST) }]);

      await service.login({ email: 'ada@example.com', password: PASSWORD }, log);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(User.updateOne).not.toHaveBeenCalled();
    });

    test('a failed rehash is logged at warn and the login still succeeds', async () => {
      const { service, User, log } = build([cost4]);
      User.updateOne.mockRejectedValueOnce(new Error('database unavailable'));

      await expect(
        service.login({ email: 'ada@example.com', password: PASSWORD }, log),
      ).resolves.toBeDefined();

      await vi.waitFor(() =>
        expect(log.warn).toHaveBeenCalledExactlyOnceWith(
          { err: expect.objectContaining({ message: 'database unavailable' }) },
          'password rehash failed; the next login retries',
        ),
      );
    });
  });

  describe('logoutAll (ADR-033, AM-M5-4)', () => {
    test("bumps the user's tokenVersion by one", async () => {
      const { service, User, rows } = build([
        { _id: '1', email: 'ada@example.com', password: HASH, state: true, tokenVersion: 2 },
      ]);

      await service.logoutAll('1');

      expect(User.updateOne).toHaveBeenCalledExactlyOnceWith({ _id: '1' }, { $inc: { tokenVersion: 1 } });
      expect(rows[0]!.tokenVersion).toBe(3);
    });
  });

  describe('changePassword (§2.1 #25, F1 extended)', () => {
    const account: Seed = {
      _id: '1',
      email: 'ada@example.com',
      password: HASH,
      state: true,
      tokenVersion: 2,
    };
    const change = { currentPassword: PASSWORD, newPassword: 'a-brand-new-password' };

    test('stores the new password at the configured cost, bumps tokenVersion, and signs a token at the new one', async () => {
      const { service, sign, rows } = build([account]);

      const result = await service.changePassword('1', change);

      expect(result).toEqual({ token: 'token-for-1' });
      expect(sign).toHaveBeenCalledExactlyOnceWith('1', 3);
      expect(rows[0]!.tokenVersion).toBe(3);
      expect(rows[0]!.password).toMatch(COST_10_HASH);
      expect(bcrypt.compareSync('a-brand-new-password', rows[0]!.password!)).toBe(true);
      expect(compare).toHaveBeenCalledExactlyOnceWith(PASSWORD, HASH);
    });

    // [case, stored account, current password sent, whether the stored hash is the one compared]
    test.each<[string, Seed, string, boolean]>([
      ['a wrong current password', account, 'not-the-password', true],
      [
        'an account with no password (Google-only)',
        { ...account, password: undefined, google: true },
        PASSWORD,
        false,
      ],
      ["an account with the old ':D' placeholder", { ...account, password: ':D', google: true }, ':D', false],
      ['an account deactivated meanwhile', { ...account, state: false }, PASSWORD, true],
    ])(
      '%s is the generic 401 after exactly one compare, and nothing changes',
      async (_case, stored, current, storedHash) => {
        const { service, sign, User, rows } = build([stored]);

        await rejectsWithInvalidCredentials(
          service.changePassword('1', { currentPassword: current, newPassword: 'a-brand-new-password' }),
        );

        expect(compare).toHaveBeenCalledTimes(1);
        if (storedHash) expect(compare.mock.calls[0]![1]).toBe(stored.password);
        else expect(compare.mock.calls[0]![1]).toMatch(COST_10_HASH); // the dummy
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(sign).not.toHaveBeenCalled();
        expect(rows[0]).toMatchObject({ password: stored.password, tokenVersion: 2 });
      },
    );

    test('an account gone between the check and the update is the generic 401', async () => {
      const { service, User, sign } = build([account]);
      User.findOneAndUpdate.mockResolvedValueOnce(null);

      await rejectsWithInvalidCredentials(service.changePassword('1', change));

      expect(sign).not.toHaveBeenCalled();
    });
  });
});
