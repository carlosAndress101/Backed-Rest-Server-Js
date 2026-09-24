// The registry seam (ADR-027, P14) and the stored shape (M3 design §1.2, §4.1). No database needed.
import mongoose from 'mongoose';
import { describe, expect, test, vi } from 'vitest';

import { CategoryModel } from '../../../src/modules/categories';
import { legacyModels } from '../../helpers/legacy';

describe('CategoryModel', () => {
  test('is the one registered Category, and legacy code reads that same model (ADR-027)', () => {
    expect(mongoose.model('Category')).toBe(CategoryModel);
    expect(legacyModels().Category).toBe(CategoryModel); // models/index.js → the models/category.js re-export
  });

  test('a second import of the model file reuses the registration instead of throwing OverwriteModelError', async () => {
    vi.resetModules(); // the next import evaluates category.model.ts again; the mongoose registry is kept
    const reloaded = await import('../../../src/modules/categories/category.model.js');

    expect(reloaded.CategoryModel).toBe(CategoryModel);
    expect(mongoose.modelNames().filter((name) => name === 'Category')).toHaveLength(1);
  });

  test('stores the legacy shape: name, state and user, no version key (M4 owns schema changes)', () => {
    const { schema } = CategoryModel;

    expect(Object.keys(schema.paths).sort()).toEqual(['_id', 'name', 'state', 'user']);
    expect(schema.path('name')).toMatchObject({ instance: 'String', isRequired: true });
    expect(schema.path('name').options).toMatchObject({
      unique: true,
      required: [true, 'The name is required'],
    });
    expect(schema.path('state')).toMatchObject({ instance: 'Boolean', isRequired: true, defaultValue: true });
    expect(schema.path('user')).toMatchObject({ instance: 'ObjectId', isRequired: true });
    expect(schema.path('user').options).toMatchObject({ ref: 'User' });
    expect(schema.get('versionKey')).toBe(false);
  });

  test('serializes with id and without _id or uid (P13)', () => {
    const user = new mongoose.Types.ObjectId();
    const category = new CategoryModel({ name: 'COFFEE', user });

    expect(JSON.parse(JSON.stringify(category))).toEqual({
      id: category.id,
      name: 'COFFEE',
      state: true,
      user: user.toHexString(),
    });
  });
});
