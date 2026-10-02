// P10 (M3 design §3.2, ADR-028) as M5 hardens it (M5 design §3.2, ADR-032/033, P22/P23): Bearer first, x-token
// only without an Authorization header (and deprecated), the C4 401 semantics, and the tokenVersion check.
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { describe, expect, test, vi } from 'vitest';

import { UnauthorizedError } from '../../src/core/errors';
import { createTokenService } from '../../src/core/security/jwt';
import { authenticate, type UserLookup } from '../../src/middlewares/authenticate';

const tokens = createTokenService('unit-test-secret-at-least-32-chars', { ttlSeconds: 3600 });
const ACTIVE_ID = new mongoose.Types.ObjectId();
const OTHER_ID = new mongoose.Types.ObjectId();
const INACTIVE_ID = new mongoose.Types.ObjectId();
const REVOKED_ID = new mongoose.Types.ObjectId(); // logged out everywhere once: tokenVersion 1

type Headers = Record<string, string | undefined>;

/** A hand-written user store (ADR-023: no vi.mock). Records every lookup. */
function fakeUsers() {
  const rows = new Map<
    string,
    { _id: unknown; name: string; role: string; state: boolean; tokenVersion: number }
  >([
    [
      ACTIVE_ID.toHexString(),
      { _id: ACTIVE_ID, name: 'Ada', role: 'USER_ROLE', state: true, tokenVersion: 0 },
    ],
    [
      OTHER_ID.toHexString(),
      { _id: OTHER_ID, name: 'Grace', role: 'ADMIN_ROLE', state: true, tokenVersion: 0 },
    ],
    [
      INACTIVE_ID.toHexString(),
      { _id: INACTIVE_ID, name: 'Bob', role: 'ADMIN_ROLE', state: false, tokenVersion: 0 },
    ],
    [
      REVOKED_ID.toHexString(),
      { _id: REVOKED_ID, name: 'Linus', role: 'USER_ROLE', state: true, tokenVersion: 1 },
    ],
  ]);
  const lookups: string[] = [];
  const users: UserLookup = {
    findById: (id) => {
      lookups.push(id);
      return Promise.resolve(rows.get(id) ?? null);
    },
  };
  return { users, lookups };
}

/** Runs authenticate over a request with exactly `headers` (names are case-insensitive, as in Express). */
async function run(headers: Headers, users: UserLookup = fakeUsers().users) {
  const debug = vi.fn();
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    log: { debug },
  } as unknown as Request;
  const responseHeaders: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
  } as unknown as Response;
  const next = vi.fn();
  const error = await Promise.resolve(authenticate({ tokens, users })(req, res, next)).then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  return { error, req, next, debug, responseHeaders };
}

const bearer = (token: string): Headers => ({ authorization: `Bearer ${token}` });
const sign = (id: mongoose.Types.ObjectId, tokenVersion = 0) => tokens.sign(id.toHexString(), tokenVersion);

const NO_TOKEN = { status: 401, code: 'UNAUTHORIZED', message: 'No token in the request' };
const INVALID = { status: 401, code: 'UNAUTHORIZED', message: 'Invalid token' };

describe('authenticate', () => {
  test('a valid Bearer token of an active user sets req.user and calls next, with no Deprecation header', async () => {
    const { users, lookups } = fakeUsers();

    const { error, req, next, responseHeaders } = await run(bearer(await sign(ACTIVE_ID)), users);

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(lookups).toEqual([ACTIVE_ID.toHexString()]);
    expect(req.user).toEqual({ id: ACTIVE_ID.toHexString(), role: 'USER_ROLE', name: 'Ada', state: true });
    expect(responseHeaders).toEqual({});
  });

  test('req.user carries only id, role, name and state (never tokenVersion), whatever the lookup returns', async () => {
    const users: UserLookup = {
      findById: () =>
        Promise.resolve({
          _id: ACTIVE_ID,
          name: 'Ada',
          role: 'USER_ROLE',
          state: true,
          tokenVersion: 0,
          password: 'hash',
        }),
    };

    const { req } = await run(bearer(await sign(ACTIVE_ID)), users);

    expect(Object.keys(req.user!).sort()).toEqual(['id', 'name', 'role', 'state']);
    expect(typeof req.user!.id).toBe('string');
  });

  test.each<[string, Headers]>([
    ['no header at all', {}],
    ['an empty x-token header', { 'x-token': '' }],
  ])('%s is 401 "No token in the request" and no user is looked up', async (_case, headers) => {
    const { users, lookups } = fakeUsers();

    const { error, next } = await run(headers, users);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toMatchObject(NO_TOKEN);
    expect(next).not.toHaveBeenCalled();
    expect(lookups).toEqual([]);
  });

  test.each([
    ['malformed', () => Promise.resolve('not-a-jwt'), 'jwt malformed'],
    [
      'signed with another secret',
      () =>
        createTokenService('another-secret-at-least-32-characters', { ttlSeconds: 60 }).sign(
          ACTIVE_ID.toHexString(),
        ),
      'invalid signature',
    ],
  ])('a %s token is 401 "Invalid token", logged at debug with its cause', async (_case, token, cause) => {
    const { users, lookups } = fakeUsers();

    const { error, next, debug } = await run({ authorization: `Bearer ${await token()}` }, users);

    expect(error).toMatchObject(INVALID);
    expect(next).not.toHaveBeenCalled();
    expect(lookups).toEqual([]);
    expect(debug).toHaveBeenCalledExactlyOnceWith(
      { err: expect.objectContaining({ message: cause }) },
      'token rejected',
    );
  });

  test.each([
    ['a user that no longer exists', new mongoose.Types.ObjectId()],
    ['an inactive user (state: false)', INACTIVE_ID],
  ])('a valid token of %s is 401 "Invalid token"', async (_case, id) => {
    const { error, req, next } = await run(bearer(await sign(id)));

    expect(error).toMatchObject(INVALID);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  test('a failing lookup is not turned into a 401: the error propagates to the error handler', async () => {
    const outage = new Error('database unavailable');
    const users: UserLookup = { findById: () => Promise.reject(outage) };

    const { error, next } = await run(bearer(await sign(ACTIVE_ID)), users);

    expect(error).toBe(outage);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('P22: the transport (ADR-032)', () => {
  test('x-token alone still authenticates until 4.0.0, and marks the response Deprecation: true', async () => {
    const { error, req, next, responseHeaders } = await run({ 'x-token': await sign(ACTIVE_ID) });

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.id).toBe(ACTIVE_ID.toHexString());
    expect(responseHeaders).toEqual({ Deprecation: 'true' });
  });

  test('an invalid x-token is 401 "Invalid token", and still marked deprecated', async () => {
    const { error, responseHeaders } = await run({ 'x-token': 'not-a-jwt' });

    expect(error).toMatchObject(INVALID);
    expect(responseHeaders).toEqual({ Deprecation: 'true' });
  });

  test('both headers: Bearer wins; the x-token is never read and nothing is marked deprecated', async () => {
    const { users, lookups } = fakeUsers();

    const { error, req, responseHeaders } = await run(
      { authorization: `Bearer ${await sign(ACTIVE_ID)}`, 'x-token': await sign(OTHER_ID) },
      users,
    );

    expect(error).toBeUndefined();
    expect(req.user?.id).toBe(ACTIVE_ID.toHexString());
    expect(lookups).toEqual([ACTIVE_ID.toHexString()]);
    expect(responseHeaders).toEqual({});
  });

  test('both headers, Bearer valid and x-token garbage: authenticated by the Bearer', async () => {
    const { error, next } = await run({
      authorization: `Bearer ${await sign(ACTIVE_ID)}`,
      'x-token': 'garbage',
    });

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  test.each(['bearer', 'BEARER', 'bEaReR'])(
    'the scheme is case-insensitive (RFC 7235, AM-M5-8): "%s <token>" authenticates, and x-token is still not read',
    async (scheme) => {
      const { users, lookups } = fakeUsers();

      const { error, req, responseHeaders } = await run(
        { authorization: `${scheme} ${await sign(ACTIVE_ID)}`, 'x-token': await sign(OTHER_ID) },
        users,
      );

      expect(error).toBeUndefined();
      expect(req.user?.id).toBe(ACTIVE_ID.toHexString());
      expect(lookups).toEqual([ACTIVE_ID.toHexString()]);
      expect(responseHeaders).toEqual({});
    },
  );

  test.each<[string, (token: string) => string]>([
    ['empty', () => ''],
    ['the scheme alone', () => 'Bearer'],
    ['the scheme and a space', () => 'Bearer '],
    ['two spaces after the scheme', (token) => `Bearer  ${token}`],
    ['two spaces after a lowercase scheme', (token) => `bearer  ${token}`],
    ['a tab instead of the space', (token) => `Bearer\t${token}`],
    ['a near-miss scheme (Bearerx)', (token) => `Bearerx ${token}`],
    ['another scheme (Basic)', (token) => `Basic ${token}`],
    ['the token with no scheme', (token) => token],
    ['trailing garbage after the token', (token) => `Bearer ${token} extra`],
    ['two Bearer tokens', (token) => `Bearer ${token}, Bearer ${token}`],
    ['a character outside a b64token', (token) => `Bearer ${token}!`],
  ])(
    'a malformed Authorization (%s) is 401 even beside a valid x-token: never a fallback, nothing looked up',
    async (_case, authorization) => {
      const { users, lookups } = fakeUsers();
      const valid = await sign(ACTIVE_ID);

      const { error, next, responseHeaders } = await run(
        { authorization: authorization(valid), 'x-token': valid },
        users,
      );

      expect(error).toMatchObject(NO_TOKEN);
      expect(next).not.toHaveBeenCalled();
      expect(lookups).toEqual([]);
      expect(responseHeaders).toEqual({});
    },
  );
});

describe('P23: tokenVersion (ADR-033)', () => {
  test("a token signed at the user's current tokenVersion authenticates", async () => {
    const { error, req } = await run(bearer(await sign(REVOKED_ID, 1)));

    expect(error).toBeUndefined();
    expect(req.user?.id).toBe(REVOKED_ID.toHexString());
  });

  test.each([
    ['an older version (replayed after logout-all or a password change)', 0],
    ['a newer version than the user has', 2],
  ])('a token of %s is the same 401 as any invalid token', async (_case, tokenVersion) => {
    const replay = await run(bearer(await sign(REVOKED_ID, tokenVersion)));
    const malformed = await run(bearer('not-a-jwt'));

    expect(replay.error).toBeInstanceOf(UnauthorizedError);
    expect(replay.error).toMatchObject(INVALID);
    expect(replay.error).toEqual(malformed.error);
    expect(replay.next).not.toHaveBeenCalled();
    expect(replay.req.user).toBeUndefined();
  });

  test('a lookup whose tokenVersion is missing fails closed (the schema default would give 0)', async () => {
    const users = {
      findById: () => Promise.resolve({ _id: ACTIVE_ID, name: 'Ada', role: 'USER_ROLE', state: true }),
    } as unknown as UserLookup;

    const { error } = await run(bearer(await sign(ACTIVE_ID)), users);

    expect(error).toMatchObject(INVALID);
  });
});
