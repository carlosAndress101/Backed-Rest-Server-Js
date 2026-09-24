import { v2 as cloudinary } from 'cloudinary';

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** What the media service needs from Cloudinary (ADR-030). Tests replace it; nothing else talks to the SDK. */
export interface MediaClient {
  /** Uploads a local file and resolves to the asset's https delivery URL. */
  upload(filePath: string): Promise<{ secureUrl: string }>;
  destroy(publicId: string): Promise<void>;
}

const CLOUDINARY_URL = /^cloudinary:\/\/([^:\s]+):([^@\s]+)@([^/?#\s]+)/;
const DELIVERY_ORIGIN = 'https://res.cloudinary.com';
const ASSET_PATH = /^[\w./-]+$/;
const UPLOAD_PATH = /^\/[^/]+\/image\/upload\/(?:v\d+\/)?(.+?)(?:\.[^./]+)?$/;

/** Splits config.media.cloudinaryUrl (cloudinary://<api_key>:<api_secret>@<cloud_name>, checked by src/config). */
export function parseCloudinaryUrl(url: string): CloudinaryCredentials {
  const [, apiKey, apiSecret, cloudName] = CLOUDINARY_URL.exec(url) ?? [];
  if (!apiKey || !apiSecret || !cloudName)
    throw new Error('CLOUDINARY_URL must be cloudinary://<api_key>:<api_secret>@<cloud_name>');
  return { cloudName, apiKey, apiSecret };
}

/**
 * AM-M3-1, the open-redirect guard: returns `value` only if it is an asset of this app's own cloud, that is a
 * URL starting with https://res.cloudinary.com/<cloudName>/. Stored images are not trusted (products' image was
 * mass-assignable before M1), so the stored string itself must be the canonical URL (no `.` or `..` segment), and
 * its path may only use the characters of the delivery URLs this app's uploads get (random public ids): no
 * percent-encoding, backslash, whitespace, query or fragment, so nothing a browser or the CDN decodes or
 * normalises can make it point outside the cloud.
 */
export function ownAssetUrl(value: unknown, cloudName: string): string | undefined {
  const prefix = `${DELIVERY_ORIGIN}/${cloudName}/`;
  if (typeof value !== 'string' || !value.startsWith(prefix)) return undefined;
  if (!ASSET_PATH.test(value.slice(prefix.length)) || new URL(value).href !== value) return undefined;
  return value;
}

/** The public id in an upload delivery URL (…/image/upload/[v<version>/]<public_id>.<ext>), or undefined. */
export function publicIdOf(assetUrl: string): string | undefined {
  return UPLOAD_PATH.exec(new URL(assetUrl).pathname)?.[1];
}

/**
 * The Cloudinary v2 SDK behind MediaClient. The credentials come from config and go with every call, so the
 * SDK's process-wide configuration is never read or changed.
 */
export class CloudinaryClient implements MediaClient {
  readonly #credentials: { cloud_name: string; api_key: string; api_secret: string };

  constructor({ cloudName, apiKey, apiSecret }: CloudinaryCredentials) {
    this.#credentials = { cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret };
  }

  async upload(filePath: string): Promise<{ secureUrl: string }> {
    // A fresh options object per call: the SDK deletes the credential keys from the one it is given.
    const { secure_url } = await cloudinary.uploader.upload(filePath, { ...this.#credentials });
    return { secureUrl: secure_url };
  }

  async destroy(publicId: string): Promise<void> {
    // The SDK signs every call with the credentials in its options, but its types list only destroy's own
    // options, so they go in through a variable (invalidate: false is the SDK default).
    const options = { ...this.#credentials, invalidate: false };
    await cloudinary.uploader.destroy(publicId, options);
  }
}
