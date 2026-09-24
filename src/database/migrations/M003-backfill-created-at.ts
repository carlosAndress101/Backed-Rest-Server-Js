import type { Migration } from '../migrate';

const COLLECTIONS = ['users', 'categories', 'products'] as const;

/**
 * M4 design §5.3: give every 2.x document the timestamps M4 writes (`timestamps: true`). The best creation time a
 * 2.x document has is its ObjectId's (P5); `updatedAt` starts equal to it. Documents that already carry a
 * timestamp keep it. Down removes both fields; it is exact only while no M4 code has written since `up` (the 2.x
 * code ignores them either way).
 */
export const M003: Migration = {
  id: 'M003-backfill-created-at',

  async up(db, log) {
    // A backfill has nothing to check: every document has an _id, and no existing value is overwritten.
    for (const name of COLLECTIONS) {
      const { modifiedCount } = await db
        .collection(name)
        .updateMany({ $or: [{ createdAt: { $exists: false } }, { updatedAt: { $exists: false } }] }, [
          {
            $set: {
              createdAt: { $ifNull: ['$createdAt', { $toDate: '$_id' }] },
              updatedAt: { $ifNull: ['$updatedAt', { $toDate: '$_id' }] },
            },
          },
        ]);
      log.info(
        { collection: name, modified: modifiedCount },
        'M003: timestamps backfilled from the ObjectId',
      );
    }
  },

  async down(db, log) {
    for (const name of COLLECTIONS) {
      const { modifiedCount } = await db
        .collection(name)
        .updateMany({}, { $unset: { createdAt: '', updatedAt: '' } });
      log.info({ collection: name, modified: modifiedCount }, 'M003 down: timestamps removed');
    }
  },
};
