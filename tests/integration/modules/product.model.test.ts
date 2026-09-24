// The M4 product indexes and DB-backed model behaviour (design §3.1, §10.6) through the M3 harness (D-11).
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { ProductModel } from '../../../src/modules/products';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';

const ref = () => new mongoose.Types.ObjectId();

describe('ProductModel (database)', () => {
  beforeAll(async () => {
    await startTestApp();
    await ProductModel.init(); // build the schema indexes from §3.1
  });

  afterAll(stopTestApp);

  beforeEach(clearDatabase);

  test('the built indexes equal the §3.1 catalogue', async () => {
    const indexes = await ProductModel.listIndexes();

    expect(indexes.map((index) => index.name).sort()).toEqual([
      '_id_',
      'category_1',
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
    expect(indexes.find((index) => index.name === 'category_1')).toMatchObject({
      key: { category: 1 },
    });
    expect(indexes.find((index) => index.name === 'user_1')).toMatchObject({ key: { user: 1 } });
  });

  test('an active case-variant duplicate name is 11000', async () => {
    await ProductModel.create({ name: 'Phone', user: ref(), category: ref() });

    await expect(ProductModel.create({ name: 'PHONE', user: ref(), category: ref() })).rejects.toMatchObject({
      code: 11000,
    });
  });

  test('a soft-deleted name can be re-created', async () => {
    const retired = await ProductModel.create({ name: 'PHONE', user: ref(), category: ref() });
    await ProductModel.updateOne({ _id: retired._id }, { state: false });

    await expect(ProductModel.create({ name: 'phone', user: ref(), category: ref() })).resolves.toMatchObject(
      { name: 'PHONE', state: true },
    );
  });

  test('toJSON exposes id and state and never _id or uid', async () => {
    const product = await ProductModel.create({ name: 'Keyboard', user: ref(), category: ref() });

    const json = JSON.parse(JSON.stringify(product)) as Record<string, unknown>;

    expect(json).toMatchObject({ id: product.id, name: 'KEYBOARD', state: true, price: 0, available: true });
    expect(json).not.toHaveProperty('_id');
    expect(json).not.toHaveProperty('uid');
  });
});
