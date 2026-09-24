import { NotFoundError } from '../../core/errors';
import type { Logger } from '../../core/logger';
import { ownAssetUrl, publicIdOf, type MediaClient } from './cloudinary.client';
import type { MediaCollection } from './media.schemas';

/** The one field media owns on a user or a product; their modules own the rest of the record. */
export interface ImageRecord {
  image?: string | null;
}

interface ActiveFilter {
  _id: string;
  state: true;
}

/** What media needs of the User and Product models. The composition root injects them (ADR-005, ADR-027). */
export interface ImageRecordModel {
  exists(filter: ActiveFilter): PromiseLike<unknown>;
  findOne(filter: ActiveFilter, projection: 'image'): PromiseLike<ImageRecord | null>;
  findOneAndUpdate(
    filter: ActiveFilter,
    update: { image: string },
    options: { returnDocument: 'before' },
  ): PromiseLike<ImageRecord | null>;
}
export type ImageModels = (name: 'User' | 'Product') => ImageRecordModel;

/** req.log: the lines below are the ones controllers/uploads.js wrote (LOG-01). */
export type MediaLog = Pick<Logger, 'error' | 'warn'>;

export interface MediaService {
  replaceImage(
    collection: MediaCollection,
    id: string,
    filePath: string,
    log: MediaLog,
  ): Promise<ImageRecord>;
  /** The own-cloud URL to redirect to (AM-M3-1); anything else is a 404. */
  imageUrl(collection: MediaCollection, id: string): Promise<string>;
}

const MODEL_NAMES = { user: 'User', product: 'Product' } as const;
const NOT_FOUND = { user: 'User not found', product: 'Product not found' } as const;
const ORPHANED = 'orphaned Cloudinary asset: the record was not saved';

/** The media rules (ADR-030): Cloudinary is the only store. Throws AppErrors; knows nothing of HTTP. */
export function createMediaService(deps: {
  models: ImageModels;
  client: MediaClient;
  cloudName: string;
}): MediaService {
  const { models, client, cloudName } = deps;
  const active = (id: string): ActiveFilter => ({ _id: id, state: true });

  return {
    async replaceImage(collection, id, filePath, log) {
      const Model = models(MODEL_NAMES[collection]);
      // find-active-or-404 first: nothing reaches Cloudinary for a missing or soft-deleted record.
      if (!(await Model.exists(active(id)))) throw new NotFoundError(NOT_FOUND[collection]);

      const { secureUrl } = await client.upload(filePath);

      // C11: upload → save → destroy. One atomic swap stores the new URL and returns the record as it was, so
      // the asset destroyed below is exactly the one this request replaced, even when replacements race.
      let record: ImageRecord | null;
      try {
        record = await Model.findOneAndUpdate(active(id), { image: secureUrl }, { returnDocument: 'before' });
      } catch (err) {
        log.error({ asset: secureUrl, collection, id }, ORPHANED);
        throw err;
      }
      if (!record) {
        // soft-deleted between the check and the swap: the new asset belongs to nothing
        log.error({ asset: secureUrl, collection, id }, ORPHANED);
        throw new NotFoundError(NOT_FOUND[collection]);
      }

      const previous = ownAssetUrl(record.image, cloudName);
      record.image = secureUrl; // the record as stored now: the swap changed nothing else
      // Only an asset of this app's own cloud is ever destroyed: a Google avatar or a legacy filename is left alone.
      const publicId = previous && publicIdOf(previous);
      if (publicId) {
        try {
          await client.destroy(publicId);
        } catch (err) {
          // a stale previous image must not fail an update that already succeeded
          log.warn({ err, asset: previous }, 'previous Cloudinary asset not destroyed');
        }
      }
      return record;
    },

    async imageUrl(collection, id) {
      const record = await models(MODEL_NAMES[collection]).findOne(active(id), 'image');
      if (!record) throw new NotFoundError(NOT_FOUND[collection]);
      const url = ownAssetUrl(record.image, cloudName);
      if (!url) throw new NotFoundError('Image not found');
      return url;
    },
  };
}
