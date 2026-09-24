import type { Migration } from '../migrate';

/**
 * M5 design §4.2: 2.x stored the literal `':D'` as the password of every Google-only account; M5 makes `password`
 * optional for them. The filter is exact (`{ google: true, password: ':D' }`), so a hybrid account that already
 * has a real bcrypt hash never matches and nothing ambiguous can be dropped. No abort check is needed.
 */
export const M006: Migration = {
  id: 'M006-drop-google-placeholder-password',

  async up(db, log) {
    const { modifiedCount } = await db
      .collection('users')
      .updateMany({ google: true, password: ':D' }, { $unset: { password: '' } });
    log.info({ modified: modifiedCount }, "M006: the ':D' placeholder removed from Google-only accounts");
  },

  async down(db, log) {
    // Best-effort, like M001's lossy down: restores the placeholder on every Google account that currently has
    // no password, on the assumption that this migration is what removed it (true unless a later, unrelated
    // change also produced a passwordless Google account — negligible before M006 exists).
    await db
      .collection('users')
      .updateMany({ google: true, password: { $exists: false } }, { $set: { password: ':D' } });
    log.warn("M006 down: the ':D' placeholder restored on every passwordless Google account");
  },
};
