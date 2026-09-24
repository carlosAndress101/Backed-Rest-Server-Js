// P10 (M3 design §3.2, ADR-028): x-token authentication with the legacy validarJWT semantics (C4).
import type { Request } from 'express';
import mongoose from 'mongoose';
import { describe, expect, test, vi } from 'vitest';

import { UnauthorizedError } from '../../src/core/errors';
import { createTokenService } from '../../src/core/security/jwt';
import { authenticate, type UserLookup } from '../../src/middlewares/authenticate';

const tokens = createTokenService('unit-test-secret');
const ACTIVE_ID = new mongoose.Types.ObjectId();
const INACTIVE_ID = new mongoose.Types.ObjectId();

/** A hand-written user store (ADR-023: no vi.mock). Records every lookup. */
function fakeUsers() {
  const rows = new Map<string, { _id: unknown; name: string; role: string; state: boolean }>([
    [ACTIVE_ID.toHexString(), { _id: ACTIVE_ID, name: 'Ada', role: 'USER_ROLE', state: true }],
    [INACTIVE_ID.toHexString(), { _id: INACTIVE_ID, name: 'Bob', role: 'ADMIN_ROLE', state: false }],
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

/** A request with the given x-token header (if any), a debug logger and nothing else. */
function fakeRequest(token?: string) {
  const debug = vi.fn();
  const req = {
    header: (name: string) => (name.toLowerCase() === 'x-token' ? token : undefined),
    log: { debug },
  } as unknown as Request;
  return { req, debug };
}

async function run(token: string | undefined, users: UserLookup = fakeUsers().users) {
  const { req, debug } = fakeRequest(token);
  const next = vi.fn();
  const outcome = await Promise.resolve(authenticate({ tokens, users })(req, {} as never, next)).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { error: outcome, req, next, debug };
}

describe('authenticate', () => {
  test('a valid token of an active user sets req.user and calls next', async () => {
    const { users, lookups } = fakeUsers();

    const { error, req, next } = await run(await tokens.sign(ACTIVE_ID.toHexString()), users);

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(lookups).toEqual([ACTIVE_ID.toHexString()]);
    expect(req.user).toEqual({ id: ACTIVE_ID.toHexString(), role: 'USER_ROLE', name: 'Ada', state: true });
  });

  test('req.user carries only id, role, name and state, whatever the lookup returns', async () => {
    const users: UserLookup = {
      findById: () =>
        Promise.resolve({ _id: ACTIVE_ID, name: 'Ada', role: 'USER_ROLE', state: true, password: 'hash' }),
    };

    const { req } = await run(await tokens.sign(ACTIVE_ID.toHexString()), users);

    expect(Object.keys(req.user!).sort()).toEqual(['id', 'name', 'role', 'state']);
    expect(typeof req.user!.id).toBe('string');
  });

  test.each([
    ['no x-token header', undefined],
    ['an empty x-token header', ''],
  ])('%s is 401 "No token in the request" and no user is looked up', async (_case, token) => {
    const { users, lookups } = fakeUsers();

    const { error, next } = await run(token, users);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'No token in the request' });
    expect(next).not.toHaveBeenCalled();
    expect(lookups).toEqual([]);
  });

  test.each([
    ['malformed', () => Promise.resolve('not-a-jwt'), 'jwt malformed'],
    [
      'signed with another secret',
      () => createTokenService('another').sign(ACTIVE_ID.toHexString()),
      'invalid signature',
    ],
  ])('a %s token is 401 "Invalid token", logged at debug with its cause', async (_case, token, cause) => {
    const { users, lookups } = fakeUsers();

    const { error, next, debug } = await run(await token(), users);

    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'Invalid token' });
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
    const { error, req, next } = await run(await tokens.sign(id.toHexString()));

    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'Invalid token' });
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  test('a failing lookup is not turned into a 401: the error propagates to the error handler', async () => {
    const outage = new Error('database unavailable');
    const users: UserLookup = { findById: () => Promise.reject(outage) };

    const { error, next } = await run(await tokens.sign(ACTIVE_ID.toHexString()), users);

    expect(error).toBe(outage);
    expect(next).not.toHaveBeenCalled();
  });
});
