import type { Migration } from '../migrate';

/**
 * M5 design §4.1: give every 2.x user document the `tokenVersion: 0` the M4 schema defaults. [P3] A hydrated
 * Mongoose read already defaults a missing `tokenVersion` to 0, so this is defence-in-depth for raw-driver and
 * `.lean()` reads, not a correctness requirement of the app today. Purely additive, like M003: no abort check.
 */
export const M005: Migration = {
  id: 'M005-backfill-token-version',

  async up(db, log) {
    const { modifiedCount } = await db
      .collection('users')
      .updateMany({ tokenVersion: { $exists: false } }, { $set: { tokenVersion: 0 } });
    log.info({ modified: modifiedCount }, 'M005: tokenVersion backfilled to 0 where absent');
  },

  async down(db, log) {
    // Exact and safe: only removes what this migration itself would have set, on documents that still show 0.
    // A document whose tokenVersion has since been bumped by a real logout-all/password-change keeps its value.
    await db.collection('users').updateMany({ tokenVersion: 0 }, { $unset: { tokenVersion: '' } });
    log.warn('M005 down: tokenVersion unset on documents left at 0 (a real bump since up is not reverted)');
  },
};
