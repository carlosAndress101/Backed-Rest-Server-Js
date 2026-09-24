// P13 (M3 design §3.7, shared with M4): how every migrated model serializes.
import mongoose, { Schema } from 'mongoose';
import { describe, expect, test } from 'vitest';

import { toJsonPlugin } from '../../src/core/database/to-json.plugin';

// A private Mongoose instance: no connection needed, and the global model registry stays untouched.
const odm = new mongoose.Mongoose();

const categorySchema = new Schema({ name: String, state: Boolean, user: Schema.Types.ObjectId });
toJsonPlugin(categorySchema);
const Category = odm.model('Category', categorySchema);

const userSchema = new Schema({ name: String, email: String, password: String, role: String });
toJsonPlugin(userSchema, { hidden: ['password'], uidAlias: true });
const User = odm.model('User', userSchema);

const serialize = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

describe('toJsonPlugin', () => {
  test('emits a string id first, and never _id or __v', () => {
    const owner = new mongoose.Types.ObjectId();
    const category = Category.hydrate({
      _id: new mongoose.Types.ObjectId(),
      name: 'COFFEE',
      state: true,
      user: owner,
      __v: 3,
    });

    const json = serialize(category);

    expect(json).toEqual({ id: category.id, name: 'COFFEE', state: true, user: owner.toHexString() });
    expect(Object.keys(json)[0]).toBe('id');
    expect(typeof (category.toJSON() as Record<string, unknown>).id).toBe('string'); // not an ObjectId
    expect(json.id).toBe(category._id.toHexString());
  });

  test('adds no uid unless asked', () => {
    expect(serialize(new Category({ name: 'TEA' }))).not.toHaveProperty('uid');
  });

  test('drops the hidden fields and adds the uid alias, right after id', () => {
    const user = new User({
      name: 'Ada',
      email: 'ada@example.com',
      password: '$2b$04$hash',
      role: 'USER_ROLE',
    });

    const json = serialize(user);

    expect(json).toEqual({
      id: user.id,
      uid: user.id,
      name: 'Ada',
      email: 'ada@example.com',
      role: 'USER_ROLE',
    });
    expect(Object.keys(json).slice(0, 2)).toEqual(['id', 'uid']);
    expect(JSON.stringify(user)).not.toContain('$2b$04$hash');
  });

  test('changes only the JSON output: the document and toObject() keep _id and every field', () => {
    const user = new User({ name: 'Ada', password: 'secret-hash' });

    void user.toJSON();

    expect(user.password).toBe('secret-hash');
    expect(user._id).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(user.toObject()).toMatchObject({ _id: user._id, password: 'secret-hash' });
  });

  test('applies to every document of a list (what res.json sends)', () => {
    const list = [new Category({ name: 'A' }), new Category({ name: 'B' })];

    const json = JSON.parse(JSON.stringify(list)) as Record<string, unknown>[];

    expect(json.map((item) => Object.keys(item)[0])).toEqual(['id', 'id']);
    expect(json.some((item) => '_id' in item)).toBe(false);
  });

  test('the options apply to the schema they were given to only', () => {
    expect(serialize(new Category({ name: 'C' }))).toEqual({ id: expect.any(String), name: 'C' });
    expect(serialize(new User({ name: 'D', password: 'x' }))).toEqual({
      id: expect.any(String),
      uid: expect.any(String),
      name: 'D',
    });
  });
});
