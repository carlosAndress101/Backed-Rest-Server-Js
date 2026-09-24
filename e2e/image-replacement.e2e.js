// ARC-03: load models/server before any other application module.
require('../models/server');

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: {
      upload: jest.fn(),
      destroy: jest.fn(),
    },
  },
}));

const request = require('supertest');
const mongoose = require('mongoose');

const {
  connectDatabase,
  buildApp,
  closeServers,
  clearDatabase,
  createUser,
  createAdmin,
  createProduct,
  tokenFor,
  authHeader,
  User,
  Product,
} = require('./helpers/db');

const cloudinary = require('cloudinary').v2;

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const OLD_URL = 'https://res.cloudinary.com/demo/image/upload/v1/old-avatar.png';
const NEW_URL = 'https://res.cloudinary.com/demo/image/upload/v1/new-avatar.png';

const replaceImage = (app, url, token) =>
  request(app).put(url).set(authHeader(token)).attach('file', JPEG, 'photo.jpg');

describe('REL-04 / C11 an image is replaced as upload, save, then destroy', () => {
  let app;

  beforeAll(async () => {
    await connectDatabase();
    app = await buildApp();
  });

  afterAll(async () => {
    await closeServers();
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await clearDatabase();
    cloudinary.uploader.upload.mockReset();
    cloudinary.uploader.upload.mockResolvedValue({ secure_url: NEW_URL });
    cloudinary.uploader.destroy.mockReset();
    cloudinary.uploader.destroy.mockResolvedValue({ result: 'ok' });
    // The failure paths below log on purpose (C1 and the orphan notice).
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('on success the old asset is destroyed after the upload, once the record is saved', async () => {
    const owner = await createUser({ image: OLD_URL });
    let imageWhenDestroyed;
    cloudinary.uploader.destroy.mockImplementation(async () => {
      imageWhenDestroyed = (await User.findById(owner.id)).image;
      return { result: 'ok' };
    });

    const res = await replaceImage(app, `/api/uploads/user/${owner.id}`, await tokenFor(owner));

    expect(res.statusCode).toBe(200);
    expect(cloudinary.uploader.upload).toHaveBeenCalledTimes(1);
    expect(cloudinary.uploader.destroy).toHaveBeenCalledTimes(1);
    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('old-avatar');
    expect(cloudinary.uploader.destroy.mock.invocationCallOrder[0]).toBeGreaterThan(
      cloudinary.uploader.upload.mock.invocationCallOrder[0]
    );
    expect(imageWhenDestroyed).toBe(NEW_URL);
    expect((await User.findById(owner.id)).image).toBe(NEW_URL);
  });

  test('the same order holds for a product image', async () => {
    const product = await createProduct({ image: OLD_URL });

    const res = await replaceImage(app, `/api/uploads/product/${product.id}`, await tokenFor(await createAdmin()));

    expect(res.statusCode).toBe(200);
    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('old-avatar');
    expect(cloudinary.uploader.destroy.mock.invocationCallOrder[0]).toBeGreaterThan(
      cloudinary.uploader.upload.mock.invocationCallOrder[0]
    );
    expect((await Product.findById(product.id)).image).toBe(NEW_URL);
  });

  test('a record without a previous image destroys nothing', async () => {
    const owner = await createUser();

    const res = await replaceImage(app, `/api/uploads/user/${owner.id}`, await tokenFor(owner));

    expect(res.statusCode).toBe(200);
    expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
  });

  test('when the upload fails nothing is destroyed and the image is unchanged', async () => {
    cloudinary.uploader.upload.mockRejectedValueOnce(new Error('cloudinary is down'));
    const owner = await createUser({ image: OLD_URL });

    const res = await replaceImage(app, `/api/uploads/user/${owner.id}`, await tokenFor(owner));

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ msg: 'Internal server error' });
    expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    expect((await User.findById(owner.id)).image).toBe(OLD_URL);
  });

  test('when the save fails the old asset is kept and the orphaned upload is logged', async () => {
    const owner = await createUser({ image: OLD_URL });
    const token = await tokenFor(owner);
    jest.spyOn(User.prototype, 'save').mockRejectedValueOnce(new Error('database is down'));

    const res = await replaceImage(app, `/api/uploads/user/${owner.id}`, token);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ msg: 'Internal server error' });
    expect(cloudinary.uploader.upload).toHaveBeenCalledTimes(1);
    expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    expect((await User.findById(owner.id)).image).toBe(OLD_URL);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(NEW_URL));
  });

  test('a failed destroy of the old asset does not fail the replacement', async () => {
    cloudinary.uploader.destroy.mockRejectedValueOnce(new Error('destroy is down'));
    const owner = await createUser({ image: OLD_URL });

    const res = await replaceImage(app, `/api/uploads/user/${owner.id}`, await tokenFor(owner));

    expect(res.statusCode).toBe(200);
    expect((await User.findById(owner.id)).image).toBe(NEW_URL);
  });
});
