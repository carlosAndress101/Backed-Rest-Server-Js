// The media rules (M3 design §5.5, ADR-030, AM-M3-1) against in-memory records and a fake client: no database,
// no network, no vi.mock (ADR-023).
import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest';

import { NotFoundError } from '../../../src/core/errors';
import type { MediaClient } from '../../../src/modules/media/cloudinary.client';
import {
  createMediaService,
  type ImageRecord,
  type ImageRecordModel,
} from '../../../src/modules/media/media.service';

interface Row {
  _id: string;
  state: boolean;
  image?: string;
}

const ID = '64b7f0c2a1b2c3d4e5f60718';
const NEW_URL = 'https://res.cloudinary.com/demo/image/upload/v1700000000/new-image.png';
const OWN_URL = 'https://res.cloudinary.com/demo/image/upload/v1690000000/shop/avatar.jpg';
const ORPHANED = 'orphaned Cloudinary asset: the record was not saved';

/** One collection's records, recording each call in the shared `events` so the tests can check the order. */
class FakeRecords implements ImageRecordModel {
  readonly rows = new Map<string, Row>();

  constructor(private readonly events: string[]) {}

  async exists(filter: { _id: string; state: true }) {
    const row = this.rows.get(filter._id);
    return row?.state === filter.state ? { _id: row._id } : null;
  }

  async findOne(filter: { _id: string; state: true }): Promise<ImageRecord | null> {
    const row = this.rows.get(filter._id);
    return row?.state === filter.state ? { ...row } : null;
  }

  async findOneAndUpdate(
    filter: { _id: string; state: true },
    update: { image: string },
  ): Promise<ImageRecord | null> {
    this.events.push('swap');
    const row = this.rows.get(filter._id);
    if (row?.state !== filter.state) return null;
    const before = { ...row };
    row.image = update.image;
    return before;
  }
}

describe('createMediaService', () => {
  let events: string[];
  let users: FakeRecords;
  let products: FakeRecords;
  let client: { upload: Mock<MediaClient['upload']>; destroy: Mock<MediaClient['destroy']> };
  let log: { error: Mock; warn: Mock };
  let service: ReturnType<typeof createMediaService>;

  const seed = (records: FakeRecords, row: Partial<Row> = {}) =>
    records.rows.set(ID, { _id: ID, state: true, ...row });

  beforeEach(() => {
    events = [];
    users = new FakeRecords(events);
    products = new FakeRecords(events);
    client = {
      upload: vi.fn<MediaClient['upload']>(async () => {
        events.push('upload');
        return { secureUrl: NEW_URL };
      }),
      destroy: vi.fn<MediaClient['destroy']>(async () => {
        events.push('destroy');
      }),
    };
    log = { error: vi.fn(), warn: vi.fn() };
    service = createMediaService({
      User: users,
      Product: products,
      client,
      cloudName: 'demo',
    });
  });

  const replace = (collection: 'user' | 'product' = 'user') =>
    service.replaceImage(collection, ID, '/tmp/upload-1/tmp-1', log);

  describe('replaceImage', () => {
    test('C11: uploads, stores the new URL, then destroys the own-cloud asset it replaced', async () => {
      seed(users, { image: OWN_URL });

      const record = await replace();

      expect(events).toEqual(['upload', 'swap', 'destroy']);
      expect(client.upload).toHaveBeenCalledWith('/tmp/upload-1/tmp-1');
      expect(client.destroy).toHaveBeenCalledWith('shop/avatar');
      expect(record).toEqual({ _id: ID, state: true, image: NEW_URL });
      expect(users.rows.get(ID)?.image).toBe(NEW_URL);
      expect(log.error).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    });

    test('a product image is read and written through the Product model', async () => {
      seed(products, { image: OWN_URL });

      await replace('product');

      expect(products.rows.get(ID)?.image).toBe(NEW_URL);
      expect(users.rows.size).toBe(0);
    });

    test.each([
      ['user', 'User not found'],
      ['product', 'Product not found'],
    ] as const)('a missing %s is NotFoundError before anything is uploaded', async (collection, message) => {
      await expect(replace(collection)).rejects.toEqual(new NotFoundError(message));
      expect(events).toEqual([]);
    });

    test('a soft-deleted record is NotFoundError before anything is uploaded', async () => {
      seed(users, { state: false, image: OWN_URL });

      await expect(replace()).rejects.toEqual(new NotFoundError('User not found'));
      expect(events).toEqual([]);
    });

    test('a record without an image has nothing destroyed', async () => {
      seed(users);

      await replace();

      expect(events).toEqual(['upload', 'swap']);
    });

    test.each([
      ['a Google avatar', 'https://lh3.googleusercontent.com/a/ACg8ocJ-avatar=s96-c'],
      ['a legacy bare filename', 'old-avatar.png'],
      ['another cloud', 'https://res.cloudinary.com/other-cloud/image/upload/v1/old-avatar.png'],
      [
        'an own-cloud URL that is not an upload',
        'https://res.cloudinary.com/demo/image/fetch/old-avatar.png',
      ],
    ])('a previous image that is %s is never destroyed', async (_shape, image) => {
      seed(users, { image });

      await replace();

      expect(events).toEqual(['upload', 'swap']);
      expect(users.rows.get(ID)?.image).toBe(NEW_URL);
    });

    test('an upload failure rejects and changes nothing', async () => {
      seed(users, { image: OWN_URL });
      client.upload.mockRejectedValueOnce(new Error('cloudinary is down'));

      await expect(replace()).rejects.toThrow('cloudinary is down');
      expect(events).toEqual([]);
      expect(users.rows.get(ID)?.image).toBe(OWN_URL);
      expect(log.error).not.toHaveBeenCalled();
    });

    test('a failed save logs the orphaned asset at error, keeps the old one and rethrows', async () => {
      seed(users, { image: OWN_URL });
      const failure = new Error('database is down');
      vi.spyOn(users, 'findOneAndUpdate').mockRejectedValueOnce(failure);

      await expect(replace()).rejects.toBe(failure);
      expect(log.error).toHaveBeenCalledWith({ asset: NEW_URL, collection: 'user', id: ID }, ORPHANED);
      expect(client.destroy).not.toHaveBeenCalled();
      expect(users.rows.get(ID)?.image).toBe(OWN_URL);
    });

    test('a record soft-deleted between the check and the save: the orphan is logged and it is a 404', async () => {
      seed(users, { image: OWN_URL });
      client.upload.mockImplementationOnce(async () => {
        users.rows.get(ID)!.state = false;
        return { secureUrl: NEW_URL };
      });

      await expect(replace()).rejects.toEqual(new NotFoundError('User not found'));
      expect(log.error).toHaveBeenCalledWith({ asset: NEW_URL, collection: 'user', id: ID }, ORPHANED);
      expect(client.destroy).not.toHaveBeenCalled();
      expect(users.rows.get(ID)?.image).toBe(OWN_URL);
    });

    test('a failed destroy is logged at warn and the replacement still succeeds', async () => {
      seed(users, { image: OWN_URL });
      const failure = new Error('destroy is down');
      client.destroy.mockRejectedValueOnce(failure);

      const record = await replace();

      expect(record.image).toBe(NEW_URL);
      expect(log.warn).toHaveBeenCalledWith(
        { err: failure, asset: OWN_URL },
        'previous Cloudinary asset not destroyed',
      );
    });
  });

  describe('imageUrl (AM-M3-1)', () => {
    test('an own-cloud image is the redirect target', async () => {
      seed(products, { image: OWN_URL });

      await expect(service.imageUrl('product', ID)).resolves.toBe(OWN_URL);
    });

    test.each([
      ['no image', undefined],
      ['a Google avatar', 'https://lh3.googleusercontent.com/a/ACg8ocJ-avatar=s96-c'],
      ['another cloud', 'https://res.cloudinary.com/other-cloud/image/upload/v1/x.png'],
      [
        'a dot-dot step into another cloud',
        'https://res.cloudinary.com/demo/../other-cloud/image/upload/v1/x.png',
      ],
    ])('%s is NotFoundError "Image not found"', async (_shape, image) => {
      seed(users, { image });

      await expect(service.imageUrl('user', ID)).rejects.toEqual(new NotFoundError('Image not found'));
    });

    test('a missing or soft-deleted record is NotFoundError for its collection', async () => {
      await expect(service.imageUrl('product', ID)).rejects.toEqual(new NotFoundError('Product not found'));

      seed(users, { state: false, image: OWN_URL });
      await expect(service.imageUrl('user', ID)).rejects.toEqual(new NotFoundError('User not found'));
    });
  });
});
