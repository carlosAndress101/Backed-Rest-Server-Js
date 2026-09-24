import bcrypt from 'bcrypt';

import { UnauthorizedError } from '../../core/errors';
import type { TokenService } from '../../core/security/jwt';
import type { GoogleDto, LoginDto } from './auth.schemas';
import type { GoogleProfile, GoogleVerifier } from './google.client';

/** A stored user, as far as sign-in reads it. The password is not part of it (select: false, AM-M4-1). */
export interface SignInUser {
  _id: unknown;
  state?: boolean | null;
}

/** The one read that needs the password hash: the login's, with '+password'. */
export interface SignInUserWithPassword extends SignInUser {
  password: string;
}

/** The account a first Google sign-in creates. The ':D' placeholder password is SEC-12's (M5). */
export interface GoogleSignUp {
  name?: string;
  email?: string;
  password: ':D';
  image?: string;
  google: true;
}

/** The slice of the users module's model sign-in needs. src/app.ts injects UserModel (§2.3 rule 4). */
export interface SignInUserModel {
  findOne(filter: { email: string | undefined }): PromiseLike<SignInUser | null>;
  findOne(
    filter: { email: string | undefined },
    projection: '+password',
  ): PromiseLike<SignInUserWithPassword | null>;
  create(doc: GoogleSignUp): PromiseLike<SignInUser>;
}

/** A signed-in user and its x-token. The user serializes through its model's toJSON (id, uid, never password). */
export interface Session {
  token: string;
  user: SignInUser;
}

export interface AuthService {
  login(dto: LoginDto): Promise<Session>;
  googleSignIn(dto: GoogleDto): Promise<Session>;
}

// F1: compared against when the email is unknown, so every credential failure costs one bcrypt check.
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

// A hash bcrypt really does work on ($2a$/$2b$, cost 04-31). Anything else, like the ':D' placeholder of
// Google-created accounts, would fail instantly and reveal the account.
const BCRYPT_HASH = /^\$2[ab]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;

/**
 * Password and Google sign-in (ADR-005: the model, the token service and the Google client are injected).
 * Behaviour is today's: bcrypt stays synchronous, and email_verified and the ':D' placeholder stay as they are
 * until M5 (SEC-11, SEC-12). Throws AppErrors; knows nothing of HTTP.
 */
export function createAuthService(deps: {
  User: SignInUserModel;
  tokens: TokenService;
  google: GoogleVerifier;
}): AuthService {
  const { User, tokens, google } = deps;

  // C5: one answer for every credential failure.
  const invalidCredentials = () => new UnauthorizedError('Invalid credentials');
  const session = async (user: SignInUser): Promise<Session> => ({
    token: await tokens.sign(String(user._id)),
    user,
  });

  return {
    async login({ email, password }) {
      // AM-M4-1: the hash is select: false, so the one read that compares it asks for it.
      const user = await User.findOne({ email }, '+password');

      // The password, the user and its state fail with the same answer; an account without a password hash is
      // compared against the dummy one and never matches.
      const hasPasswordHash = user !== null && BCRYPT_HASH.test(user.password);
      const validPassword = bcrypt.compareSync(password, hasPasswordHash ? user.password : DUMMY_HASH);
      if (!hasPasswordHash || !user.state || !validPassword) throw invalidCredentials();

      return session(user);
    },

    async googleSignIn({ id_token }) {
      let profile: GoogleProfile;
      try {
        profile = await google.verify(id_token);
      } catch {
        throw invalidCredentials();
      }

      const { name, picture } = profile;
      // §10.5: the Google address is matched the way sign-up and login store and read it (trimmed, lowercased).
      const email = profile.email?.trim().toLowerCase();
      const user =
        (await User.findOne({ email })) ??
        (await User.create({ name, email, password: ':D', image: picture, google: true }));
      if (!user.state) throw invalidCredentials();

      return session(user);
    },
  };
}
