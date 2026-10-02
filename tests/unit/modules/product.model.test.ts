// The registry seam (ADR-027, P14) and the M4 stored shape (design §2.3). No database needed.
import mongoose from 'mongoose';
import { describe, expect, test, vi } from 'vitest';

import { ProductModel } from '../../../src/modules/products';

describe('ProductModel', () => {
  test('is the one registered Product (ADR-027)', () => {
    expect(mongoose.model('Product')).toBe(ProductModel);
  });

  test('a second import of the model file reuses the registration instead of throwing OverwriteModelError', async () => {
    vi.resetModules(); // the next import evaluates product.model.ts again; the mongoose registry is kept
    const reloaded = await import('../../../src/modules/products/product.model.js');

    expect(reloaded.ProductModel).toBe(ProductModel);
    expect(mongoose.modelNames().filter((name) => name === 'Product')).toHaveLength(1);
  });

  test('stores the M4 shape: caps and casing, min price, timestamps, and no version key', () => {
    const { schema } = ProductModel;

    expect(Object.keys(schema.paths).sort()).toEqual([
      '_id',
      'available',
      'category',
      'createdAt',
      'description',
      'image',
      'name',
      'price',
      'state',
      'updatedAt',
      'user',
    ]);
    expect(schema.path('name')).toMatchObject({ instance: 'String', isRequired: true });
    expect(schema.path('name').options).toMatchObject({
      required: [true, 'The name is required'],
      trim: true,
      uppercase: true,
      maxlength: [120, 'The name must be at most 120 characters'],
    });
    // §2.0: no field-level unique; the partial unique index is declared explicitly in §3.1.
    expect(schema.path('name').options.unique).toBeUndefined();
    expect(schema.path('state')).toMatchObject({ instance: 'Boolean', isRequired: true, defaultValue: true });
    expect(schema.path('user')).toMatchObject({ instance: 'ObjectId', isRequired: true });
    expect(schema.path('user').options).toMatchObject({ ref: 'User' });
    expect(schema.path('price')).toMatchObject({ instance: 'Number', defaultValue: 0 });
    expect(schema.path('price').options).toMatchObject({ min: [0, 'The price cannot be negative'] });
    expect(schema.path('category')).toMatchObject({ instance: 'ObjectId', isRequired: true });
    expect(schema.path('category').options).toMatchObject({ ref: 'Category' });
    expect(schema.path('description')).toMatchObject({ instance: 'String' });
    expect(schema.path('description').options).toMatchObject({
      trim: true,
      maxlength: [2000, 'The description must be at most 2000 characters'],
    });
    expect(schema.path('available')).toMatchObject({
      instance: 'Boolean',
      isRequired: true,
      defaultValue: true,
    });
    expect(schema.path('image')).toMatchObject({ instance: 'String' });
    expect(schema.path('image').options).toMatchObject({
      trim: true,
      maxlength: [2048, 'The image must be at most 2048 characters'],
    });
    expect(schema.path('image').options.validate).toBeUndefined(); // AM-M4-4: no pattern validator
    expect(schema.get('versionKey')).toBe(false);
    expect(schema.get('timestamps')).toBe(true);
  });

  test('declares exactly the §3.1 indexes on the schema', () => {
    const declared = ProductModel.schema.indexes().map(([fields, options]) => ({
      fields,
      name: options.name,
      unique: options.unique ?? false,
      ...(options.collation ? { collation: options.collation } : {}),
      ...(options.partialFilterExpression
        ? { partialFilterExpression: options.partialFilterExpression }
        : {}),
    }));

    expect(declared).toEqual([
      {
        fields: { name: 1 },
        name: 'name_active_unique',
        unique: true,
        collation: { locale: 'en', strength: 2 },
        partialFilterExpression: { state: true },
      },
      { fields: { state: 1 }, name: 'state_1', unique: false },
      { fields: { category: 1 }, name: 'category_1', unique: false },
      { fields: { user: 1 }, name: 'user_1', unique: false },
    ]);
  });

  test('serializes with id and without _id or uid, uppercasing the name (P13)', () => {
    const user = new mongoose.Types.ObjectId();
    const category = new mongoose.Types.ObjectId();
    const product = new ProductModel({ name: 'keyboard', user, category });

    expect(JSON.parse(JSON.stringify(product))).toEqual({
      id: product.id,
      name: 'KEYBOARD',
      state: true,
      user: user.toHexString(),
      price: 0,
      category: category.toHexString(),
      available: true,
    });
  });
});
