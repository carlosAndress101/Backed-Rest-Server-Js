// The database CLI (M4 design §5.2, §10.2): `migrate up|down|status [--dry-run]` and `seed`. Production runs it
// compiled, as `node dist/cli.js …`, exactly like dist/server.js (P19). Like src/server.ts it is a composition root
// (AM-M4-7): it may wire the modules' models into src/database, which imports no module.
import mongoose, { type mongo } from 'mongoose';

import { loadConfig } from './config';
import { createLogger, type Logger } from './core/logger';
import { connectDatabase, disconnectDatabase } from './database/connection';
import { migrationStatus, runMigrations, type Direction, type Migration } from './database/migrate';
import { M001 } from './database/migrations/M001-normalize-email';
import { M002 } from './database/migrations/M002-rebuild-name-indexes';
import { M003 } from './database/migrations/M003-backfill-created-at';
import { M004 } from './database/migrations/M004-drop-roles-collection';

export const USAGE = 'Usage: cli.js migrate up|down [--dry-run] | cli.js migrate status | cli.js seed';

export type Command =
  | { readonly name: 'migrate'; readonly direction: Direction; readonly dryRun: boolean }
  | { readonly name: 'status' }
  | { readonly name: 'seed' };

export class UsageError extends Error {
  override name = 'UsageError';
}

export interface CliDeps {
  readonly db: mongo.Db;
  readonly log: Logger;
  readonly migrations: readonly Migration[];
  /** Runs the first-admin seed and resolves to the exit code. */
  readonly seed: (db: mongo.Db, log: Logger) => Promise<number>;
}

/** The migrations `migrate` runs, in id order (M4 design §5.3). M004 is the one destructive step and runs last. */
export const MIGRATIONS: readonly Migration[] = [M001, M002, M003, M004];

/** The `seed` command until T4.4 wires the first-admin seed (§6): it refuses, so nothing looks seeded. */
export const seedNotAvailable = (_db: mongo.Db, log: Logger): Promise<number> => {
  log.error('seed: the first-admin seed is not available yet');
  return Promise.resolve(1);
};

export function parseArgs(args: readonly string[]): Command {
  const [command, action, ...flags] = args;
  if (command === 'seed' && args.length === 1) return { name: 'seed' };
  if (command === 'migrate' && action === 'status' && flags.length === 0) return { name: 'status' };
  const dryRun = flags.length === 1 && flags[0] === '--dry-run';
  if (command === 'migrate' && (action === 'up' || action === 'down') && (flags.length === 0 || dryRun))
    return { name: 'migrate', direction: action, dryRun };
  throw new UsageError(`Unknown command: ${args.join(' ') || '(none)'}`);
}

/** Runs one command against an open database and resolves to the process exit code. */
export async function runCommand(command: Command, { db, log, migrations, seed }: CliDeps): Promise<number> {
  switch (command.name) {
    case 'migrate': {
      const { direction, dryRun } = command;
      const ran = await runMigrations(db, migrations, { direction, dryRun, log });
      const outcome = ran.length === 0 ? 'nothing to migrate' : dryRun ? 'dry run: nothing written' : 'done';
      log.info({ direction, dryRun, migrations: ran }, `migrate ${direction}: ${outcome}`);
      return 0;
    }
    case 'status': {
      const states = await migrationStatus(db, migrations);
      for (const { id, appliedAt } of states)
        log.info({ migration: id, appliedAt }, appliedAt ? 'applied' : 'pending');
      const applied = states.filter((state) => state.appliedAt).length;
      log.info({ applied, pending: states.length - applied }, 'migrate status');
      return 0;
    }
    case 'seed':
      return seed(db, log);
  }
}

/** The process: parse, load the config, connect, run, always disconnect. Resolves to the exit code. */
export async function main(args: readonly string[]): Promise<number> {
  let command: Command;
  try {
    command = parseArgs(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  const config = loadConfig(); // a ConfigError lists variable names, never their values (P20)
  const log = createLogger(config);
  // Only the migrations build indexes, after their data checks: never Mongoose behind their back (§10.1).
  await connectDatabase(config.mongoUri, { autoIndex: false });
  try {
    const deps = { db: mongoose.connection.db!, log, migrations: MIGRATIONS, seed: seedNotAvailable };
    return await runCommand(command, deps);
  } catch (err) {
    log.error({ err }, 'command failed'); // a migration that threw is not recorded, so the next run retries it
    return 1;
  } finally {
    await disconnectDatabase();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // No logger yet (invalid config) or no database: plain stderr, non-zero exit, as src/server.ts does.
      // eslint-disable-next-line no-console
      console.error(error);
      process.exitCode = 1;
    },
  );
}
