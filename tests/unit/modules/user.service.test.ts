// The users rules (M3 design §5.1) against an in-memory model: no database, no vi.mock (ADR-023).
import bcrypt from 'bcrypt';
import type { Model } from 'mongoose';
import { describe, expect, test } from 'vitest';

import { ConflictError, NotFoundError, ValidationError } from '../../../src/core/errors';
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
  image?: string;
}

const ADMIN = { role: 'ADMIN_ROLE' };
const SELF = { role: 'USER_ROLE' };
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
  ...fields,
});

/** A hand-written User model holding `rows`, with only the methods the service calls. */
function fakeUserModel(seed: Row[] = []) {
  const rows = seed.map((stored) => ({ ...stored }));
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
    findOneAndUpdate: (filter: Partial<Row>, update: Partial<Row>) =>
      new FakeQuery(() => {
        const found = matching(filter)[0];
        return found ? Object.assign(found, update) : null;
      }),
  };
  return { rows, User: fake as unknown as Model<User> };
}

describe('createUsersService', () => {
  describe('list', () => {
    test('returns one page of the active users and the active total', async () => {
      const { User } = fakeUserModel([
        row({ _id: '1' }),
        row({ _id: '2', state: false }),
        row({ _id: '3' }),
        row({ _id: '4' }),
      ]);

      const page = await createUsersService({ User }).list({ limit: 2, offset: 1 });

      expect(page.total).toBe(3);
      expect(page.items.map((item) => item._id)).toEqual(['3', '4']);
    });
  });

  describe('create', () => {
    test('stores a bcrypt hash of the password, never the password', async () => {
      const { User, rows } = fakeUserModel();

      await createUsersService({ User }).create({
        name: 'Grace',
        email: 'grace@example.com',
        password: PASSWORD,
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.password).not.toBe(PASSWORD);
      expect(await bcrypt.compare(PASSWORD, rows[0]!.password)).toBe(true);
    });

    test('is always USER_ROLE, even if a role slips past the DTO (SEC-02)', async () => {
      const { User, rows } = fakeUserModel();
      const dto = {
        name: 'M',
        email: 'm@example.com',
        password: PASSWORD,
        role: 'ADMIN_ROLE',
      } as CreateUserDto;

      await createUsersService({ User }).create(dto);

      expect(rows[0]).toMatchObject({ role: 'USER_ROLE' });
    });

    test('an email any account has, active or not, is a ConflictError and nothing is created', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', email: 'taken@example.com', state: false })]);

      await expect(
        createUsersService({ User }).create({ name: 'C', email: 'taken@example.com', password: PASSWORD }),
      ).rejects.toEqual(new ConflictError('Email already registered'));
      expect(rows).toHaveLength(1);
    });
  });

  describe('update', () => {
    test('anyone may change name and password; the password is stored hashed', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', name: 'Ada' })]);

      await createUsersService({ User }).update('1', { name: 'Ada L', password: PASSWORD }, SELF);

      expect(rows[0]!.name).toBe('Ada L');
      expect(await bcrypt.compare(PASSWORD, rows[0]!.password)).toBe(true);
    });

    test('role and state from a non-admin are dropped, even an unknown role (C6)', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1' })]);

      await createUsersService({ User }).update('1', { role: 'NOT_A_ROLE', state: false }, SELF);

      expect(rows[0]).toMatchObject({ role: 'USER_ROLE', state: true });
    });

    test('an administrator sets role and state', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1' })]);

      await createUsersService({ User }).update('1', { role: 'VENTAS_ROLE', state: false }, ADMIN);

      expect(rows[0]).toMatchObject({ role: 'VENTAS_ROLE', state: false });
    });

    test('an administrator setting a role outside ROLES is a ValidationError and nothing is written (ADR-007)', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', name: 'Ada' })]);

      await expect(
        createUsersService({ User }).update('1', { role: 'SUPER_ROLE', name: 'Changed' }, ADMIN),
      ).rejects.toEqual(
        new ValidationError([{ path: 'role', message: 'must be one of ADMIN_ROLE, USER_ROLE, VENTAS_ROLE' }]),
      );
      expect(rows[0]).toMatchObject({ name: 'Ada', role: 'USER_ROLE' });
    });

    test('email, google, image and _id are never written, whoever asks (C6)', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', email: 'a@example.com', image: 'a.png' })]);
      const dto = { email: 'x@evil.example', google: true, image: 'x.png', _id: '2' } as UpdateUserDto;

      await createUsersService({ User }).update('1', dto, ADMIN);

      expect(rows[0]).toEqual(row({ _id: '1', email: 'a@example.com', image: 'a.png' }));
    });

    test('an administrator reaches a soft-deleted user, so state can be turned back on', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1', state: false })]);

      await createUsersService({ User }).update('1', { state: true }, ADMIN);

      expect(rows[0]!.state).toBe(true);
    });

    test.each([
      ['a missing user, for an administrator', 'missing', ADMIN],
      ['a soft-deleted user, for anyone else', '2', SELF],
    ])('%s is a NotFoundError', async (_case, id, actor) => {
      const { User } = fakeUserModel([row({ _id: '2', state: false })]);

      await expect(createUsersService({ User }).update(id, { name: 'X' }, actor)).rejects.toEqual(
        new NotFoundError('User not found'),
      );
    });
  });

  describe('softDelete', () => {
    test('sets state to false and keeps the record', async () => {
      const { User, rows } = fakeUserModel([row({ _id: '1' })]);

      await createUsersService({ User }).softDelete('1');

      expect(rows).toEqual([row({ _id: '1', state: false })]);
    });

    test.each([
      ['missing', 'missing'],
      ['already deleted', '2'],
    ])('a %s user is a NotFoundError', async (_case, id) => {
      const { User } = fakeUserModel([row({ _id: '2', state: false })]);

      await expect(createUsersService({ User }).softDelete(id)).rejects.toEqual(
        new NotFoundError('User not found'),
      );
    });
  });
});
