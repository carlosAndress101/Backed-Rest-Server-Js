import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearDatabase, clearLogs, loggedText, startTestApp, stopTestApp } from '../../helpers/app';
import { expectStatus } from '../../helpers/assert';
import { authHeader, createAdmin, createProduct, createUser, tokenFor } from '../../helpers/factories';
import { legacyModels } from '../../helpers/legacy';
import { stubMediaClient } from '../../helpers/uploads';

const { User, Product } = legacyModels();

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const OLD_URL = 'https://res.cloudinary.com/demo/image/upload/v1/old-avatar.png';
const NEW_URL = 'https://res.cloudinary.com/demo/image/upload/v1/new-avatar.png';

const replaceImage = (app: Server, url: string, token: string) =>
  request(app).put(url).set(authHeader(token)).attach('file', JPEG, 'photo.jpg');

describe('REL-04 / C11 an image is replaced as upload, save, then destroy', () => {
  let app: Server;
  let upload: ReturnType<typeof stubMediaClient>['upload'];
  let destroy: ReturnType<typeof stubMediaClient>['destroy'];

  beforeAll(async () => {
    app = await startTestApp({ LOG_LEVEL: 'warn' });
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await clearDatabase();
    ({ upload, destroy } = stubMediaClient(NEW_URL));
    // The failure paths below log on purpose (C1 and the orphan notice).
    clearLogs();
  });

  test('on success the old asset is destroyed after the upload, once the record is saved', async () => {
    const owner = await createUser({ image: OLD_URL });
    let imageWhenDestroyed: unknown;
    destroy.mockImplementation(async () => {
      imageWhenDestroyed = (await User.findById(owner.id)).image;
    });

    const res = await replaceImage(app, `/api/uploads/user/${owner.id}`, await tokenFor(owner));

    expectStatus(res, 200);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith('old-avatar');
    expect(destroy.mock.invocationCallOrder[0]!).toBeGreaterThan(upload.mock.invocationCallOrder[0]!);
    expect(imageWhenDestroyed).toBe(NEW_URL);
    expect((await User.findById(owner.id)).image).toBe(NEW_URL);
  });

  test('the same order holds for a product image', async () => {
    const product = await createProduct({ image: OLD_URL });

    const res = await replaceImage(
      app,
      `/api/uploads/product/${product.id}`,
      await tokenFor(await createAdmin()),
    );

    expectStatus(res, 200);
    expect(destroy).toHaveBeenCalledWith('old-avatar');
    expect(destroy.mock.invocationCallOrder[0]!).toBeGreaterThan(upload.mock.invocationCallOrder[0]!);
    expect((await Product.findById(product.id)).image).toBe(NEW_URL);
  });

  test('a record without a previous image destroys nothing', async () => {
    const owner = await createUser();

    const res = await replaceImage(app, `/api/uploads/user/${owner.id}`, await tokenFor(owner));

    expectStatus(res, 200);
    expect(destroy).not.toHaveBeenCalled();
  });

  test('when the upload fails nothing is destroyed and the image is unchanged', async () => {
    upload.mockRejectedValueOnce(new Error('cloudinary is down'));
    const owner = await createUser({ image: OLD_URL });

    const res = await replaceImage(app, `/api/uploads/user/${owner.id}`, await tokenFor(owner));

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(destroy).not.toHaveBeenCalled();
    expect((await User.findById(owner.id)).image).toBe(OLD_URL);
  });

  test('when the save fails the old asset is kept and the orphaned upload is logged', async () => {
    const owner = await createUser({ image: OLD_URL });
    const token = await tokenFor(owner);
    // the save is one atomic find-active-and-update (T3.7), so that is where the database fails
    vi.spyOn(User, 'findOneAndUpdate').mockRejectedValueOnce(new Error('database is down'));

    const res = await replaceImage(app, `/api/uploads/user/${owner.id}`, token);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect((await User.findById(owner.id)).image).toBe(OLD_URL);
    expect(loggedText()).toContain(NEW_URL);
  });

  test('an old image that is not an asset of the own cloud is never destroyed', async () => {
    const owner = await createUser({ image: 'https://lh3.googleusercontent.com/a/ACg8ocJ-avatar=s96-c' });

    const res = await replaceImage(app, `/api/uploads/user/${owner.id}`, await tokenFor(owner));

    expectStatus(res, 200);
    expect(destroy).not.toHaveBeenCalled();
    expect((await User.findById(owner.id)).image).toBe(NEW_URL);
  });

  test('a failed destroy of the old asset does not fail the replacement', async () => {
    destroy.mockRejectedValueOnce(new Error('destroy is down'));
    const owner = await createUser({ image: OLD_URL });

    const res = await replaceImage(app, `/api/uploads/user/${owner.id}`, await tokenFor(owner));

    expectStatus(res, 200);
    expect((await User.findById(owner.id)).image).toBe(NEW_URL);
  });
});
