// P10 (M3 design §3.3, ADR-028): the interim role and ownership guards.
import type { Request, RequestHandler } from 'express';
import { describe, expect, test, vi } from 'vitest';

import { ForbiddenError, UnauthorizedError } from '../../src/core/errors';
import type { AuthUser } from '../../src/middlewares/authenticate';
import { requireAdmin, requireRole, requireSelfOrAdmin } from '../../src/middlewares/authorize';

const SELF_ID = '64b7f0c2a1b2c3d4e5f60718';
const OTHER_ID = '64b7f0c2a1b2c3d4e5f60719';
const as = (role: string, id = SELF_ID): AuthUser => ({ id, role, name: 'Tester', state: true });

/** Runs a guard; returns what it threw and whether it called next. */
function run(guard: RequestHandler, user: AuthUser | undefined, params: Record<string, string> = {}) {
  const req = { user, params } as unknown as Request;
  const next = vi.fn();
  let thrown: unknown;
  try {
    void guard(req, {} as never, next);
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) expect(next).toHaveBeenCalledExactlyOnceWith();
  else expect(next).not.toHaveBeenCalled();
  return thrown;
}

describe('requireAdmin', () => {
  test('lets an administrator through', () => {
    expect(run(requireAdmin, as('ADMIN_ROLE'))).toBeUndefined();
  });

  test.each(['USER_ROLE', 'VENTAS_ROLE'])('is 403 for %s', (role) => {
    const error = run(requireAdmin, as(role));

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ status: 403, message: 'Administrator role required' });
  });
});

describe('requireSelfOrAdmin', () => {
  test('lets a user act on their own record', () => {
    expect(run(requireSelfOrAdmin(), as('USER_ROLE'), { id: SELF_ID })).toBeUndefined();
  });

  test('lets an administrator act on any record', () => {
    expect(run(requireSelfOrAdmin(), as('ADMIN_ROLE'), { id: OTHER_ID })).toBeUndefined();
  });

  test.each([
    ['another user', { id: OTHER_ID }],
    ['a route without the id parameter', {}],
  ])('is 403 for a non-administrator on %s', (_case, params) => {
    const error = run(requireSelfOrAdmin(), as('VENTAS_ROLE'), params);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ status: 403, message: 'Owner or administrator required' });
  });

  test('reads the parameter it is given', () => {
    expect(
      run(requireSelfOrAdmin('userId'), as('USER_ROLE'), { userId: SELF_ID, id: OTHER_ID }),
    ).toBeUndefined();
    expect(
      run(requireSelfOrAdmin('userId'), as('USER_ROLE'), { userId: OTHER_ID, id: SELF_ID }),
    ).toBeInstanceOf(ForbiddenError);
  });
});

describe('requireRole', () => {
  const adminOrSales = requireRole('ADMIN_ROLE', 'VENTAS_ROLE');

  test.each(['ADMIN_ROLE', 'VENTAS_ROLE'])('lets %s through', (role) => {
    expect(run(adminOrSales, as(role))).toBeUndefined();
  });

  test('is 403 for any other role, naming the accepted ones', () => {
    const error = run(adminOrSales, as('USER_ROLE'));

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({
      status: 403,
      message: 'One of these roles required: ADMIN_ROLE, VENTAS_ROLE',
    });
  });

  test('accepts only known roles', () => {
    // @ts-expect-error: a role outside ROLES does not compile
    expect(run(requireRole('SUPER_ROLE'), as('SUPER_ROLE'))).toBeUndefined();
  });
});

describe('every guard without authenticate in front', () => {
  test.each([
    ['requireAdmin', requireAdmin],
    ['requireSelfOrAdmin', requireSelfOrAdmin()],
    ['requireRole', requireRole('ADMIN_ROLE')],
  ])('%s is 401 when req.user is absent', (_name, guard) => {
    const error = run(guard, undefined, { id: SELF_ID });

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });
});
