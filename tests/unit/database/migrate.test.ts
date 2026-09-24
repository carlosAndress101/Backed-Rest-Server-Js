// P18 (M4 design §5.2): the in-repo migration runner and its CLI, against the run's in-memory mongod. Each test
// gets its own database, reached through its own driver client, so nothing leaks between tests.
import { randomUUID } from 'node:crypto';

import mongoose, { type mongo } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, test, vi } from 'vitest';

import { createLogger } from '../../../src/core/logger';
import {
  MIGRATIONS,
  USAGE,
  UsageError,
  main,
  parseArgs,
  runCommand,
  seedNotAvailable,
  type Command,
} from '../../../src/database/cli';
import { LEDGER, migrationStatus, runMigrations, type Migration } from '../../../src/database/migrate';

const MONGO_URI = inject('mongoUri');

type LogRecord = Record<string, unknown>;

/** A logger writing to memory; `records()` parses every line written so far. */
const capture = () => {
  const lines: string[] = [];
  const log = createLogger({ logLevel: 'info' }, { write: (line: string) => void lines.push(line) });
  return { log, records: () => lines.map((line) => JSON.parse(line) as LogRecord) };
};

/** A migration that records each call in `calls` and writes a marker document, so a test sees what ran. */
const recording = (id: string, calls: string[]): Migration => ({
  id,
  up: async (db) => {
    calls.push(`${id} up`);
    await db.collection('markers').insertOne({ id });
  },
  down: async (db) => {
    calls.push(`${id} down`);
    await db.collection('markers').deleteOne({ id });
  },
});

let client: mongo.MongoClient;
let db: mongo.Db;
let calls: string[];
let log: ReturnType<typeof capture>['log'];
let records: ReturnType<typeof capture>['records'];

const ledger = () =>
  db
    .collection(LEDGER)
    .find({}, { projection: { _id: 0 } })
    .sort({ id: 1 })
    .toArray();
const collections = async () => (await db.listCollections().toArray()).map(({ name }) => name).sort();
const up = (migrations: readonly Migration[], dryRun = false) =>
  runMigrations(db, migrations, { direction: 'up', dryRun, log });
const down = (migrations: readonly Migration[], dryRun = false) =>
  runMigrations(db, migrations, { direction: 'down', dryRun, log });

beforeAll(async () => {
  client = await new mongoose.mongo.MongoClient(MONGO_URI).connect();
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  db = client.db(`migrate-${randomUUID()}`);
  calls = [];
  ({ log, records } = capture());
});

afterEach(async () => {
  await db.dropDatabase();
  vi.unstubAllEnvs(); // restoreMocks does not undo vi.stubEnv
});

describe('runMigrations (P18)', () => {
  test('up applies every pending migration once, in id order, and records each in the ledger', async () => {
    const migrations = [recording('M001-first', calls), recording('M002-second', calls)];

    const ran = await up(migrations);

    expect(ran).toEqual(['M001-first', 'M002-second']);
    expect(calls).toEqual(['M001-first up', 'M002-second up']);
    expect(await ledger()).toEqual([
      { id: 'M001-first', appliedAt: expect.any(Date) },
      { id: 'M002-second', appliedAt: expect.any(Date) },
    ]);
  });

  test('a second up is a no-op', async () => {
    const migrations = [recording('M001-first', calls), recording('M002-second', calls)];
    await up(migrations);
    const before = await ledger();

    const ran = await up(migrations);

    expect(ran).toEqual([]);
    expect(calls).toEqual(['M001-first up', 'M002-second up']);
    expect(await ledger()).toEqual(before);
  });

  test('a migration added later is the only one the next up runs', async () => {
    await up([recording('M001-first', calls)]);

    const ran = await up([recording('M001-first', calls), recording('M002-second', calls)]);

    expect(ran).toEqual(['M002-second']);
    expect(calls).toEqual(['M001-first up', 'M002-second up']);
  });

  test('up --dry-run logs the plan and writes nothing: no migration runs and no ledger is created', async () => {
    const ran = await up([recording('M001-first', calls), recording('M002-second', calls)], true);

    expect(ran).toEqual(['M001-first', 'M002-second']);
    expect(calls).toEqual([]);
    expect(await collections()).toEqual([]);
    expect(records()).toEqual([
      expect.objectContaining({ migration: 'M001-first', direction: 'up', dryRun: true, msg: 'migration' }),
      expect.objectContaining({ migration: 'M002-second', direction: 'up', dryRun: true, msg: 'migration' }),
    ]);
  });

  test('a migration that throws stops the run and records nothing for itself; the next run retries it', async () => {
    const failure = new Error('data check failed: 2 case-duplicate emails');
    let broken = true;
    const flaky: Migration = {
      ...recording('M002-flaky', calls),
      up: async (target) => {
        calls.push('M002-flaky up');
        if (broken) throw failure;
        await target.collection('markers').insertOne({ id: 'M002-flaky' });
      },
    };
    const migrations = [recording('M001-first', calls), flaky, recording('M003-third', calls)];

    await expect(up(migrations)).rejects.toBe(failure);
    expect((await ledger()).map(({ id }) => id as string)).toEqual(['M001-first']);
    expect(calls).toEqual(['M001-first up', 'M002-flaky up']);

    broken = false;
    const ran = await up(migrations);

    expect(ran).toEqual(['M002-flaky', 'M003-third']);
    expect((await ledger()).map(({ id }) => id as string)).toEqual([
      'M001-first',
      'M002-flaky',
      'M003-third',
    ]);
  });

  test('down reverts every applied migration in reverse order and removes each from the ledger', async () => {
    const migrations = [recording('M001-first', calls), recording('M002-second', calls)];
    await up(migrations);

    const ran = await down(migrations);

    expect(ran).toEqual(['M002-second', 'M001-first']);
    expect(calls).toEqual(['M001-first up', 'M002-second up', 'M002-second down', 'M001-first down']);
    expect(await ledger()).toEqual([]);
    expect(await db.collection('markers').countDocuments()).toBe(0);
  });

  test('down skips a migration that was never applied', async () => {
    await up([recording('M001-first', calls)]);

    const ran = await down([recording('M001-first', calls), recording('M002-second', calls)]);

    expect(ran).toEqual(['M001-first']);
    expect(calls).toEqual(['M001-first up', 'M001-first down']);
  });

  test('down --dry-run writes nothing', async () => {
    const migrations = [recording('M001-first', calls), recording('M002-second', calls)];
    await up(migrations);
    const before = await ledger();

    const ran = await down(migrations, true);

    expect(ran).toEqual(['M002-second', 'M001-first']);
    expect(calls).toEqual(['M001-first up', 'M002-second up']);
    expect(await ledger()).toEqual(before);
  });

  test('the ledger holds one record per id: a second record of the same id is refused (unique index)', async () => {
    await up([recording('M001-first', calls)]);

    await expect(
      db.collection(LEDGER).insertOne({ id: 'M001-first', appliedAt: new Date() }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  test.each([
    ['a malformed id', ['M1-first'], 'Migration id "M1-first" is not M<NNN>-<slug>'],
    ['an id with no slug', ['M001'], 'Migration id "M001" is not M<NNN>-<slug>'],
    [
      'a duplicate id',
      ['M001-first', 'M001-first'],
      'must be unique and ascending: M001-first then M001-first',
    ],
    [
      'ids out of order',
      ['M002-second', 'M001-first'],
      'must be unique and ascending: M002-second then M001-first',
    ],
  ])('%s is refused before anything touches the database', async (_case, ids, message) => {
    const migrations = ids.map((id) => recording(id, calls));

    await expect(up(migrations)).rejects.toThrow(message);
    await expect(migrationStatus(db, migrations)).rejects.toThrow(message);
    expect(calls).toEqual([]);
    expect(await collections()).toEqual([]);
  });
});

describe('migrationStatus', () => {
  test('lists every migration, in id order, with the time it was applied or null while pending', async () => {
    const migrations = [recording('M001-first', calls), recording('M002-second', calls)];
    await up(migrations.slice(0, 1));
    const [entry] = await ledger();

    expect(await migrationStatus(db, migrations)).toEqual([
      { id: 'M001-first', appliedAt: entry!.appliedAt },
      { id: 'M002-second', appliedAt: null },
    ]);
  });

  test('reads only: a database that never migrated stays empty', async () => {
    expect(await migrationStatus(db, [recording('M001-first', calls)])).toEqual([
      { id: 'M001-first', appliedAt: null },
    ]);
    expect(await collections()).toEqual([]);
  });
});

describe('parseArgs', () => {
  test.each<[string[], Command]>([
    [['migrate', 'up'], { name: 'migrate', direction: 'up', dryRun: false }],
    [['migrate', 'up', '--dry-run'], { name: 'migrate', direction: 'up', dryRun: true }],
    [['migrate', 'down'], { name: 'migrate', direction: 'down', dryRun: false }],
    [['migrate', 'down', '--dry-run'], { name: 'migrate', direction: 'down', dryRun: true }],
    [['migrate', 'status'], { name: 'status' }],
    [['seed'], { name: 'seed' }],
  ])('%j → %o', (args, command) => {
    expect(parseArgs(args)).toEqual(command);
  });

  test.each([
    [[]],
    [['migrate']],
    [['migrate', 'sideways']],
    [['migrate', 'status', '--dry-run']],
    [['migrate', 'up', '--force']],
    [['migrate', 'up', '--dry-run', '--dry-run']],
    [['seed', '--dry-run']],
    [['up']],
  ])('%j is a UsageError', (args) => {
    expect(() => parseArgs(args)).toThrow(UsageError);
  });
});

describe('runCommand', () => {
  const deps = (migrations: readonly Migration[]) => ({ db, log, migrations, seed: seedNotAvailable });

  test('migrate up runs the pending migrations and logs what it ran', async () => {
    const migrations = [recording('M001-first', calls)];

    const code = await runCommand({ name: 'migrate', direction: 'up', dryRun: false }, deps(migrations));

    expect(code).toBe(0);
    expect(calls).toEqual(['M001-first up']);
    expect(records().at(-1)).toMatchObject({ msg: 'migrate up: done', migrations: ['M001-first'] });
  });

  test('migrate up --dry-run logs the plan and that nothing was written', async () => {
    const code = await runCommand(
      { name: 'migrate', direction: 'up', dryRun: true },
      deps([recording('M001-first', calls)]),
    );

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(records().at(-1)).toMatchObject({
      msg: 'migrate up: dry run: nothing written',
      dryRun: true,
      migrations: ['M001-first'],
    });
  });

  test('migrate down with nothing applied logs that there is nothing to migrate', async () => {
    const code = await runCommand(
      { name: 'migrate', direction: 'down', dryRun: false },
      deps([recording('M001-first', calls)]),
    );

    expect(code).toBe(0);
    expect(records().at(-1)).toMatchObject({ msg: 'migrate down: nothing to migrate', migrations: [] });
  });

  test('status logs one line per migration, then the counts', async () => {
    const migrations = [recording('M001-first', calls), recording('M002-second', calls)];
    await up(migrations.slice(0, 1));
    ({ log, records } = capture());

    const code = await runCommand({ name: 'status' }, deps(migrations));

    expect(code).toBe(0);
    expect(records()).toEqual([
      expect.objectContaining({ msg: 'applied', migration: 'M001-first', appliedAt: expect.any(String) }),
      expect.objectContaining({ msg: 'pending', migration: 'M002-second', appliedAt: null }),
      expect.objectContaining({ msg: 'migrate status', applied: 1, pending: 1 }),
    ]);
  });

  test('a migration that throws rejects the command', async () => {
    const failure = new Error('data check failed');
    const failing: Migration = { ...recording('M001-first', calls), up: () => Promise.reject(failure) };

    await expect(
      runCommand({ name: 'migrate', direction: 'up', dryRun: false }, deps([failing])),
    ).rejects.toBe(failure);
  });

  test('seed runs the injected seed and exits with its code', async () => {
    const seed = vi.fn(() => Promise.resolve(0));

    expect(await runCommand({ name: 'seed' }, { ...deps([]), seed })).toBe(0);
    expect(seed).toHaveBeenCalledWith(db, log);
  });

  test('the seed stub (until T4.4) refuses: exit code 1 and an error line', async () => {
    expect(await runCommand({ name: 'seed' }, deps([]))).toBe(1);
    expect(records()).toEqual([
      expect.objectContaining({ level: 50, msg: 'seed: the first-admin seed is not available yet' }),
    ]);
  });
});

describe('main (the CLI process)', () => {
  const useDatabase = () => vi.stubEnv('MONGO_CLOUD', `${MONGO_URI}cli-${randomUUID()}`);

  test('the migration list is empty until T4.4 adds M001–M004', () => {
    expect(MIGRATIONS).toEqual([]);
  });

  test('a usage error prints the usage and exits 2, before it reads the config or connects', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const connect = vi.spyOn(mongoose, 'connect');

    expect(await main(['migrate', 'sideways'])).toBe(2); // MONGO_CLOUD is unset: loading the config would throw

    expect(stderr).toHaveBeenCalledWith(`Unknown command: migrate sideways\n${USAGE}\n`);
    expect(connect).not.toHaveBeenCalled();
  });

  test('migrate status connects with autoIndex off, exits 0 and disconnects', async () => {
    useDatabase();
    const connect = vi.spyOn(mongoose, 'connect');

    expect(await main(['migrate', 'status'])).toBe(0);

    expect(connect).toHaveBeenCalledWith(
      process.env.MONGO_CLOUD,
      expect.objectContaining({ autoIndex: false }),
    );
    expect(mongoose.connection.readyState).toBe(mongoose.ConnectionStates.disconnected);
  });

  test('a command that fails exits 1 and still disconnects', async () => {
    useDatabase();
    vi.spyOn(mongoose.mongo.Collection.prototype, 'find').mockImplementation(() => {
      throw new Error('simulated database failure');
    });

    expect(await main(['migrate', 'status'])).toBe(1);

    expect(mongoose.connection.readyState).toBe(mongoose.ConnectionStates.disconnected);
  });

  test('seed exits 1 until T4.4 wires the first-admin seed', async () => {
    useDatabase();

    expect(await main(['seed'])).toBe(1);
  });

  test('an invalid environment rejects with the ConfigError, before connecting', async () => {
    const connect = vi.spyOn(mongoose, 'connect');

    await expect(main(['migrate', 'status'])).rejects.toThrow(/→ at MONGO_CLOUD/);
    expect(connect).not.toHaveBeenCalled();
  });
});
