import type { mongo } from 'mongoose';

import type { Logger } from '../core/logger';

/** One schema or data change (M4 design §5.2–§5.3). Every `up` checks the data and throws before it writes. */
export interface Migration {
  /** `M<NNN>-<slug>`, e.g. 'M001-normalize-email'. Migrations run in id order. */
  readonly id: string;
  up(db: mongo.Db, log: Logger): Promise<void>;
  down(db: mongo.Db, log: Logger): Promise<void>;
}

export type Direction = 'up' | 'down';

export interface RunOptions {
  readonly direction: Direction;
  /** Logs the plan and writes nothing: no migration runs and the ledger is left as it is. */
  readonly dryRun?: boolean;
  readonly log: Logger;
}

export interface MigrationState {
  readonly id: string;
  /** When `up` was recorded; null while the migration is pending. */
  readonly appliedAt: Date | null;
}

/** The ledger: one document per applied migration. */
export const LEDGER = 'migrations';
const ID_PATTERN = /^M\d{3}-[a-z0-9-]+$/;

interface LedgerEntry {
  id: string;
  appliedAt: Date;
}

/** Refuses a list whose ids are malformed, duplicated or out of order, before anything touches the database. */
export function assertOrdered(migrations: readonly Migration[]): void {
  migrations.forEach(({ id }, index) => {
    if (!ID_PATTERN.test(id)) throw new Error(`Migration id ${JSON.stringify(id)} is not M<NNN>-<slug>`);
    const previous = migrations[index - 1]?.id;
    if (previous !== undefined && previous >= id)
      throw new Error(`Migration ids must be unique and ascending: ${previous} then ${id}`);
  });
}

const readLedger = async (db: mongo.Db): Promise<Map<string, Date>> => {
  const entries = await db.collection<LedgerEntry>(LEDGER).find({}).toArray();
  return new Map(entries.map((entry) => [entry.id, entry.appliedAt]));
};

/**
 * Runs every pending migration (`up`, in id order) or reverts every applied one (`down`, in reverse order) and
 * returns the ids it ran. A migration that throws stops the run and is not recorded, so the next run retries it
 * (P18). Assumes one app instance migrates at a time: a lock is an M9 item.
 */
export async function runMigrations(
  db: mongo.Db,
  migrations: readonly Migration[],
  { direction, dryRun = false, log }: RunOptions,
): Promise<string[]> {
  assertOrdered(migrations);
  const applied = await readLedger(db);
  const plan =
    direction === 'up'
      ? migrations.filter((migration) => !applied.has(migration.id))
      : [...migrations].reverse().filter((migration) => applied.has(migration.id));

  const ledger = db.collection<LedgerEntry>(LEDGER);
  if (!dryRun && plan.length > 0) await ledger.createIndex({ id: 1 }, { unique: true });
  for (const migration of plan) {
    log.info({ migration: migration.id, direction, dryRun }, 'migration');
    if (dryRun) continue;
    await migration[direction](db, log);
    if (direction === 'up') await ledger.insertOne({ id: migration.id, appliedAt: new Date() });
    else await ledger.deleteOne({ id: migration.id });
  }
  return plan.map((migration) => migration.id);
}

/** Each known migration with the time it was applied, in id order; reads only. */
export async function migrationStatus(
  db: mongo.Db,
  migrations: readonly Migration[],
): Promise<MigrationState[]> {
  assertOrdered(migrations);
  const applied = await readLedger(db);
  return migrations.map(({ id }) => ({ id, appliedAt: applied.get(id) ?? null }));
}
