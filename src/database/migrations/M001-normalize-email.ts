import type { mongo } from 'mongoose';

import type { Migration } from '../migrate';

// The email as M001 stores it: trimmed and lowercased, exactly as the aggregation below computes it.
const NORMALIZED_EMAIL = { $toLower: { $trim: { input: { $ifNull: ['$email', ''] } } } };

/** Drops an index when it exists; a missing index or collection is already the wanted state. */
const dropIndexIfExists = async (collection: mongo.Collection, name: string): Promise<void> => {
  await collection.dropIndex(name).catch((err: { code?: number }) => {
    if (err.code !== 26 && err.code !== 27) throw err; // NamespaceNotFound, IndexNotFound
  });
};

/**
 * M4 design §5.3: lowercase and trim every stored email, then build the users catalogue of §3.1: `email_1`, a plain
 * unique index that is case-insensitive because the field is lowercased, and `state_1`.
 * Down is lossy: the original casing is only in the backup (§7.4).
 */
export const M001: Migration = {
  id: 'M001-normalize-email',

  async up(db, log) {
    const users = db.collection('users');

    // 1. Abort, before any write, when two emails would collide once normalized (P18).
    const duplicates = await users
      .aggregate<{ ids: mongo.ObjectId[] }>([
        { $group: { _id: NORMALIZED_EMAIL, ids: { $push: '$_id' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();
    if (duplicates.length > 0) {
      throw new Error(
        `M001 aborted: ${duplicates.length} group(s) of users share an email once it is lowercased and trimmed. ` +
          `Resolve them first (user ids per group): ${JSON.stringify(duplicates.map(({ ids }) => ids))}`,
      );
    }

    // 2. Normalize in one pipeline update. Only string emails: a missing one is left for the schema to reject.
    const { modifiedCount } = await users.updateMany({ email: { $type: 'string' } }, [
      { $set: { email: NORMALIZED_EMAIL } },
    ]);

    // 3. Rebuild the catalogue from its exact definitions, whatever an earlier index of the same name was.
    await dropIndexIfExists(users, 'email_1');
    await users.createIndex({ email: 1 }, { name: 'email_1', unique: true });
    await dropIndexIfExists(users, 'state_1');
    await users.createIndex({ state: 1 }, { name: 'state_1' });
    log.info({ modified: modifiedCount }, 'M001: emails normalized; email_1 and state_1 built');
  },

  async down(db, log) {
    const users = db.collection('users');
    // The 2.x index set: the unique email_1 (2.x had the same definition, so it stays) and no state_1.
    await dropIndexIfExists(users, 'state_1');
    await users.createIndex({ email: 1 }, { name: 'email_1', unique: true });
    log.warn('M001 down: state_1 dropped; email casing is NOT restored (lossy). Only the backup has it');
  },
};
