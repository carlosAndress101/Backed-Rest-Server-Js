// M3 design §3.6 (ADR-007): the role enum lives in code.
import { describe, expect, test } from 'vitest';

import { DEFAULT_ROLE, ROLES, isRole } from '../../src/core/security/roles';

describe('roles', () => {
  test('the three roles the legacy code uses, and USER_ROLE by default', () => {
    expect(ROLES).toEqual(['ADMIN_ROLE', 'USER_ROLE', 'VENTAS_ROLE']);
    expect(DEFAULT_ROLE).toBe('USER_ROLE');
    expect(ROLES).toContain(DEFAULT_ROLE);
  });

  test.each(ROLES)('isRole accepts %s', (role) => {
    expect(isRole(role)).toBe(true);
  });

  test.each([
    'admin_role',
    'ADMIN',
    ' ADMIN_ROLE',
    '',
    'toString',
    '__proto__',
    undefined,
    null,
    42,
    ['ADMIN_ROLE'],
    { role: 'ADMIN_ROLE' },
  ])('isRole rejects %o', (value) => {
    expect(isRole(value)).toBe(false);
  });
});
