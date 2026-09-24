// The Google SDK wrapper (M3 design §5.2): the one place that talks to google-auth-library. The SDK's
// verifyIdToken is spied on, so nothing reaches Google (ADR-023).
import { OAuth2Client, type LoginTicket, type TokenPayload } from 'google-auth-library';
import { describe, expect, test, vi } from 'vitest';

import { GoogleClient } from '../../../src/modules/auth/google.client';

const CLIENT_ID = 'client-id.apps.googleusercontent.com';

const ticket = (payload: TokenPayload | undefined) => ({ getPayload: () => payload }) as LoginTicket;
const stubVerifyIdToken = () =>
  vi.spyOn(OAuth2Client.prototype, 'verifyIdToken') as unknown as ReturnType<
    typeof vi.fn<(options: { idToken: string; audience?: string }) => Promise<LoginTicket>>
  >;

describe('GoogleClient', () => {
  test("verifies the token for this app's client id and returns only the name, email, picture and email_verified", async () => {
    const verifyIdToken = stubVerifyIdToken().mockResolvedValue(
      ticket({
        iss: 'https://accounts.google.com',
        sub: '1234567890',
        aud: CLIENT_ID,
        iat: 1,
        exp: 2,
        email: 'grace@example.com',
        email_verified: false,
        name: 'Grace Hopper',
        picture: 'https://example.com/grace.png',
      }),
    );

    const profile = await new GoogleClient(CLIENT_ID).verify('google-id-token');

    expect(verifyIdToken).toHaveBeenCalledExactlyOnceWith({
      idToken: 'google-id-token',
      audience: CLIENT_ID,
    });
    expect(profile).toEqual({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      picture: 'https://example.com/grace.png',
      emailVerified: false,
    });
  });

  // ADR-036: only Google's own `true` counts as verified; a missing or non-boolean claim does not.
  test.each([
    ['true', true, true],
    ['false', false, false],
    ['absent', undefined, false],
    ['the string "true"', 'true', false],
  ])('email_verified %s is read as %s', async (_case, claim, verified) => {
    stubVerifyIdToken().mockResolvedValue(
      ticket({
        iss: '',
        sub: '',
        aud: '',
        iat: 0,
        exp: 0,
        email: 'a@example.com',
        email_verified: claim as boolean,
      }),
    );

    await expect(new GoogleClient(CLIENT_ID).verify('t')).resolves.toMatchObject({ emailVerified: verified });
  });

  test('rejects with the SDK error when the token does not verify', async () => {
    stubVerifyIdToken().mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'));

    await expect(new GoogleClient(CLIENT_ID).verify('for-another-app')).rejects.toThrow('Wrong recipient');
  });

  test('rejects when the verified ticket has no payload', async () => {
    stubVerifyIdToken().mockResolvedValue(ticket(undefined));

    await expect(new GoogleClient(CLIENT_ID).verify('google-id-token')).rejects.toThrow(
      'The Google ID token has no payload',
    );
  });

  test('each client checks its own audience', async () => {
    const verifyIdToken = stubVerifyIdToken().mockResolvedValue(
      ticket({ iss: '', sub: '', aud: '', iat: 0, exp: 0 }),
    );

    await new GoogleClient('first-client').verify('a');
    await new GoogleClient('second-client').verify('b');

    expect(verifyIdToken.mock.calls.map(([options]) => options.audience)).toEqual([
      'first-client',
      'second-client',
    ]);
  });
});
