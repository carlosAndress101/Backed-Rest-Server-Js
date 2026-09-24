// The registry seam (ADR-027, P14) and the stored shape (M3 design §5.3). No database needed.
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

  test('stores the legacy shape: name, state, user, price, category, description, available, image (M4 owns schema changes)', () => {
    const { schema } = ProductModel;

    expect(Object.keys(schema.paths).sort()).toEqual([
      '_id',
      'available',
      'category',
      'description',
      'image',
      'name',
      'price',
      'state',
      'user',
    ]);
    expect(schema.path('name')).toMatchObject({ instance: 'String', isRequired: true });
    expect(schema.path('name').options).toMatchObject({
      unique: true,
      required: [true, 'The name is required'],
    });
    expect(schema.path('state')).toMatchObject({ instance: 'Boolean', isRequired: true, defaultValue: true });
    expect(schema.path('user')).toMatchObject({ instance: 'ObjectId', isRequired: true });
    expect(schema.path('user').options).toMatchObject({ ref: 'User' });
    expect(schema.path('price')).toMatchObject({ instance: 'Number', defaultValue: 0 });
    expect(schema.path('category')).toMatchObject({ instance: 'ObjectId', isRequired: true });
    expect(schema.path('category').options).toMatchObject({ ref: 'Category' });
    expect(schema.path('description')).toMatchObject({ instance: 'String' });
    expect(schema.path('available')).toMatchObject({ instance: 'Boolean', defaultValue: true });
    expect(schema.path('image')).toMatchObject({ instance: 'String' });
    expect(schema.get('versionKey')).toBe(false);
  });

  test('serializes with id and without _id or uid (P13)', () => {
    const user = new mongoose.Types.ObjectId();
    const category = new mongoose.Types.ObjectId();
    const product = new ProductModel({ name: 'KEYBOARD', user, category });

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
