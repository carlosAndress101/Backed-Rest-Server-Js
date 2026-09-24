// P17 (M4 design §3.1, §10.1): after `migrate up`, the index set is exactly the §3.1 catalogue, whether the database
// starts empty, 2.x-shaped, or already indexed by Mongoose (dev and test run with autoIndex on). Each test gets its
// own database on the run's mongod, reached through its own driver client, so no Mongoose model builds indexes in it.
import { randomUUID } from 'node:crypto';

import mongoose, { type mongo } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';

import { createLogger } from '../../../src/core/logger';
import { MIGRATIONS } from '../../../src/database/cli';
import { runMigrations } from '../../../src/database/migrate';
import { CategoryModel } from '../../../src/modules/categories';
import { ProductModel } from '../../../src/modules/products';
import { UserModel } from '../../../src/modules/users';

const MONGO_URI = inject('mongoUri');
const COLLECTIONS = ['users', 'categories', 'products'] as const;
const log = createLogger({ logLevel: 'silent' });

interface IndexShape {
  name: string;
  key: Record<string, unknown>;
  unique?: true;
  collation?: { locale: string; strength: number | undefined };
  partialFilterExpression?: Record<string, unknown>;
}

const ID = { name: '_id_', key: { _id: 1 } };
const NAME_ACTIVE_UNIQUE = {
  name: 'name_active_unique',
  key: { name: 1 },
  unique: true,
  collation: { locale: 'en', strength: 2 },
  partialFilterExpression: { state: true },
} as const;

/** §3.1, index by index, sorted by name. */
const CATALOGUE = {
  users: [ID, { name: 'email_1', key: { email: 1 }, unique: true }, { name: 'state_1', key: { state: 1 } }],
  categories: [
    ID,
    NAME_ACTIVE_UNIQUE,
    { name: 'state_1', key: { state: 1 } },
    { name: 'user_1', key: { user: 1 } },
  ],
  products: [
    ID,
    { name: 'category_1', key: { category: 1 } },
    NAME_ACTIVE_UNIQUE,
    { name: 'state_1', key: { state: 1 } },
    { name: 'user_1', key: { user: 1 } },
  ],
};

/** The indexes of the three collections, reduced to what §3.1 specifies. */
const indexSet = async (db: mongo.Db): Promise<Record<string, IndexShape[]>> => {
  const set: Record<string, IndexShape[]> = {};
  for (const name of COLLECTIONS) {
    const indexes = await db.collection(name).indexes();
    set[name] = indexes
      .map(({ name: index, key, unique, collation, partialFilterExpression }) => ({
        name: index!,
        key,
        ...(unique ? { unique: true as const } : {}),
        ...(collation ? { collation: { locale: collation.locale, strength: collation.strength } } : {}),
        ...(partialFilterExpression ? { partialFilterExpression } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return set;
};

/** A database as 2.x left it: mixed-case emails, no timestamps, `__v`, the Role collection, 2.x unique indexes. */
const seed2x = async (db: mongo.Db) => {
  const owner = new mongoose.Types.ObjectId();
  const category = new mongoose.Types.ObjectId();
  await db.collection('users').insertMany([
    {
      _id: owner,
      name: 'Ada',
      email: ' Ada@Example.COM ',
      password: 'hash',
      role: 'ADMIN_ROLE',
      state: true,
      google: false,
      __v: 0,
    },
    {
      name: 'Grace',
      email: 'grace@example.com',
      password: 'hash',
      role: 'VENTAS_ROLE',
      state: false,
      google: false,
      __v: 0,
    },
  ]);
  await db.collection('categories').insertMany([
    { _id: category, name: 'COFFEE', state: true, user: owner, __v: 0 },
    { name: 'TEA', state: false, user: owner, __v: 0 },
  ]);
  await db
    .collection('products')
    .insertOne({ name: 'LATTE', state: true, user: owner, category, price: 3, available: true, __v: 0 });
  await db
    .collection('roles')
    .insertMany(['ADMIN_ROLE', 'USER_ROLE', 'VENTAS_ROLE'].map((role) => ({ role, __v: 0 })));
  // The indexes 2.x's field-level `unique: true` built.
  await db.collection('users').createIndex({ email: 1 }, { name: 'email_1', unique: true, background: true });
  await db
    .collection('categories')
    .createIndex({ name: 1 }, { name: 'name_1', unique: true, background: true });
  await db
    .collection('products')
    .createIndex({ name: 1 }, { name: 'name_1', unique: true, background: true });
};

const LEGACY_2X = {
  users: [ID, { name: 'email_1', key: { email: 1 }, unique: true }],
  categories: [ID, { name: 'name_1', key: { name: 1 }, unique: true }],
  products: [ID, { name: 'name_1', key: { name: 1 }, unique: true }],
};

let client: mongo.MongoClient;
let dbName: string;
let db: mongo.Db;

const migrate = (direction: 'up' | 'down') => runMigrations(db, MIGRATIONS, { direction, log });

beforeAll(async () => {
  client = await new mongoose.mongo.MongoClient(MONGO_URI).connect();
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  dbName = `indexes-${randomUUID()}`;
  db = client.db(dbName);
});

afterEach(async () => {
  await db.dropDatabase();
});

describe('the §3.1 catalogue after migrate up (P17)', () => {
  test('on an empty database', async () => {
    await migrate('up');

    expect(await indexSet(db)).toEqual(CATALOGUE);
  });

  test('on a 2.x-shaped database: name_1 is gone, email_1 is rebuilt, every M4 index exists', async () => {
    await seed2x(db);
    expect(await indexSet(db)).toEqual(LEGACY_2X);

    await migrate('up');

    expect(await indexSet(db)).toEqual(CATALOGUE);
  });

  test('on a database Mongoose already indexed from the schemas (autoIndex, dev and test): the same set, no conflict', async () => {
    const connection = await mongoose
      .createConnection(`${MONGO_URI}${dbName}`, { autoIndex: true })
      .asPromise();
    try {
      for (const model of [UserModel, CategoryModel, ProductModel])
        await connection.model(model.modelName, model.schema).init();
      const fromSchemas = await indexSet(db);

      await migrate('up');

      // The migrations (production) and the schemas (dev, test) build the same indexes.
      expect(fromSchemas).toEqual(CATALOGUE);
      expect(await indexSet(db)).toEqual(CATALOGUE);
    } finally {
      await connection.close();
    }
  });

  test('migrate down on the 2.x-shaped database restores the 2.x index set', async () => {
    await seed2x(db);
    await migrate('up');

    await migrate('down');

    expect(await indexSet(db)).toEqual(LEGACY_2X);
  });
});
