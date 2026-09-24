import type { mongo } from 'mongoose';

import type { Migration } from '../migrate';

const COLLECTIONS = ['categories', 'products'] as const;
// The duplicate check of §3.1: names compare case-insensitively (en, strength 2), as the index compares them.
const NAME_COLLATION = { locale: 'en', strength: 2 };
const M4_INDEXES = ['name_active_unique', 'state_1', 'user_1', 'category_1'];

/** Drops an index when it exists; a missing index or collection is already the wanted state. */
const dropIndexIfExists = async (collection: mongo.Collection, name: string): Promise<void> => {
  await collection.dropIndex(name).catch((err: { code?: number }) => {
    if (err.code !== 26 && err.code !== 27) throw err; // NamespaceNotFound, IndexNotFound
  });
};

/** The groups of documents that share a name under `collation`, among those `match` selects. */
const duplicateNames = async (
  db: mongo.Db,
  match: mongo.Document,
  collation?: mongo.CollationOptions,
): Promise<{ collection: string; ids: mongo.ObjectId[] }[]> => {
  const found = [];
  for (const collection of COLLECTIONS) {
    const groups = await db
      .collection(collection)
      .aggregate<{ ids: mongo.ObjectId[] }>(
        [
          { $match: match },
          { $group: { _id: '$name', ids: { $push: '$_id' }, count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
        ],
        collation ? { collation } : {},
      )
      .toArray();
    found.push(...groups.map(({ ids }) => ({ collection, ids })));
  }
  return found;
};

/**
 * M4 design §5.3: replace the 2.x all-states unique `name_1` of categories and products with the partial, collated
 * `name_active_unique` (a soft-deleted name is reusable, case variants collide) and build their supporting indexes,
 * so each collection holds exactly its §3.1 catalogue. Down restores `name_1`, and aborts if the data no longer
 * allows it.
 */
export const M002: Migration = {
  id: 'M002-rebuild-name-indexes',

  async up(db, log) {
    // 1. Abort before any index changes in either collection: active names that the new index would refuse (P18).
    const duplicates = await duplicateNames(db, { state: true }, NAME_COLLATION);
    if (duplicates.length > 0) {
      throw new Error(
        `M002 aborted: ${duplicates.length} group(s) of active documents share a name, ignoring case. ` +
          `Rename or soft-delete them first: ${JSON.stringify(duplicates)}`,
      );
    }

    for (const name of COLLECTIONS) {
      const collection = db.collection(name);
      // 2. The 2.x name_1 is not in the catalogue; the M4 indexes are rebuilt from their exact definitions.
      for (const index of ['name_1', ...M4_INDEXES]) await dropIndexIfExists(collection, index);
      await collection.createIndex(
        { name: 1 },
        {
          name: 'name_active_unique',
          unique: true,
          collation: NAME_COLLATION,
          partialFilterExpression: { state: true },
        },
      );
      await collection.createIndex({ state: 1 }, { name: 'state_1' });
      if (name === 'products') await collection.createIndex({ category: 1 }, { name: 'category_1' });
      await collection.createIndex({ user: 1 }, { name: 'user_1' });
      log.info({ collection: name }, 'M002: name_1 replaced by name_active_unique; supporting indexes built');
    }
  },

  async down(db, log) {
    // The 2.x unique name_1 counts every state and every case exactly: abort before dropping anything if it can't
    // build (a soft-deleted name that is in use again, allowed since M002).
    const duplicates = await duplicateNames(db, {});
    if (duplicates.length > 0) {
      throw new Error(
        `M002 down aborted: ${duplicates.length} group(s) of documents share a name, so the 2.x unique name_1 ` +
          `cannot be built. Resolve them or restore the backup: ${JSON.stringify(duplicates)}`,
      );
    }
    for (const name of COLLECTIONS) {
      const collection = db.collection(name);
      for (const index of M4_INDEXES) await dropIndexIfExists(collection, index);
      await collection.createIndex({ name: 1 }, { name: 'name_1', unique: true });
      log.info({ collection: name }, 'M002 down: the 2.x name_1 restored');
    }
  },
};
