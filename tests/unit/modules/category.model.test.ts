// The registry seam (ADR-027, P14) and the M4 stored shape (design §2.2). No database needed.
import mongoose from 'mongoose';
import { describe, expect, test, vi } from 'vitest';

import { CategoryModel } from '../../../src/modules/categories';

describe('CategoryModel', () => {
  test('is the one registered Category (ADR-027)', () => {
    expect(mongoose.model('Category')).toBe(CategoryModel);
  });

  test('a second import of the model file reuses the registration instead of throwing OverwriteModelError', async () => {
    vi.resetModules(); // the next import evaluates category.model.ts again; the mongoose registry is kept
    const reloaded = await import('../../../src/modules/categories/category.model.js');

    expect(reloaded.CategoryModel).toBe(CategoryModel);
    expect(mongoose.modelNames().filter((name) => name === 'Category')).toHaveLength(1);
  });

  test('stores the M4 shape: name caps and casing, timestamps, and no version key', () => {
    const { schema } = CategoryModel;

    expect(Object.keys(schema.paths).sort()).toEqual([
      '_id',
      'createdAt',
      'name',
      'state',
      'updatedAt',
      'user',
    ]);
    expect(schema.path('name')).toMatchObject({ instance: 'String', isRequired: true });
    expect(schema.path('name').options).toMatchObject({
      required: [true, 'The name is required'],
      trim: true,
      uppercase: true,
      maxlength: 120,
    });
    // §2.0: no field-level unique; the partial unique index is declared explicitly in §3.1.
    expect(schema.path('name').options.unique).toBeUndefined();
    expect(schema.path('state')).toMatchObject({ instance: 'Boolean', isRequired: true, defaultValue: true });
    expect(schema.path('user')).toMatchObject({ instance: 'ObjectId', isRequired: true });
    expect(schema.path('user').options).toMatchObject({ ref: 'User' });
    expect(schema.get('versionKey')).toBe(false);
    expect(schema.get('timestamps')).toBe(true);
  });

  test('declares exactly the §3.1 indexes on the schema', () => {
    const declared = CategoryModel.schema.indexes().map(([fields, options]) => ({
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
      { fields: { user: 1 }, name: 'user_1', unique: false },
    ]);
  });

  test('serializes with id and without _id or uid, uppercasing the name (P13)', () => {
    const user = new mongoose.Types.ObjectId();
    const category = new CategoryModel({ name: 'coffee', user });

    expect(JSON.parse(JSON.stringify(category))).toEqual({
      id: category.id,
      name: 'COFFEE',
      state: true,
      user: user.toHexString(),
    });
  });
});
