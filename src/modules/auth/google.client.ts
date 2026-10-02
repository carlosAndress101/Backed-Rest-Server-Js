import { OAuth2Client } from 'google-auth-library';

/** What sign-in reads from a verified Google ID token. */
export interface GoogleProfile {
  name?: string;
  email?: string;
  picture?: string;
  /** Google's email_verified claim, true only when Google says so (ADR-036). */
  emailVerified: boolean;
}

/** What the auth service needs from Google. Tests replace it; nothing else talks to the SDK. */
export interface GoogleVerifier {
  /** Resolves to the token's profile; rejects when the token is not a valid Google ID token for this app. */
  verify(idToken: string): Promise<GoogleProfile>;
}

/** The google-auth-library SDK behind GoogleVerifier. */
export class GoogleClient implements GoogleVerifier {
  readonly #clientId: string;
  readonly #client: OAuth2Client;

  /** `clientId` is config.auth.googleClientId: the audience every accepted token must carry. */
  constructor(clientId: string) {
    this.#clientId = clientId;
    this.#client = new OAuth2Client(clientId);
  }

  async verify(idToken: string): Promise<GoogleProfile> {
    const ticket = await this.#client.verifyIdToken({ idToken, audience: this.#clientId });
    const payload = ticket.getPayload();
    if (!payload) throw new Error('The Google ID token has no payload');
    const { name, email, picture } = payload;
    return { name, email, picture, emailVerified: payload.email_verified === true };
  }
}
