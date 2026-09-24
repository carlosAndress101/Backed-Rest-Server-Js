// The categories rules (M3 design §4.3, §4.7) against an in-memory model: no database, no vi.mock (ADR-023).
import type { Model } from 'mongoose';
import { describe, expect, test } from 'vitest';

import { ConflictError, NotFoundError } from '../../../src/core/errors';
import type { Category } from '../../../src/modules/categories';
import { createCategoriesService } from '../../../src/modules/categories/category.service';

interface Row {
  _id: string;
  name: string;
  state: boolean;
  user: string;
}

const OWNER = 'owner-id';
const EDITOR = 'editor-id';

/** A query stand-in: chainable like a Mongoose query, and resolves when awaited (applying skip/limit to lists). */
class FakeQuery<T> implements PromiseLike<T> {
  private offset = 0;
  private max = Infinity;
  private strength: number | undefined;

  constructor(private readonly run: (strength?: number) => T) {}

  /** Like the index's collation: at strength 2 or less, strings compare case-insensitively. */
  collation(collation: { locale: string; strength?: number }): this {
    this.strength = collation.strength;
    return this;
  }

  skip(offset: number): this {
    this.offset = offset;
    return this;
  }

  limit(max: number): this {
    this.max = max;
    return this;
  }

  populate(): this {
    return this;
  }

  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return Promise.resolve()
      .then(() => {
        const result = this.run(this.strength);
        return (Array.isArray(result) ? result.slice(this.offset, this.offset + this.max) : result) as T;
      })
      .then(onFulfilled, onRejected);
  }
}

/** Equality as MongoDB applies it, under a collation of `strength` (only 'en' strength ≤ 2 is needed here). */
const same = (stored: unknown, wanted: unknown, strength?: number) =>
  strength !== undefined && strength <= 2 && typeof stored === 'string' && typeof wanted === 'string'
    ? stored.localeCompare(wanted, 'en', { sensitivity: 'accent' }) === 0
    : stored === wanted;

/** A hand-written Category model holding `rows`, with only the methods the service calls. */
function fakeCategoryModel(seed: Omit<Row, 'user'>[] = []) {
  const rows: Row[] = seed.map((row) => ({ ...row, user: OWNER }));
  const matching = (filter: Partial<Row>, strength?: number) =>
    rows.filter((row) =>
      Object.entries(filter).every(([key, value]) => same(row[key as keyof Row], value, strength)),
    );
  const fake = {
    find: (filter: Partial<Row>) => new FakeQuery(() => matching(filter)),
    findOne: (filter: Partial<Row>) => new FakeQuery(() => matching(filter)[0] ?? null),
    countDocuments: (filter: Partial<Row>) => Promise.resolve(matching(filter).length),
    exists: (filter: Partial<Row>) =>
      new FakeQuery((strength) => {
        const row = matching(filter, strength)[0];
        return row ? { _id: row._id } : null;
      }),
    create: (doc: Pick<Row, 'name' | 'user'>) => {
      const row = { _id: `id-${rows.length + 1}`, state: true, ...doc };
      rows.push(row);
      return Promise.resolve(row);
    },
    findOneAndUpdate: (filter: Partial<Row>, update: Partial<Row>) =>
      new FakeQuery(() => {
        const row = matching(filter)[0];
        return row ? Object.assign(row, update) : null;
      }),
  };
  return { rows, Category: fake as unknown as Model<Category> };
}

describe('createCategoriesService', () => {
  describe('list', () => {
    test('returns one page of the active categories and the active total', async () => {
      const { Category } = fakeCategoryModel([
        { _id: '1', name: 'A', state: true },
        { _id: '2', name: 'B', state: false },
        { _id: '3', name: 'C', state: true },
        { _id: '4', name: 'D', state: true },
      ]);

      const page = await createCategoriesService({ Category }).list({ limit: 2, offset: 1 });

      expect(page.total).toBe(3);
      expect(page.items.map((item) => item.name)).toEqual(['C', 'D']);
    });
  });

  describe('getActive', () => {
    const { Category } = fakeCategoryModel([
      { _id: 'active', name: 'COFFEE', state: true },
      { _id: 'deleted', name: 'TEA', state: false },
    ]);
    const service = createCategoriesService({ Category });

    test('returns an active category', async () => {
      await expect(service.getActive('active')).resolves.toMatchObject({ name: 'COFFEE' });
    });

    test.each(['missing', 'deleted'])('a %s category is a NotFoundError', async (id) => {
      await expect(service.getActive(id)).rejects.toEqual(new NotFoundError('Category not found'));
    });
  });

  describe('create', () => {
    test('uppercases the name and records the caller as the owner', async () => {
      const { Category, rows } = fakeCategoryModel();

      const created = await createCategoriesService({ Category }).create({ name: 'Coffee' }, EDITOR);

      expect(created).toMatchObject({ name: 'COFFEE', user: EDITOR, state: true });
      expect(rows).toHaveLength(1);
    });

    test('a name an active category has, in any case, is a ConflictError and nothing is created', async () => {
      const { Category, rows } = fakeCategoryModel([{ _id: '1', name: 'COFFEE', state: true }]);

      await expect(createCategoriesService({ Category }).create({ name: 'coffee' }, EDITOR)).rejects.toEqual(
        new ConflictError('Category already exists'),
      );
      expect(rows).toHaveLength(1);
    });

    // §10.3: the pre-check compares as the name_active_unique index does, so even a row stored in another case
    // (written before M4 normalized names) is the same name, and gets the specific message.
    test('the duplicate pre-check uses the index collation: a row stored in another case is the same name', async () => {
      const { Category, rows } = fakeCategoryModel([{ _id: '1', name: 'Coffee', state: true }]);

      await expect(createCategoriesService({ Category }).create({ name: 'COFFEE' }, EDITOR)).rejects.toEqual(
        new ConflictError('Category already exists'),
      );
      expect(rows).toHaveLength(1);
    });

    test('a soft-deleted category does not hold its name', async () => {
      const { Category, rows } = fakeCategoryModel([{ _id: '1', name: 'COFFEE', state: false }]);

      await expect(
        createCategoriesService({ Category }).create({ name: 'Coffee' }, EDITOR),
      ).resolves.toMatchObject({
        name: 'COFFEE',
      });
      expect(rows).toHaveLength(2);
    });
  });

  describe('update', () => {
    test('renames with the name uppercased; no Actor is taken (AM-M6-2: a pure role policy at the route)', async () => {
      const { Category, rows } = fakeCategoryModel([{ _id: '1', name: 'COFFEE', state: true }]);

      const updated = await createCategoriesService({ Category }).update('1', { name: 'espresso' });

      expect(updated).toMatchObject({ name: 'ESPRESSO' });
      expect(rows[0]).toMatchObject({ name: 'ESPRESSO', state: true });
    });

    // ADR-041/AM-M6-2: the fix. Before M6, every editor (admin included) silently became the new owner.
    test('never reassigns the category to the editor: the creator stays the owner', async () => {
      const { Category, rows } = fakeCategoryModel([{ _id: '1', name: 'COFFEE', state: true }]);

      await createCategoriesService({ Category }).update('1', { name: 'espresso' });

      expect(rows[0]).toMatchObject({ user: OWNER });
    });

    test.each([
      ['missing', 'missing'],
      ['soft-deleted', '2'],
    ])('a %s category is a NotFoundError and nothing is written', async (_case, id) => {
      const { Category, rows } = fakeCategoryModel([{ _id: '2', name: 'TEA', state: false }]);

      await expect(createCategoriesService({ Category }).update(id, { name: 'x' })).rejects.toEqual(
        new NotFoundError('Category not found'),
      );
      expect(rows).toEqual([{ _id: '2', name: 'TEA', state: false, user: OWNER }]);
    });
  });

  describe('softDelete', () => {
    test('sets state to false and keeps the record', async () => {
      const { Category, rows } = fakeCategoryModel([{ _id: '1', name: 'COFFEE', state: true }]);

      await createCategoriesService({ Category }).softDelete('1');

      expect(rows).toEqual([{ _id: '1', name: 'COFFEE', state: false, user: OWNER }]);
    });

    test.each([
      ['missing', 'missing'],
      ['already deleted', '2'],
    ])('a %s category is a NotFoundError', async (_case, id) => {
      const { Category } = fakeCategoryModel([{ _id: '2', name: 'TEA', state: false }]);

      await expect(createCategoriesService({ Category }).softDelete(id)).rejects.toEqual(
        new NotFoundError('Category not found'),
      );
    });
  });
});
