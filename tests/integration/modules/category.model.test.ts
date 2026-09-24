// The M4 category indexes and DB-backed model behaviour (design §3.1, §10.6) through the M3 harness (D-11).
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { CategoryModel } from '../../../src/modules/categories';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';

const owner = () => new mongoose.Types.ObjectId();

describe('CategoryModel (database)', () => {
  beforeAll(async () => {
    await startTestApp();
    await CategoryModel.init(); // build the schema indexes from §3.1
  });

  afterAll(stopTestApp);

  beforeEach(clearDatabase);

  test('the built indexes equal the §3.1 catalogue', async () => {
    const indexes = await CategoryModel.listIndexes();

    expect(indexes.map((index) => index.name).sort()).toEqual([
      '_id_',
      'name_active_unique',
      'state_1',
      'user_1',
    ]);
    const name = indexes.find((index) => index.name === 'name_active_unique');
    expect(name).toMatchObject({
      key: { name: 1 },
      unique: true,
      partialFilterExpression: { state: true },
    });
    expect(name?.collation).toMatchObject({ locale: 'en', strength: 2 });
    expect(indexes.find((index) => index.name === 'user_1')).toMatchObject({ key: { user: 1 } });
  });

  test('an active case-variant duplicate name is 11000', async () => {
    await CategoryModel.create({ name: 'Phone', user: owner() });

    await expect(CategoryModel.create({ name: 'PHONE', user: owner() })).rejects.toMatchObject({
      code: 11000,
    });
  });

  test('a soft-deleted name can be re-created', async () => {
    const retired = await CategoryModel.create({ name: 'PHONE', user: owner() });
    await CategoryModel.updateOne({ _id: retired._id }, { state: false });

    await expect(CategoryModel.create({ name: 'phone', user: owner() })).resolves.toMatchObject({
      name: 'PHONE',
      state: true,
    });
  });

  test('toJSON exposes id and state and never _id or uid', async () => {
    const category = await CategoryModel.create({ name: 'Coffee', user: owner() });

    const json = JSON.parse(JSON.stringify(category)) as Record<string, unknown>;

    expect(json).toMatchObject({ id: category.id, name: 'COFFEE', state: true });
    expect(json).not.toHaveProperty('_id');
    expect(json).not.toHaveProperty('uid');
  });
});
