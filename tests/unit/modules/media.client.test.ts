// cloudinary.client.ts: the credentials, the own-cloud allowlist (AM-M3-1) and the SDK calls. The SDK is spied
// on, never called for real: no network, no vi.mock (ADR-023).
import { v2 as cloudinary } from 'cloudinary';
import { describe, expect, test, vi } from 'vitest';

import {
  CloudinaryClient,
  ownAssetUrl,
  parseCloudinaryUrl,
  publicIdOf,
} from '../../../src/modules/media/cloudinary.client';

const OWN_URL = 'https://res.cloudinary.com/demo/image/upload/v1690000000/shop/avatar.jpg';

describe('parseCloudinaryUrl', () => {
  test('splits cloudinary://<api_key>:<api_secret>@<cloud_name>', () => {
    expect(parseCloudinaryUrl('cloudinary://123456:s3cr3t-Value_@demo')).toEqual({
      apiKey: '123456',
      apiSecret: 's3cr3t-Value_',
      cloudName: 'demo',
    });
  });

  test('the cloud name stops at a query string', () => {
    expect(parseCloudinaryUrl('cloudinary://key:secret@demo?secure_distribution=cdn.example').cloudName).toBe(
      'demo',
    );
  });

  test.each(['https://api.cloudinary.com', 'cloudinary://key@demo', 'cloudinary://key:secret@', ''])(
    'rejects %j',
    (url) => {
      expect(() => parseCloudinaryUrl(url)).toThrow(/cloudinary:\/\/<api_key>:<api_secret>@<cloud_name>/);
    },
  );
});

describe('ownAssetUrl (AM-M3-1)', () => {
  test.each([
    OWN_URL,
    'https://res.cloudinary.com/demo/image/upload/v1/x.png',
    'https://res.cloudinary.com/demo/image/upload/abc123.gif',
    'https://res.cloudinary.com/demo/image/upload/v1/a_b-c.d.png',
  ])('accepts the own-cloud asset %s as it is', (url) => {
    expect(ownAssetUrl(url, 'demo')).toBe(url);
  });

  test.each([
    ['a non-string', 42],
    ['null', null],
    ['no image', undefined],
    ['an empty string', ''],
    ['a Google avatar', 'https://lh3.googleusercontent.com/a/ACg8ocJ-avatar=s96-c'],
    ['a legacy bare filename', 'avatar.jpg'],
    ['another host', 'https://evil.example/image.png'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a protocol-relative URL', '//evil.example/image.png'],
    ['a look-alike host', 'https://res.cloudinary.com.evil.example/demo/image/upload/v1/x.png'],
    ['a different cloud', 'https://res.cloudinary.com/other-cloud/image/upload/v1/x.png'],
    ['a cloud whose name starts with ours', 'https://res.cloudinary.com/demo-evil/image/upload/v1/x.png'],
    ['the bare cloud root', 'https://res.cloudinary.com/demo'],
    ['plain http', 'http://res.cloudinary.com/demo/image/upload/v1/x.png'],
    ['a dot-dot step', 'https://res.cloudinary.com/demo/../other-cloud/image/upload/v1/x.png'],
    ['a single-dot segment', 'https://res.cloudinary.com/demo/./image/upload/v1/x.png'],
    ['an encoded dot-dot step', 'https://res.cloudinary.com/demo/%2E%2e/other-cloud/image/upload/v1/x.png'],
    ['a backslash step', 'https://res.cloudinary.com/demo/..\\other-cloud/image/upload/v1/x.png'],
    ['an encoded slash', 'https://res.cloudinary.com/demo/..%2fother-cloud/image/upload/v1/x.png'],
    ['an encoded backslash', 'https://res.cloudinary.com/demo/..%5Cother-cloud/image/upload/v1/x.png'],
    [
      'a double-encoded dot-dot step',
      'https://res.cloudinary.com/demo/%252e%252e/other-cloud/image/upload/v1/x.png',
    ],
    [
      'an encoded control character after a dot-dot',
      'https://res.cloudinary.com/demo/%2e%2e%09/other-cloud/x.png',
    ],
    ['a query string', 'https://res.cloudinary.com/demo/image/upload/v1/x.png?next=https://evil.example'],
    ['a fragment', 'https://res.cloudinary.com/demo/image/upload/v1/x.png#top'],
    ['a tab', 'https://res.cloudinary.com/demo/image/upload/v1/x\t.png'],
    ['a CRLF', 'https://res.cloudinary.com/demo/x.png\r\nSet-Cookie: session=evil'],
    ['a space that the parser would encode', 'https://res.cloudinary.com/demo/image/upload/v1/x y.png'],
  ])('rejects %s', (_shape, value) => {
    expect(ownAssetUrl(value, 'demo')).toBeUndefined();
  });

  test('the cloud is the configured one', () => {
    expect(ownAssetUrl(OWN_URL, 'other-cloud')).toBeUndefined();
  });
});

describe('publicIdOf', () => {
  test.each([
    ['https://res.cloudinary.com/demo/image/upload/v1/old-avatar.png', 'old-avatar'],
    ['https://res.cloudinary.com/demo/image/upload/old-avatar.png', 'old-avatar'],
    [OWN_URL, 'shop/avatar'],
    ['https://res.cloudinary.com/demo/image/upload/v1/my.photo.jpg', 'my.photo'],
    ['https://res.cloudinary.com/demo/image/upload/v1/no-extension', 'no-extension'],
  ])('%s → %s', (url, publicId) => {
    expect(publicIdOf(url)).toBe(publicId);
  });

  test.each([
    'https://res.cloudinary.com/demo/image/fetch/old-avatar.png',
    'https://res.cloudinary.com/demo/video/upload/v1/clip.mp4',
    'https://res.cloudinary.com/demo/image/upload/',
  ])('%s has no image upload public id', (url) => {
    expect(publicIdOf(url)).toBeUndefined();
  });
});

describe('CloudinaryClient', () => {
  const client = new CloudinaryClient({ cloudName: 'demo', apiKey: 'key', apiSecret: 'secret' });
  const credentials = { cloud_name: 'demo', api_key: 'key', api_secret: 'secret' };

  test('upload sends the file with the configured credentials and resolves to its secure URL', async () => {
    const upload = vi
      .spyOn(cloudinary.uploader, 'upload')
      .mockResolvedValue({ secure_url: OWN_URL } as Awaited<ReturnType<typeof cloudinary.uploader.upload>>);

    await expect(client.upload('/tmp/upload-1/tmp-1')).resolves.toEqual({ secureUrl: OWN_URL });
    await client.upload('/tmp/upload-1/tmp-2');

    expect(upload).toHaveBeenNthCalledWith(1, '/tmp/upload-1/tmp-1', credentials);
    // a fresh options object each time: the SDK deletes the credential keys from the one it gets
    expect(upload.mock.calls[0]![1]).not.toBe(upload.mock.calls[1]![1]);
  });

  test('destroy sends the public id with the configured credentials', async () => {
    const destroy = vi.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' });

    await expect(client.destroy('shop/avatar')).resolves.toBeUndefined();

    expect(destroy).toHaveBeenCalledWith('shop/avatar', { ...credentials, invalidate: false });
  });

  test('an SDK failure rejects', async () => {
    vi.spyOn(cloudinary.uploader, 'upload').mockRejectedValue(new Error('cloudinary is down'));

    await expect(client.upload('/tmp/upload-1/tmp-1')).rejects.toThrow('cloudinary is down');
  });
});
