// M001–M004 (M4 design §5.3, P18) on raw 2.x-shaped data: what each `up` writes, every abort-on-check path (nothing
// written, nothing recorded), and each `down`. Each test gets its own database on the run's mongod, reached through
// its own driver client, so no Mongoose model builds indexes in it (the harness runs with autoIndex on).
import { randomUUID } from 'node:crypto';

import mongoose, { type mongo } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';

import { createLogger } from '../../../src/core/logger';
import { MIGRATIONS } from '../../../src/database/cli';
import { LEDGER, runMigrations, type Migration } from '../../../src/database/migrate';
import { M001 } from '../../../src/database/migrations/M001-normalize-email';
import { M002 } from '../../../src/database/migrations/M002-rebuild-name-indexes';
import { M003 } from '../../../src/database/migrations/M003-backfill-created-at';
import { M004 } from '../../../src/database/migrations/M004-drop-roles-collection';

const MONGO_URI = inject('mongoUri');
const { ObjectId } = mongoose.Types;

type LogRecord = Record<string, unknown>;

let client: mongo.MongoClient;
let db: mongo.Db;
let lines: string[];
const log = () => createLogger({ logLevel: 'info' }, { write: (line: string) => void lines.push(line) });
const records = () => lines.map((line) => JSON.parse(line) as LogRecord);

const run = (migrations: readonly Migration[], direction: 'up' | 'down' = 'up', dryRun = false) =>
  runMigrations(db, migrations, { direction, dryRun, log: log() });
const ledger = async () =>
  (await db.collection(LEDGER).find({}).sort({ id: 1 }).toArray()).map(({ id }) => id);
const indexNames = async (name: string) => {
  const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  return exists ? (await db.collection(name).indexes()).map((index) => index.name).sort() : [];
};
const collectionNames = async () =>
  (await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name).sort();

/** A 2.x user document: no timestamps, `__v`, any email casing. */
const user2x = (email: string, fields: Record<string, unknown> = {}) => ({
  name: 'User',
  email,
  password: 'hash',
  role: 'USER_ROLE',
  state: true,
  google: false,
  __v: 0,
  ...fields,
});

const OWNER = new ObjectId();

beforeAll(async () => {
  client = await new mongoose.mongo.MongoClient(MONGO_URI).connect();
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  db = client.db(`migrations-${randomUUID()}`);
  lines = [];
});

afterEach(async () => {
  await db.dropDatabase();
});

describe('the migration list', () => {
  test('is M001–M004, in id order, M004 (destructive) last', () => {
    expect(MIGRATIONS.map(({ id }) => id)).toEqual([
      'M001-normalize-email',
      'M002-rebuild-name-indexes',
      'M003-backfill-created-at',
      'M004-drop-roles-collection',
    ]);
  });

  test('applies once and records all four; a second up is a no-op', async () => {
    await db.collection('users').insertOne(user2x('Ada@Example.com'));

    expect(await run(MIGRATIONS)).toHaveLength(4);
    const once = await db.collection('users').findOne({});
    const recorded = await ledger();

    expect(await run(MIGRATIONS)).toEqual([]);
    expect(recorded).toEqual(MIGRATIONS.map(({ id }) => id));
    expect(await ledger()).toEqual(recorded);
    expect(await db.collection('users').findOne({})).toEqual(once);
  });

  test('--dry-run writes nothing: no data, no index, no ledger', async () => {
    await db.collection('users').insertOne(user2x(' Ada@Example.com '));
    await db.collection('roles').insertOne({ role: 'USER_ROLE' });
    const before = await db.collection('users').findOne({});

    expect(await run(MIGRATIONS, 'up', true)).toHaveLength(4);

    expect(await db.collection('users').findOne({})).toEqual(before);
    expect(await indexNames('users')).toEqual(['_id_']);
    expect(await collectionNames()).toEqual(['roles', 'users']);
  });
});

describe('M001-normalize-email', () => {
  test('up trims and lowercases every email and builds email_1 (unique) and state_1', async () => {
    await db
      .collection('users')
      .insertMany([user2x(' Ada@Example.COM '), user2x('grace@example.com'), user2x('LINUS@EXAMPLE.COM')]);

    await run([M001]);

    const emails = await db.collection('users').distinct('email');
    expect(emails.sort()).toEqual(['ada@example.com', 'grace@example.com', 'linus@example.com']);
    expect(await indexNames('users')).toEqual(['_id_', 'email_1', 'state_1']);
    await expect(db.collection('users').insertOne(user2x('ada@example.com'))).rejects.toMatchObject({
      code: 11000,
    });
  });

  test('up aborts on emails that collide once normalized: nothing written, nothing recorded, the ids reported', async () => {
    const { insertedIds } = await db
      .collection('users')
      .insertMany([user2x('Ada@Example.com'), user2x(' ada@example.COM'), user2x('grace@example.com')]);
    const before = await db.collection('users').find({}).toArray();

    const failure = run([M001]);

    await expect(failure).rejects.toThrow(/^M001 aborted: 1 group\(s\) of users share an email/);
    await expect(failure).rejects.toThrow(String(insertedIds[0]));
    await expect(failure).rejects.toThrow(String(insertedIds[1]));
    expect(await db.collection('users').find({}).toArray()).toEqual(before);
    expect(await indexNames('users')).toEqual(['_id_']);
    expect(await ledger()).toEqual([]);
  });

  test('down drops state_1, keeps the unique email_1 and warns that casing is not restored (lossy)', async () => {
    await db.collection('users').insertOne(user2x('Ada@Example.com'));
    await run([M001]);

    await run([M001], 'down');

    expect(await indexNames('users')).toEqual(['_id_', 'email_1']);
    expect(await db.collection('users').distinct('email')).toEqual(['ada@example.com']);
    expect(records()).toContainEqual(
      expect.objectContaining({ level: 40, msg: expect.stringContaining('casing is NOT restored (lossy)') }),
    );
  });
});

describe('M002-rebuild-name-indexes', () => {
  const category = (name: string, state = true) => ({ name, state, user: OWNER, __v: 0 });

  test('up replaces name_1 with name_active_unique and builds the supporting indexes', async () => {
    await db.collection('categories').insertMany([category('COFFEE'), category('TEA', false)]);
    await db.collection('products').insertOne({ ...category('LATTE'), category: new ObjectId() });
    for (const name of ['categories', 'products'])
      await db.collection(name).createIndex({ name: 1 }, { name: 'name_1', unique: true });

    await run([M002]);

    expect(await indexNames('categories')).toEqual(['_id_', 'name_active_unique', 'state_1', 'user_1']);
    expect(await indexNames('products')).toEqual([
      '_id_',
      'category_1',
      'name_active_unique',
      'state_1',
      'user_1',
    ]);
    // A soft-deleted name is reusable; an active case variant collides.
    await db.collection('categories').insertOne(category('TEA'));
    await expect(db.collection('categories').insertOne(category('coffee'))).rejects.toMatchObject({
      code: 11000,
    });
  });

  test('a soft-deleted duplicate does not abort up: only active names must be unique', async () => {
    await db.collection('categories').insertMany([category('COFFEE'), category('COFFEE', false)]);

    await expect(run([M002])).resolves.toEqual(['M002-rebuild-name-indexes']);
  });

  test.each(['categories', 'products'])(
    'up aborts on active names that differ only in case in %s: no index changes in either collection, nothing recorded',
    async (name) => {
      const { insertedIds } = await db.collection(name).insertMany([category('COFFEE'), category('coffee')]);
      await db.collection('categories').createIndex({ name: 1 }, { name: 'name_1', unique: true });

      const failure = run([M002]);

      await expect(failure).rejects.toThrow(/^M002 aborted: 1 group\(s\) of active documents share a name/);
      await expect(failure).rejects.toThrow(String(insertedIds[0]));
      expect(await indexNames('categories')).toEqual(['_id_', 'name_1']);
      expect(await indexNames('products')).toEqual(name === 'products' ? ['_id_'] : []);
      expect(await ledger()).toEqual([]);
    },
  );

  test('down restores the 2.x name_1 and drops the M4 indexes', async () => {
    await db.collection('categories').insertOne(category('COFFEE'));
    await run([M002]);

    await run([M002], 'down');

    expect(await indexNames('categories')).toEqual(['_id_', 'name_1']);
    expect(await indexNames('products')).toEqual(['_id_', 'name_1']);
  });

  test('down aborts before dropping anything when a soft-deleted name is in use again', async () => {
    await db.collection('categories').insertOne(category('COFFEE', false));
    await run([M002]);
    await db.collection('categories').insertOne(category('COFFEE')); // allowed by the partial index

    await expect(run([M002], 'down')).rejects.toThrow(/^M002 down aborted: 1 group\(s\)/);

    expect(await indexNames('categories')).toEqual(['_id_', 'name_active_unique', 'state_1', 'user_1']);
    expect(await ledger()).toEqual(['M002-rebuild-name-indexes']);
  });
});

describe('M003-backfill-created-at', () => {
  test('up sets createdAt and updatedAt from the ObjectId in all three collections (P5)', async () => {
    await db.collection('users').insertOne(user2x('ada@example.com'));
    await db.collection('categories').insertOne({ name: 'COFFEE', state: true, user: OWNER });
    await db
      .collection('products')
      .insertOne({ name: 'LATTE', state: true, user: OWNER, category: new ObjectId() });

    await run([M003]);

    for (const name of ['users', 'categories', 'products']) {
      const doc = (await db.collection(name).findOne({}))!;
      expect(doc.createdAt).toEqual(doc._id.getTimestamp());
      expect(doc.updatedAt).toEqual(doc._id.getTimestamp());
    }
  });

  test('up keeps a timestamp a document already has', async () => {
    const createdAt = new Date('2026-01-02T03:04:05Z');
    const { insertedId } = await db.collection('users').insertOne(user2x('ada@example.com', { createdAt }));

    await run([M003]);

    const doc = (await db.collection('users').findOne({ _id: insertedId }))!;
    expect(doc.createdAt).toEqual(createdAt);
    expect(doc.updatedAt).toEqual(insertedId.getTimestamp());
  });

  test('down removes both timestamps', async () => {
    await db.collection('users').insertOne(user2x('ada@example.com'));
    await run([M003]);

    await run([M003], 'down');

    const doc = (await db.collection('users').findOne({}))!;
    expect(doc).not.toHaveProperty('createdAt');
    expect(doc).not.toHaveProperty('updatedAt');
  });
});

describe('M004-drop-roles-collection', () => {
  const ROLES = ['ADMIN_ROLE', 'USER_ROLE', 'VENTAS_ROLE'];

  test('up drops the 2.x roles collection when every user role is in the enum', async () => {
    await db.collection('roles').insertMany(ROLES.map((role) => ({ role, __v: 0 })));
    await db.collection('users').insertMany(ROLES.map((role) => user2x(`${role}@example.com`, { role })));

    await run([M004]);

    expect(await collectionNames()).not.toContain('roles');
  });

  test('up on a database without roles is a no-op that still records', async () => {
    await expect(run([M004])).resolves.toEqual(['M004-drop-roles-collection']);
    expect(await ledger()).toEqual(['M004-drop-roles-collection']);
  });

  test.each([['SUPER_ROLE'], [null]])(
    'up aborts on a user role outside the enum (%s): roles kept, nothing recorded',
    async (role) => {
      await db.collection('roles').insertMany(ROLES.map((name) => ({ role: name })));
      await db.collection('users').insertOne(user2x('ada@example.com', { role }));

      await expect(run([M004])).rejects.toThrow(/^M004 aborted: users hold role value\(s\) outside/);

      expect(await db.collection('roles').countDocuments()).toBe(3);
      expect(await ledger()).toEqual([]);
    },
  );

  test('down recreates the three constant roles, once', async () => {
    await db.collection('roles').insertMany(ROLES.map((role) => ({ role })));
    await run([M004]);

    await run([M004], 'down');
    await M004.down(db, log()); // a second down adds nothing

    const roles = await db
      .collection('roles')
      .find({}, { projection: { _id: 0 } })
      .toArray();
    expect(roles.map(({ role }) => role as string).sort()).toEqual(ROLES);
  });
});

describe('the whole list on a 2.x-shaped database', () => {
  test('up then down: data and indexes back to 2.x, except email casing (lossy, M001)', async () => {
    await db.collection('users').insertOne(user2x(' Ada@Example.com ', { role: 'ADMIN_ROLE' }));
    await db.collection('users').createIndex({ email: 1 }, { name: 'email_1', unique: true });
    await db
      .collection('roles')
      .insertMany(['ADMIN_ROLE', 'USER_ROLE', 'VENTAS_ROLE'].map((role) => ({ role })));

    await run(MIGRATIONS);
    const migrated = (await db.collection('users').findOne({}))!;
    expect(migrated).toMatchObject({ email: 'ada@example.com', createdAt: migrated._id.getTimestamp() });
    expect(await collectionNames()).not.toContain('roles');

    expect(await run(MIGRATIONS, 'down')).toEqual([
      'M004-drop-roles-collection',
      'M003-backfill-created-at',
      'M002-rebuild-name-indexes',
      'M001-normalize-email',
    ]);

    const reverted = (await db.collection('users').findOne({}))!;
    expect(reverted).not.toHaveProperty('createdAt');
    expect(reverted.email).toBe('ada@example.com'); // lossy: the backup holds ' Ada@Example.com '
    expect(await db.collection('roles').countDocuments()).toBe(3);
    expect(await indexNames('users')).toEqual(['_id_', 'email_1']);
    expect(await ledger()).toEqual([]);
  });
});
