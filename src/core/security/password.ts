import bcrypt from 'bcrypt';
import { z } from 'zod';

/** SEC-16: bcrypt reads only the first 72 bytes of a password (UTF-8), so longer ones collide on their prefix. */
export const MAX_PASSWORD_BYTES = 72;

/**
 * P26: the one rule for every password the API sets (sign-up, self-update, password change). It counts bytes, not
 * characters: a 20-emoji password is 40 UTF-16 units but 80 bytes, and bcrypt would silently drop the last 8 [P4].
 */
export const passwordPolicy = z
  .string()
  .min(8)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES, {
    message: `must be at most ${MAX_PASSWORD_BYTES} bytes (bcrypt only uses the first ${MAX_PASSWORD_BYTES})`,
  });

// A hash bcrypt really does work on ($2a$/$2b$, cost 04-31). Anything else (no password at all on a Google-only
// account, a placeholder, garbage) would fail instantly and reveal the account, so it is compared against a dummy.
const BCRYPT_HASH = /^\$2[ab]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;

export const isUsableHash = (hash: unknown): hash is string =>
  typeof hash === 'string' && BCRYPT_HASH.test(hash);

/** The cost a usable hash was made at ($2b$<cost>$…). */
export const costOf = (hash: string): number => Number(hash.slice(4, 6));

/** ADR-035: a hash made at another cost than the configured one is rehashed after a successful login (P25). */
export const needsRehash = (hash: string, cost: number): boolean => costOf(hash) !== cost;

/** PERF-01 (P24): the only way the API hashes a password: asynchronously, at the configured cost. */
export const hashPassword = (password: string, cost: number): Promise<string> => bcrypt.hash(password, cost);

/**
 * F1 (P24): exactly one bcrypt compare, whatever the account stores: the stored hash when it is a usable one, else
 * `dummy`. The caller must still refuse an account whose hash is not usable, whatever this returns.
 */
export const comparePassword = (password: string, hash: unknown, dummy: string): Promise<boolean> =>
  bcrypt.compare(password, isUsableHash(hash) ? hash : dummy);
