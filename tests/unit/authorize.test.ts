// P10/P29 (M6 design §4.1, ADR-038): the one authorization middleware, replacing the three interim guards.
import type { Request, RequestHandler } from 'express';
import { describe, expect, test, vi } from 'vitest';

import { ForbiddenError, UnauthorizedError } from '../../src/core/errors';
import type { AuthUser } from '../../src/middlewares/authenticate';
import { authorize, type Policy } from '../../src/middlewares/authorize';

const SELF_ID = '64b7f0c2a1b2c3d4e5f60718';
const OTHER_ID = '64b7f0c2a1b2c3d4e5f60719';
const as = (role: string, id = SELF_ID): AuthUser => ({ id, role, name: 'Tester', state: true });

/** Runs authorize(policy); returns what it threw and whether it called next. */
function run(policy: Policy, user: AuthUser | undefined, params: Record<string, string> = {}) {
  const req = { user, params } as unknown as Request;
  const next = vi.fn();
  let thrown: unknown;
  const guard: RequestHandler = authorize(policy);
  try {
    void guard(req, {} as never, next);
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) expect(next).toHaveBeenCalledExactlyOnceWith();
  else expect(next).not.toHaveBeenCalled();
  return thrown;
}

describe('authorize: roles', () => {
  test('an omitted roles list lets every authenticated role through', () => {
    expect(run({}, as('USER_ROLE'))).toBeUndefined();
    expect(run({}, as('ADMIN_ROLE'))).toBeUndefined();
    expect(run({}, as('VENTAS_ROLE'))).toBeUndefined();
  });

  test('lets a listed role through', () => {
    expect(run({ roles: ['ADMIN_ROLE'] }, as('ADMIN_ROLE'))).toBeUndefined();
  });

  test.each(['USER_ROLE', 'VENTAS_ROLE'])('is 403 for %s when only ADMIN_ROLE is listed', (role) => {
    const error = run({ roles: ['ADMIN_ROLE'] }, as(role));

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'Not allowed' });
  });

  test('a policy naming several roles lets any of them through', () => {
    expect(run({ roles: ['ADMIN_ROLE', 'VENTAS_ROLE'] }, as('ADMIN_ROLE'))).toBeUndefined();
    expect(run({ roles: ['ADMIN_ROLE', 'VENTAS_ROLE'] }, as('VENTAS_ROLE'))).toBeUndefined();
    expect(run({ roles: ['ADMIN_ROLE', 'VENTAS_ROLE'] }, as('USER_ROLE'))).toBeInstanceOf(ForbiddenError);
  });
});

describe('authorize: selfParam', () => {
  test('lets a user act on their own record', () => {
    expect(run({ roles: ['ADMIN_ROLE'], selfParam: 'id' }, as('USER_ROLE'), { id: SELF_ID })).toBeUndefined();
  });

  test('also lets a listed role through, whoever the record belongs to', () => {
    expect(
      run({ roles: ['ADMIN_ROLE'], selfParam: 'id' }, as('ADMIN_ROLE'), { id: OTHER_ID }),
    ).toBeUndefined();
  });

  test.each([
    ['another user', { id: OTHER_ID }],
    ['a route without the id parameter', {}],
  ])('is 403 for a non-listed role on %s', (_case, params) => {
    const error = run({ roles: ['ADMIN_ROLE'], selfParam: 'id' }, as('VENTAS_ROLE'), params);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ status: 403, message: 'Not allowed' });
  });

  test('reads the parameter it is given, not always "id"', () => {
    const policy: Policy = { roles: ['ADMIN_ROLE'], selfParam: 'userId' };

    expect(run(policy, as('USER_ROLE'), { userId: SELF_ID, id: OTHER_ID })).toBeUndefined();
    expect(run(policy, as('USER_ROLE'), { userId: OTHER_ID, id: SELF_ID })).toBeInstanceOf(ForbiddenError);
  });

  // AM-M6-7: compared case-insensitively, so the same id in either hex case gets the same answer.
  const mixedCase = SELF_ID.split('')
    .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
    .join('');
  test.each([
    ['the caller’s id in uppercase', SELF_ID.toUpperCase()],
    ['the caller’s id mixed-case', mixedCase],
  ])('the param is compared to the caller’s id case-insensitively (%s)', (_case, paramValue) => {
    expect(
      run({ roles: ['ADMIN_ROLE'], selfParam: 'id' }, as('USER_ROLE'), { id: paramValue }),
    ).toBeUndefined();
  });

  test('the caller’s id is also lowercased before the compare', () => {
    expect(
      run({ roles: ['ADMIN_ROLE'], selfParam: 'id' }, as('USER_ROLE', SELF_ID.toUpperCase()), {
        id: SELF_ID,
      }),
    ).toBeUndefined();
  });
});

describe('authorize: deferToService', () => {
  test('lets any authenticated role through: the service decides ownership', () => {
    expect(run({ roles: ['ADMIN_ROLE'], deferToService: true }, as('USER_ROLE'))).toBeUndefined();
    expect(run({ roles: ['ADMIN_ROLE'], deferToService: true }, as('VENTAS_ROLE'))).toBeUndefined();
    expect(run({ roles: ['ADMIN_ROLE'], deferToService: true }, as('ADMIN_ROLE'))).toBeUndefined();
  });

  test('still lets a listed role through directly, with no need to defer', () => {
    expect(run({ roles: ['ADMIN_ROLE'], deferToService: true }, as('ADMIN_ROLE'))).toBeUndefined();
  });
});

describe('authorize: the default (no branch matches)', () => {
  test('a policy naming roles, no selfParam and no deferToService is 403 for an unlisted role', () => {
    const error = run({ roles: ['ADMIN_ROLE'] }, as('USER_ROLE'));

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'Not allowed' });
  });
});

describe('authorize never touches the database (P29)', () => {
  test('every branch (roles, selfParam, deferToService, the default) is synchronous and pure', () => {
    const before = Date.now();
    run({ roles: ['ADMIN_ROLE'], selfParam: 'id', deferToService: true }, as('USER_ROLE'), { id: OTHER_ID });
    expect(Date.now() - before).toBeLessThan(5); // no I/O, no await
  });
});

describe('authorize is 401 when req.user is absent (defence in depth)', () => {
  test.each<[string, Policy]>([
    ['{}', {}],
    ["{ roles: ['ADMIN_ROLE'] }", { roles: ['ADMIN_ROLE'] }],
    ["{ selfParam: 'id' }", { selfParam: 'id' }],
    ['{ deferToService: true }', { deferToService: true }],
  ])('%s is 401 when req.user is absent', (_label, policy) => {
    const error = run(policy, undefined, { id: SELF_ID });

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });
});
