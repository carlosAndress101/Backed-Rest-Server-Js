import type { Migration } from '../migrate';

// Frozen with this migration (the ROLES of 3.0.0, ADR-007): a later change to the code enum must not change what
// M004 accepted when it ran.
const ROLES = ['ADMIN_ROLE', 'USER_ROLE', 'VENTAS_ROLE'];

/**
 * M4 design §5.3: roles are a code enum since M3 (ADR-007), so the 2.x `roles` collection goes. It is the one
 * destructive migration and runs last. Down recreates its three constant documents (with new _ids: nothing ever
 * referenced a role by id), so the result is equivalent to what was dropped.
 */
export const M004: Migration = {
  id: 'M004-drop-roles-collection',

  async up(db, log) {
    // 1. Abort while any user holds a role outside the enum: it must be mapped first (P18).
    const unknown = await db.collection('users').distinct('role', { role: { $exists: true, $nin: ROLES } });
    if (unknown.length > 0) {
      throw new Error(
        `M004 aborted: users hold role value(s) outside ${ROLES.join(', ')}: ${JSON.stringify(unknown)}. ` +
          'Map them before the roles collection is dropped',
      );
    }

    // 2. Drop the collection; one that is already gone is the wanted state.
    const existed = (await db.listCollections({ name: 'roles' }, { nameOnly: true }).toArray()).length > 0;
    if (existed) await db.collection('roles').drop();
    log.info({ dropped: existed }, 'M004: the 2.x roles collection is gone (roles are a code enum, ADR-007)');
  },

  async down(db, log) {
    // Upserts, so a second run adds nothing: the 2.x collection had no unique index on `role`.
    const roles = db.collection('roles');
    for (const role of ROLES) await roles.updateOne({ role }, { $setOnInsert: { role } }, { upsert: true });
    log.info('M004 down: the roles collection recreated with its three constant documents');
  },
};
