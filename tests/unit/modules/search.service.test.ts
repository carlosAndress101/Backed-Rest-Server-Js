// The search rules (M3 design §5.4) against in-memory models: no database, no vi.mock (ADR-023).
import { describe, expect, test, vi } from 'vitest';

import { BadRequestError } from '../../../src/core/errors';
import { createSearchService } from '../../../src/modules/search/search.service';

type Row = Record<string, unknown>;

const ACTIVE_ID = '507f1f77bcf86cd799439011';

/** A model stand-in holding `rows`: `find` records the filters it was given, `findOne` records its calls. */
function fakeModel(rows: Row[] = []) {
  const filters: unknown[] = [];
  const limit = vi.fn((max: number) => Promise.resolve(rows.slice(0, max)));
  const find = vi.fn((filter: unknown) => {
    filters.push(filter);
    return { limit };
  });
  const populate = vi.fn(() => Promise.resolve<unknown>(null));
  const findOne = vi.fn((filter: Row) => {
    const doc =
      rows.find((row) => Object.entries(filter).every(([key, value]) => row[key] === value)) ?? null;
    return Object.assign(Promise.resolve<unknown>(doc), { populate });
  });
  return { find, findOne, limit, populate, filters };
}

/** The service under test with the three fake models. */
function makeService(rows: { user?: Row[]; category?: Row[]; product?: Row[] } = {}) {
  const User = fakeModel(rows.user);
  const Category = fakeModel(rows.category);
  const Product = fakeModel(rows.product);
  return { User, Category, Product, service: createSearchService({ User, Category, Product }) };
}

describe('createSearchService', () => {
  test('an unknown collection is a BadRequestError with the legacy message', async () => {
    const { service } = makeService();

    await expect(service.search('role', 'ADMIN_ROLE')).rejects.toEqual(
      new BadRequestError('The permitted collections are: user,category,product'),
    );
  });

  test('an id term looks up the active document by { _id, state: true }', async () => {
    const row = { _id: ACTIVE_ID, name: 'BY-ID', state: true };
    const { service, Category } = makeService({ category: [row] });

    await expect(service.search('category', ACTIVE_ID)).resolves.toEqual([row]);
    expect(Category.findOne).toHaveBeenCalledWith({ _id: ACTIVE_ID, state: true });
  });

  test('a missing or soft-deleted id returns []', async () => {
    const { service } = makeService({ user: [{ _id: 'other', state: false }] });

    await expect(service.search('user', ACTIVE_ID)).resolves.toEqual([]);
  });

  test('only the product id lookup populates its category', async () => {
    const row = { _id: ACTIVE_ID, name: 'X', state: true };
    const { service, Product, Category } = makeService({ product: [row], category: [row] });

    await service.search('product', ACTIVE_ID);
    await service.search('category', ACTIVE_ID);

    expect(Product.populate).toHaveBeenCalledWith('category', 'name');
    expect(Category.populate).not.toHaveBeenCalled();
  });

  test('a text term escapes regex metacharacters, filters state and limits to 20', async () => {
    const { service, Category } = makeService({ category: [{ _id: '1', name: '.* literal', state: true }] });

    await service.search('category', '.*');

    const filter = Category.filters[0] as { $or: { name: RegExp }[]; $and: unknown[] };
    const name = (filter.$or[0] as { name: RegExp }).name;
    expect(name).toBeInstanceOf(RegExp);
    expect(name.source).toBe('\\.\\*'); // '.*' escaped: it matches the two literal characters
    expect(name.test('.*')).toBe(true);
    expect(name.test('anything')).toBe(false);
    expect(filter.$and).toEqual([{ state: true }]);
    expect(Category.find).toHaveBeenCalledTimes(1);
    expect(Category.limit).toHaveBeenCalledWith(20);
  });

  test('the user text search looks in name and email', async () => {
    const { service, User } = makeService({ user: [] });

    await service.search('user', 'FIND');

    const filter = User.filters[0] as { $or: Record<string, RegExp>[] };
    expect(filter.$or.map((clause) => Object.keys(clause))).toEqual([['name'], ['email']]);
  });
});
