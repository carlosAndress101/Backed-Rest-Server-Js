// The CLI (M4 design §5.2, AM-M4-7): argument parsing, each command against an open database, and the process
// (config → connect with autoIndex off → run → disconnect → exit code), against the run's in-memory mongod.
import { randomUUID } from 'node:crypto';

import mongoose, { type mongo } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, test, vi } from 'vitest';

import {
  MIGRATIONS,
  USAGE,
  UsageError,
  main,
  parseArgs,
  runCommand,
  seedNotAvailable,
  type Command,
} from '../../src/cli';
import { createLogger } from '../../src/core/logger';
import { runMigrations, type Migration } from '../../src/database/migrate';

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

const up = (migrations: readonly Migration[]) => runMigrations(db, migrations, { direction: 'up', log });

beforeAll(async () => {
  client = await new mongoose.mongo.MongoClient(MONGO_URI).connect();
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  db = client.db(`cli-${randomUUID()}`);
  calls = [];
  ({ log, records } = capture());
});

afterEach(async () => {
  await db.dropDatabase();
  vi.unstubAllEnvs(); // restoreMocks does not undo vi.stubEnv
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

  test('migrate runs the M4 list, M001–M004 in id order', () => {
    expect(MIGRATIONS.map(({ id }) => id)).toEqual([
      'M001-normalize-email',
      'M002-rebuild-name-indexes',
      'M003-backfill-created-at',
      'M004-drop-roles-collection',
    ]);
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
