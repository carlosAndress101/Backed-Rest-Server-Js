// The users rules (M3 design §5.1) against an in-memory model: no database, no vi.mock (ADR-023).
import bcrypt from 'bcrypt';
import type { Model } from 'mongoose';
import { describe, expect, test } from 'vitest';

import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../src/core/errors';
import type { User } from '../../../src/modules/users';
import { createUsersService } from '../../../src/modules/users/user.service';
import type { CreateUserDto, UpdateUserDto } from '../../../src/modules/users/user.schemas';

interface Row {
  _id: string;
  name: string;
  email: string;
  password: string;
  role: string;
  state: boolean;
  google: boolean;
  tokenVersion: number;
  image?: string;
}

// Actors carry their own id (AM-M5-10): SELF acts on its own row '1'; ADMIN's own row is 'admin'.
const ADMIN = { id: 'admin', role: 'ADMIN_ROLE' };
const SELF = { id: '1', role: 'USER_ROLE' };
const OWN_PASSWORD = new ValidationError([
  { path: 'password', message: 'change your own password with PUT /api/auth/password' },
]);
const PASSWORD = 'correct-horse-battery';

/** A query stand-in: chainable like a Mongoose query, and resolves when awaited (applying skip/limit to lists). */
class FakeQuery<T> implements PromiseLike<T> {
  private offset = 0;
  private max = Infinity;

  constructor(private readonly run: () => T) {}

  skip(offset: number): this {
    this.offset = offset;
    return this;
  }

  limit(max: number): this {
    this.max = max;
    return this;
  }

  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return Promise.resolve()
      .then(() => {
        const result = this.run();
        return (Array.isArray(result) ? result.slice(this.offset, this.offset + this.max) : result) as T;
      })
      .then(onFulfilled, onRejected);
  }
}

/** A stored user with defaults for every field a test does not care about. */
const row = (fields: Partial<Row> & Pick<Row, '_id'>): Row => ({
  name: 'User',
  email: `${fields._id}@example.com`,
  password: 'stored-hash',
  role: 'USER_ROLE',
  state: true,
  google: false,
  tokenVersion: 0,
  ...fields,
});

/** A hand-written User model holding `rows`, with only the methods the service calls. */
function fakeUserModel(seed: Row[] = []) {
  const rows = seed.map((stored) => ({ ...stored }));
  const updates: unknown[] = [];
  const matching = (filter: Partial<Row>) =>
    rows.filter((stored) =>
      Object.entries(filter).every(([key, value]) => stored[key as keyof Row] === value),
    );
  const fake = {
    find: (filter: Partial<Row>) => new FakeQuery(() => matching(filter)),
    countDocuments: (filter: Partial<Row>) => Promise.resolve(matching(filter).length),
    exists: (filter: Partial<Row>) => {
      const found = matching(filter)[0];
      return Promise.resolve(found ? { _id: found._id } : null);
    },
    create: (doc: Omit<Row, '_id' | 'state' | 'google'>) => {
      const created = { _id: `id-${rows.length + 1}`, state: true, google: false, ...doc };
      rows.push(created);
      return Promise.resolve(created);
    },
    // A plain object is a $set, as Mongoose treats it; $set and $inc are applied as MongoDB would.
    findOneAndUpdate: (
      filter: Partial<Row>,
      update: Partial<Row> & { $set?: Partial<Row>; $inc?: Record<string, number> },
    ) =>
      new FakeQuery(() => {
        updates.push(update);
        const found = matching(filter)[0];
        if (!found) return null;
        const { $set, $inc, ...plain } = update;
        Object.assign(found, plain, $set);
        for (const [key, by] of Object.entries($inc ?? {}))
          Object.assign(found, { [key]: (found[key as keyof Row] as number) + by });
        return found;
      }),
  };
  return { rows, updates, User: fake as unknown as Model<User> };
}

const COST = 10; // config.auth.bcryptCost in these tests

describe('createUsersService', () => {
  describe('list', () => {
    test('returns one page of the active users and the active total', async () => {
      const { User } = fakeUserModel([
        row({ _id: '1' }),
        row({ _id: '2', state: false }),
        row({ _id: '3' }),
        row({ _id: '4' }),
      ]);

      const page = await createUsersService({ User, bcryptCost: COST }).list({ limit: 2, offset: 1 });

      expect(page.total).toBe(3);
      expect(page.items.map((item) => item._id)).toEqual(['3', '4']);
    });
  });

  describe('create', () => {
    test('stores a bcrypt hash of the password, never the password', async () => {
      const { User, rows } = fakeUserModel();

      await createUsersService({ User, bcryptCost: COST }).create({
        name: 'Grace',
        email: 'grace@example.com',
        password: PASSWORD,
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.password).not.toBe(PASSWORD);
      expect(await bcrypt.compare(PASSWORD, rows[0]!.password)).toBe(true);
    });

    // ADR-035: the cost comes from config.auth.bcryptCost, never a constant (PERF-01).
    test("hashes at the configured cost, on create and on an administrator's reset", async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', name: 'Ada' })]);
      const service = createUsersService({ User, bcryptCost: 11 });

      await service.create({ name: 'Grace', email: 'grace@example.com', password: PASSWORD });
      await service.update('1', { password: PASSWORD }, ADMIN);

      expect(rows.map((stored) => stored.password.slice(0, 7))).toEqual(['$2b$11$', '$2b$11$']);
    });

    test('is always USER_ROLE, even if a role slips past the DTO (SEC-02)', async () => {
      const { User, rows } = fakeUserModel();
      const dto = {
        name: 'M',
        email: 'm@example.com',
        password: PASSWORD,
        role: 'ADMIN_ROLE',
      } as CreateUserDto;

      await createUsersService({ User, bcryptCost: COST }).create(dto);

      expect(rows[0]).toMatchObject({ role: 'USER_ROLE' });
    });

    test('an email any account has, active or not, is a ConflictError and nothing is created', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', email: 'taken@example.com', state: false })]);

      await expect(
        createUsersService({ User, bcryptCost: COST }).create({
          name: 'C',
          email: 'taken@example.com',
          password: PASSWORD,
        }),
      ).rejects.toEqual(new ConflictError('Email already registered'));
      expect(rows).toHaveLength(1);
    });
  });

  describe('update', () => {
    test('anyone may change their own name; no tokenVersion is bumped', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', name: 'Ada' })]);

      await createUsersService({ User, bcryptCost: COST }).update('1', { name: 'Ada L' }, SELF);

      expect(rows[0]).toMatchObject({ name: 'Ada L', password: 'stored-hash', tokenVersion: 0 });
    });

    test.each([
      ['a user on their own account', '1', SELF],
      ['a sales user on their own account', '1', { id: '1', role: 'VENTAS_ROLE' }],
      ['an administrator on their own account', 'admin', ADMIN],
      ['an administrator on their own id spelled in uppercase', 'ADMIN', ADMIN],
      ['a non-administrator on another account (routes forbid it; the service refuses too)', 'admin', SELF],
    ])(
      'a password from %s is a ValidationError naming PUT /api/auth/password, and nothing is written (AM-M5-10)',
      async (_case, id, actor) => {
        const { User, rows, updates } = fakeUserModel([
          row({ _id: '1', name: 'Ada' }),
          row({ _id: 'admin', name: 'Boss', role: 'ADMIN_ROLE' }),
        ]);
        const before = structuredClone(rows);

        await expect(
          createUsersService({ User, bcryptCost: COST }).update(
            id,
            { name: 'Changed', password: PASSWORD },
            actor,
          ),
        ).rejects.toEqual(OWN_PASSWORD);
        expect(rows).toEqual(before);
        expect(updates).toEqual([]);
      },
    );

    test("an administrator resets another user's password: a hash at the configured cost and tokenVersion + 1, in one write", async () => {
      const { User, rows, updates } = fakeUserModel([row({ _id: '1', name: 'Ada', tokenVersion: 2 })]);

      await createUsersService({ User, bcryptCost: 11 }).update('1', { password: PASSWORD }, ADMIN);

      expect(rows[0]!.password.slice(0, 7)).toBe('$2b$11$');
      expect(await bcrypt.compare(PASSWORD, rows[0]!.password)).toBe(true);
      expect(rows[0]!.tokenVersion).toBe(3);
      expect(updates).toEqual([{ $set: { password: rows[0]!.password }, $inc: { tokenVersion: 1 } }]);
    });

    test("an administrator's update without a password bumps no tokenVersion", async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', name: 'Ada' })]);

      await createUsersService({ User, bcryptCost: COST }).update(
        '1',
        { name: 'Ada L', state: false },
        ADMIN,
      );

      expect(rows[0]).toMatchObject({ name: 'Ada L', state: false, tokenVersion: 0 });
    });

    test('role and state from a non-admin are dropped, even an unknown role (C6)', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1' })]);

      await createUsersService({ User, bcryptCost: COST }).update(
        '1',
        { role: 'NOT_A_ROLE', state: false },
        SELF,
      );

      expect(rows[0]).toMatchObject({ role: 'USER_ROLE', state: true });
    });

    test('an administrator sets role and state', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1' })]);

      await createUsersService({ User, bcryptCost: COST }).update(
        '1',
        { role: 'VENTAS_ROLE', state: false },
        ADMIN,
      );

      expect(rows[0]).toMatchObject({ role: 'VENTAS_ROLE', state: false });
    });

    test('an administrator setting a role outside ROLES is a ValidationError and nothing is written (ADR-007)', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', name: 'Ada' })]);

      await expect(
        createUsersService({ User, bcryptCost: COST }).update(
          '1',
          { role: 'SUPER_ROLE', name: 'Changed' },
          ADMIN,
        ),
      ).rejects.toEqual(
        new ValidationError([{ path: 'role', message: 'must be one of ADMIN_ROLE, USER_ROLE, VENTAS_ROLE' }]),
      );
      expect(rows[0]).toMatchObject({ name: 'Ada', role: 'USER_ROLE' });
    });

    test('email, google, image and _id are never written, whoever asks (C6)', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', email: 'a@example.com', image: 'a.png' })]);
      const dto = { email: 'x@evil.example', google: true, image: 'x.png', _id: '2' } as UpdateUserDto;

      await createUsersService({ User, bcryptCost: COST }).update('1', dto, ADMIN);

      expect(rows[0]).toEqual(row({ _id: '1', email: 'a@example.com', image: 'a.png' }));
    });

    // ADR-042, refined by AM-M6-3: an administrator may not use PUT to change their own role or active state.
    describe('an administrator changing their own role or state (ADR-042)', () => {
      const OWN_ROLE_STATE = new ForbiddenError(
        'Ask another administrator to change your own role or active state',
      );

      test.each([
        ['a different role', { role: 'VENTAS_ROLE' }],
        ['state: false', { state: false }],
        ['both a different role and state: false', { role: 'USER_ROLE', state: false }],
      ])('%s is a ForbiddenError, and nothing is written', async (_case, dto) => {
        const { User, rows } = fakeUserModel([row({ _id: 'admin', role: 'ADMIN_ROLE', state: true })]);
        const before = structuredClone(rows);

        await expect(
          createUsersService({ User, bcryptCost: COST }).update('admin', dto, ADMIN),
        ).rejects.toEqual(OWN_ROLE_STATE);
        expect(rows).toEqual(before);
      });

      test('the same target in uppercase is still self (AM-M6-7 parity)', async () => {
        const { User, rows } = fakeUserModel([row({ _id: 'admin', role: 'ADMIN_ROLE', state: true })]);
        const before = structuredClone(rows);

        await expect(
          createUsersService({ User, bcryptCost: COST }).update('ADMIN', { state: false }, ADMIN),
        ).rejects.toEqual(OWN_ROLE_STATE);
        expect(rows).toEqual(before);
      });

      test.each([
        ['an echo of their current role', { role: 'ADMIN_ROLE' }],
        ['state: true', { state: true }],
        ['an echo of both', { role: 'ADMIN_ROLE', state: true }],
        ['neither field, only a name change', { name: 'New Name' }],
      ])('%s is not a real change, so it passes', async (_case, dto) => {
        const { User, rows } = fakeUserModel([row({ _id: 'admin', role: 'ADMIN_ROLE', state: true })]);

        await createUsersService({ User, bcryptCost: COST }).update('admin', dto, ADMIN);

        expect(rows[0]).toMatchObject({ role: 'ADMIN_ROLE', state: true });
      });

      test("an administrator changing another admin's role or state (admin, but not self) is unaffected", async () => {
        const { User, rows } = fakeUserModel([
          row({ _id: 'admin', role: 'ADMIN_ROLE' }),
          row({ _id: 'other-admin', role: 'ADMIN_ROLE' }),
        ]);

        await createUsersService({ User, bcryptCost: COST }).update(
          'other-admin',
          { role: 'VENTAS_ROLE', state: false },
          ADMIN,
        );

        expect(rows[1]).toMatchObject({ role: 'VENTAS_ROLE', state: false });
      });

      test('a non-administrator changing their own role/state (self, but not admin) is silently dropped, not a ForbiddenError (C6)', async () => {
        const { User, rows } = fakeUserModel([row({ _id: '1', role: 'USER_ROLE', state: true })]);

        await createUsersService({ User, bcryptCost: COST }).update(
          '1',
          { role: 'ADMIN_ROLE', state: false },
          SELF,
        );

        expect(rows[0]).toMatchObject({ role: 'USER_ROLE', state: true });
      });
    });

    test('an administrator reaches a soft-deleted user, so state can be turned back on', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', state: false })]);

      await createUsersService({ User, bcryptCost: COST }).update('1', { state: true }, ADMIN);

      expect(rows[0]!.state).toBe(true);
    });

    test.each([
      ['a missing user, for an administrator', 'missing', ADMIN],
      ['a soft-deleted user, for anyone else', '2', SELF],
    ])('%s is a NotFoundError', async (_case, id, actor) => {
      const { User } = fakeUserModel([row({ _id: '2', state: false })]);

      await expect(
        createUsersService({ User, bcryptCost: COST }).update(id, { name: 'X' }, actor),
      ).rejects.toEqual(new NotFoundError('User not found'));
    });
  });

  describe('softDelete', () => {
    test('an administrator deletes another user: state to false, the record kept', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1' })]);

      await createUsersService({ User, bcryptCost: COST }).softDelete('1', ADMIN);

      expect(rows).toEqual([row({ _id: '1', state: false })]);
    });

    // ADR-042: nobody may target their own account with DELETE, whatever their role.
    test.each([
      ['an administrator', 'admin', ADMIN],
      ['a plain user', '1', SELF],
    ])(
      '%s targeting their own account is a ForbiddenError, and nothing is deleted',
      async (_case, id, actor) => {
        const { User, rows } = fakeUserModel([
          row({ _id: '1', name: 'Ada' }),
          row({ _id: 'admin', name: 'Boss', role: 'ADMIN_ROLE' }),
        ]);
        const before = structuredClone(rows);

        await expect(createUsersService({ User, bcryptCost: COST }).softDelete(id, actor)).rejects.toEqual(
          new ForbiddenError('You cannot delete your own account'),
        );
        expect(rows).toEqual(before);
      },
    );

    test('the self check is case-insensitive, like the id in the URL (AM-M6-7 parity)', async () => {
      const { User, rows } = fakeUserModel([row({ _id: 'admin', name: 'Boss', role: 'ADMIN_ROLE' })]);
      const before = structuredClone(rows);

      await expect(createUsersService({ User, bcryptCost: COST }).softDelete('ADMIN', ADMIN)).rejects.toEqual(
        new ForbiddenError('You cannot delete your own account'),
      );
      expect(rows).toEqual(before);
    });

    test.each([
      ['missing', 'missing'],
      ['already deleted', '2'],
    ])('a %s user is a NotFoundError', async (_case, id) => {
      const { User } = fakeUserModel([row({ _id: '2', state: false })]);

      await expect(createUsersService({ User, bcryptCost: COST }).softDelete(id, ADMIN)).rejects.toEqual(
        new NotFoundError('User not found'),
      );
    });
  });
});
