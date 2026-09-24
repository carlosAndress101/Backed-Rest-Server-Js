// The products rules (M3 design §5.3) against in-memory models: no database, no vi.mock (ADR-023).
import type { Model } from 'mongoose';
import { describe, expect, test } from 'vitest';

import { ConflictError, NotFoundError } from '../../../src/core/errors';
import type { Product } from '../../../src/modules/products';
import { createProductsService, type CategoryLookup } from '../../../src/modules/products/product.service';

interface Row {
  _id: string;
  name?: string;
  state: boolean;
  user?: string;
  category?: string;
  price?: number;
  [key: string]: unknown;
}

const EDITOR = 'editor-id';
const CATEGORY = 'category-id';

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

/** A hand-written model holding `rows`, with only the methods the services call. */
function fakeModel(seed: Row[]) {
  const rows: Row[] = seed.map((row) => ({ ...row }));
  const matching = (filter: Record<string, unknown>, strength?: number) =>
    rows.filter((row) => Object.entries(filter).every(([key, value]) => same(row[key], value, strength)));
  const fake = {
    find: (filter: Record<string, unknown>) => new FakeQuery(() => matching(filter)),
    findOne: (filter: Record<string, unknown>) => new FakeQuery(() => matching(filter)[0] ?? null),
    countDocuments: (filter: Record<string, unknown>) => Promise.resolve(matching(filter).length),
    exists: (filter: Record<string, unknown>) =>
      new FakeQuery((strength) => {
        const row = matching(filter, strength)[0];
        return row ? { _id: row._id } : null;
      }),
    create: (doc: Record<string, unknown>) => {
      const row: Row = { _id: `id-${rows.length + 1}`, state: true, ...doc };
      rows.push(row);
      return Promise.resolve(row);
    },
    findOneAndUpdate: (filter: Record<string, unknown>, update: Record<string, unknown>) =>
      new FakeQuery(() => {
        const row = matching(filter)[0];
        return row ? Object.assign(row, update) : null;
      }),
  };
  return { rows, model: fake };
}

/** The service under test with a fake Product and a fake Category holding one active category. */
function makeService(products: Row[] = [], categories: Row[] = [{ _id: CATEGORY, state: true }]) {
  const { rows: productRows, model: Product } = fakeModel(products);
  const { model: Category } = fakeModel(categories);
  return {
    productRows,
    service: createProductsService({
      Product: Product as unknown as Model<Product>,
      Category: Category as unknown as CategoryLookup, // its exists() is a query-like thenable
    }),
  };
}

describe('createProductsService', () => {
  describe('list', () => {
    test('returns one page of the active products and the active total', async () => {
      const { service } = makeService([
        { _id: '1', name: 'A', state: true, category: CATEGORY },
        { _id: '2', name: 'B', state: false, category: CATEGORY },
        { _id: '3', name: 'C', state: true, category: CATEGORY },
        { _id: '4', name: 'D', state: true, category: CATEGORY },
      ]);

      const page = await service.list({ limit: 2, offset: 1 });

      expect(page.total).toBe(3);
      expect(page.items.map((item) => item.name)).toEqual(['C', 'D']);
    });
  });

  describe('getActive', () => {
    const { service } = makeService([
      { _id: 'active', name: 'KEYBOARD', state: true, category: CATEGORY },
      { _id: 'deleted', name: 'MOUSE', state: false, category: CATEGORY },
    ]);

    test('returns an active product', async () => {
      await expect(service.getActive('active')).resolves.toMatchObject({ name: 'KEYBOARD' });
    });

    test.each(['missing', 'deleted'])('a %s product is a NotFoundError', async (id) => {
      await expect(service.getActive(id)).rejects.toEqual(new NotFoundError('Product not found'));
    });
  });

  describe('create', () => {
    test('uppercases the name, records the caller and stores the category', async () => {
      const { service, productRows } = makeService();

      const created = await service.create({ name: 'Keyboard', category: CATEGORY }, EDITOR);

      expect(created).toMatchObject({ name: 'KEYBOARD', user: EDITOR, category: CATEGORY, state: true });
      expect(productRows).toHaveLength(1);
    });

    test('a name an active product has, in any case, is a ConflictError and nothing is created', async () => {
      const { service, productRows } = makeService([
        { _id: '1', name: 'KEYBOARD', state: true, category: CATEGORY },
      ]);

      await expect(service.create({ name: 'keyboard', category: CATEGORY }, EDITOR)).rejects.toEqual(
        new ConflictError('Product already exists'),
      );
      expect(productRows).toHaveLength(1);
    });

    // §10.3: the pre-check compares as the name_active_unique index does, so even a row stored in another case
    // (written before M4 normalized names) is the same name, and gets the specific message.
    test('the duplicate pre-check uses the index collation: a row stored in another case is the same name', async () => {
      const { service, productRows } = makeService([
        { _id: '1', name: 'Keyboard', state: true, category: CATEGORY },
      ]);

      await expect(service.create({ name: 'KEYBOARD', category: CATEGORY }, EDITOR)).rejects.toEqual(
        new ConflictError('Product already exists'),
      );
      expect(productRows).toHaveLength(1);
    });

    test.each([
      ['missing', []],
      ['soft-deleted', [{ _id: CATEGORY, state: false }]],
    ])('a %s category is a NotFoundError and nothing is created', async (_case, categories) => {
      const { service, productRows } = makeService([], categories);

      await expect(service.create({ name: 'Keyboard', category: CATEGORY }, EDITOR)).rejects.toEqual(
        new NotFoundError('Category not found'),
      );
      expect(productRows).toHaveLength(0);
    });
  });

  describe('update', () => {
    test('renames with the name uppercased and records the editor', async () => {
      const { service, productRows } = makeService([
        { _id: '1', name: 'KEYBOARD', state: true, category: CATEGORY },
      ]);

      const updated = await service.update('1', { name: 'mouse' }, EDITOR);

      expect(updated).toMatchObject({ name: 'MOUSE', user: EDITOR });
      expect(productRows[0]).toMatchObject({ name: 'MOUSE', user: EDITOR, state: true });
    });

    test.each([
      ['missing', 'missing'],
      ['soft-deleted', '2'],
    ])('a %s product is a NotFoundError and nothing is written', async (_case, id) => {
      const { service, productRows } = makeService([
        { _id: '2', name: 'MOUSE', state: false, category: CATEGORY },
      ]);

      await expect(service.update(id, { name: 'x' }, EDITOR)).rejects.toEqual(
        new NotFoundError('Product not found'),
      );
      expect(productRows).toEqual([{ _id: '2', name: 'MOUSE', state: false, category: CATEGORY }]);
    });

    test('a category that is not active is a NotFoundError and nothing is written', async () => {
      const { service, productRows } = makeService(
        [{ _id: '1', name: 'KEYBOARD', state: true, category: CATEGORY }],
        [{ _id: CATEGORY, state: false }],
      );

      await expect(service.update('1', { category: CATEGORY }, EDITOR)).rejects.toEqual(
        new NotFoundError('Category not found'),
      );
      expect(productRows).toEqual([{ _id: '1', name: 'KEYBOARD', state: true, category: CATEGORY }]);
    });
  });

  describe('softDelete', () => {
    test('sets state to false and keeps the record', async () => {
      const { service, productRows } = makeService([
        { _id: '1', name: 'KEYBOARD', state: true, category: CATEGORY },
      ]);

      await service.softDelete('1');

      expect(productRows).toEqual([{ _id: '1', name: 'KEYBOARD', state: false, category: CATEGORY }]);
    });

    test.each([
      ['missing', 'missing'],
      ['already deleted', '2'],
    ])('a %s product is a NotFoundError', async (_case, id) => {
      const { service } = makeService([{ _id: '2', name: 'MOUSE', state: false, category: CATEGORY }]);

      await expect(service.softDelete(id)).rejects.toEqual(new NotFoundError('Product not found'));
    });
  });
});
