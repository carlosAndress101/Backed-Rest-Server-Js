import type { Config } from '../config';
import type { Logger } from '../core/logger';
import { MAX_PASSWORD_BYTES, hashPassword } from '../core/security/password';

export const MIN_PASSWORD_LENGTH = 8;

/** The first admin, as the seed creates it. */
export interface NewAdmin {
  name: string;
  email: string;
  password: string;
  role: 'ADMIN_ROLE';
  state: true;
  google: false;
  tokenVersion: 0;
}

/** The slice of the User model the seed uses. src/cli.ts injects UserModel (AM-M4-7): src/database imports no module. */
export interface SeedUserModel {
  exists(filter: Record<string, unknown>): PromiseLike<{ _id: unknown } | null>;
  create(admin: NewAdmin): Promise<{ _id: unknown }>;
}

export interface SeedDeps {
  readonly User: SeedUserModel;
  /** config.seed (D-14). The password is never logged, whatever happens (P20). */
  readonly config: Config['seed'];
  /** config.auth.bcryptCost (ADR-035, AM-M5-11): the admin's hash is made like every other one. */
  readonly bcryptCost: number;
  readonly log: Logger;
}

export type SeedResult =
  | { readonly created: true; readonly id: string }
  | {
      readonly created: false;
      readonly reason: 'not-configured' | 'weak-password' | 'admin-exists' | 'email-exists';
    };

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

/**
 * M4 design §6: creates the first administrator from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD, and only that. It is
 * create-only (never an upsert or an update, so no existing user changes), idempotent, and refuses a weak password
 * or an instance that already has an active admin. Run only by `pnpm seed`, never on boot.
 */
export async function seedFirstAdmin({ User, config, bcryptCost, log }: SeedDeps): Promise<SeedResult> {
  const email = config.adminEmail?.trim().toLowerCase();
  const password = config.adminPassword;

  if (!email || !password) {
    log.warn('seed: SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are not both set; no admin was created');
    return { created: false, reason: 'not-configured' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    log.error(
      `seed: SEED_ADMIN_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters; refusing to create an admin`,
    );
    return { created: false, reason: 'weak-password' };
  }
  // SEC-16 (AM-M5-11): bcrypt reads only the first 72 bytes, so a longer password would work truncated.
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    log.error(
      `seed: SEED_ADMIN_PASSWORD is longer than ${MAX_PASSWORD_BYTES} bytes; refusing to create an admin`,
    );
    return { created: false, reason: 'weak-password' };
  }

  const admin = await User.exists({ role: 'ADMIN_ROLE', state: true });
  if (admin) {
    log.info({ id: String(admin._id) }, 'seed: an active admin already exists; nothing to do');
    return { created: false, reason: 'admin-exists' };
  }
  // A user already holding the email is left exactly as it is: the seed never promotes or rewrites anyone.
  if (await User.exists({ email })) {
    log.warn('seed: the configured email belongs to an existing user, left untouched; no admin was created');
    return { created: false, reason: 'email-exists' };
  }

  try {
    const created = await User.create({
      name: 'Administrator',
      email,
      password: await hashPassword(password, bcryptCost),
      role: 'ADMIN_ROLE',
      state: true,
      google: false,
      tokenVersion: 0,
    });
    const id = String(created._id);
    log.info({ id }, 'seed: first admin created');
    return { created: true, id };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Another seed run, or a sign-up, took the email between the check and the insert.
    log.warn('seed: the configured email was taken meanwhile; no admin was created');
    return { created: false, reason: 'email-exists' };
  }
}
