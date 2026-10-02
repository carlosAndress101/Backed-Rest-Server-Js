// The auth module's Google client stub (T3.4): tests replace the injected client, never the SDK (ADR-023).
// Also the shared request builders for the session routes (#24, #25), so suites do not each keep a copy.
import type { Server } from 'node:http';

import request from 'supertest';
import { vi } from 'vitest';

import { GoogleClient, type GoogleProfile } from '../../src/modules/auth/google.client';

/** POST /api/auth/logout-all with the given headers; pass `{}` to send no token. */
export const logoutAll = (app: Server, header: Record<string, string>) =>
  request(app).post('/api/auth/logout-all').set(header);

/** PUT /api/auth/password with the given headers and body; pass `{}` as the header to send no token. */
export const changePassword = (app: Server, header: Record<string, string>, body: object) =>
  request(app).put('/api/auth/password').set(header).send(body);

/**
 * Replaces Google ID-token verification for the current test (undone by restoreMocks): it resolves to `profile`,
 * or, without one, rejects like an invalid token, so no test ever reaches Google. Tests can still set one call
 * with mockResolvedValueOnce. A profile is a verified address unless it says otherwise (ADR-036).
 */
export const stubGoogleClient = (
  profile?: Omit<GoogleProfile, 'emailVerified'> & Partial<Pick<GoogleProfile, 'emailVerified'>>,
) => {
  const verify = vi.spyOn(GoogleClient.prototype, 'verify');
  if (profile) verify.mockResolvedValue({ emailVerified: true, ...profile });
  else verify.mockRejectedValue(new Error('Invalid Google ID token (stub)'));
  return verify;
};
