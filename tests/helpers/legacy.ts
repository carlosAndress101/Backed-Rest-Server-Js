// tests/helpers/legacy.ts: contract P7. The one test seam into legacy CommonJS; deleted with the last legacy module (M3).
/* eslint-disable @typescript-eslint/no-require-imports */
// ADR-027 load order (AM-M3-4): models/index.js re-exports the TS registrations, so every migrated
// model registers here first. A module task that migrates a model adds its line. Deleted with this file (T3.8).
import '../../src/modules/categories/category.model';
import '../../src/modules/products/product.model';
import type { v2 } from 'cloudinary';
import type { OAuth2Client } from 'google-auth-library';
import type { Model } from 'mongoose';
import { vi, type MockInstance } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LegacyModel = Model<any>; // legacy schemas are untyped JS
/** A document of a legacy model: untyped JS, so every field is `any` until M3 (factories return it). */
export type LegacyDoc = ReturnType<LegacyModel['hydrate']>;

export const legacyModels = () =>
  require('../../models') as { User: LegacyModel; Role: LegacyModel; Category: LegacyModel; Product: LegacyModel };
export const { generarJWT } = require('../../helpers/generar-jwt') as {
  generarJWT: (uid: string) => Promise<string>;
};

const cloudinary = (require('cloudinary') as { v2: typeof v2 }).v2;
const { OAuth2Client: GoogleClient } = require('google-auth-library') as { OAuth2Client: typeof OAuth2Client };

export interface GooglePayload {
  name?: string;
  email?: string;
  picture?: string;
}
type VerifyIdToken = (options: {
  idToken: string;
  audience?: string;
}) => Promise<{ getPayload: () => GooglePayload | undefined }>;

/** Replaces Google ID-token verification for the current test (undone by restoreMocks). */
export const stubGoogleVerify = () =>
  vi.spyOn(GoogleClient.prototype, 'verifyIdToken') as unknown as MockInstance<VerifyIdToken>;
export const googleTicket = (payload: GooglePayload) => ({ getPayload: () => payload });

/** Replaces the Cloudinary uploader for the current test (undone by restoreMocks). */
export const stubCloudinary = () => ({
  upload: vi.spyOn(cloudinary.uploader, 'upload') as unknown as MockInstance<
    (file: string) => Promise<{ secure_url: string }>
  >,
  destroy: vi.spyOn(cloudinary.uploader, 'destroy') as unknown as MockInstance<
    (publicId: string) => Promise<{ result: string }>
  >,
});
