// The auth module's Google client stub (T3.4): tests replace the injected client, never the SDK (ADR-023).
import { vi } from 'vitest';

import { GoogleClient, type GoogleProfile } from '../../src/modules/auth/google.client';

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
