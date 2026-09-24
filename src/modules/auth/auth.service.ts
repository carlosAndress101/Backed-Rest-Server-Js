import { UnauthorizedError } from '../../core/errors';
import type { Logger } from '../../core/logger';
import type { TokenService } from '../../core/security/jwt';
import { comparePassword, hashPassword, isUsableHash, needsRehash } from '../../core/security/password';
import type { GoogleDto, LoginDto, PasswordChangeDto } from './auth.schemas';
import type { GoogleProfile, GoogleVerifier } from './google.client';

/** A stored user, as far as sign-in reads it. The password is not part of it (select: false, AM-M4-1). */
export interface SignInUser {
  _id: unknown;
  state?: boolean | null;
  /** A Google-only account (ADR-036): the only kind a Google sign-in may enter. */
  google?: boolean | null;
  /** Signed into every token (AM-M5-9): a token of another version is refused by authenticate (ADR-033). */
  tokenVersion: number;
}

/** The one read that needs the password hash: the login's, with '+password'. A Google-only account has none. */
export interface SignInUserWithPassword extends SignInUser {
  password?: string | null;
}

/** The account a first Google sign-in creates: no password at all (ADR-036, SEC-12). */
export interface GoogleSignUp {
  name?: string;
  email: string;
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
  /** The password change's read: the caller's own account, with its hash. */
  findById(id: string, projection: '+password'): PromiseLike<SignInUserWithPassword | null>;
  create(doc: GoogleSignUp): PromiseLike<SignInUser>;
  /** The rehash (P25): replaces the stored hash only if it is still the one the login compared against. */
  updateOne(filter: { _id: unknown; password: string }, update: { password: string }): PromiseLike<unknown>;
  /** logout-all (ADR-033): one more tokenVersion, so every token signed before stops verifying. */
  updateOne(filter: { _id: string }, update: { $inc: { tokenVersion: 1 } }): PromiseLike<unknown>;
  /** The password change: the new hash and the next tokenVersion in one atomic update. */
  findOneAndUpdate(
    filter: { _id: string; state: true },
    update: { password: string; $inc: { tokenVersion: 1 } },
    options: { returnDocument: 'after' },
  ): PromiseLike<SignInUser | null>;
}

/** Where a failed background rehash is reported: the request's logger. */
export type RehashLog = Pick<Logger, 'warn'>;

/** A signed-in user and its x-token. The user serializes through its model's toJSON (id, uid, never password). */
export interface Session {
  token: string;
  user: SignInUser;
}

export interface AuthService {
  /** `log` reports a failed background rehash (P25); it never affects the answer. */
  login(dto: LoginDto, log: RehashLog): Promise<Session>;
  googleSignIn(dto: GoogleDto): Promise<Session>;
  /** AM-M5-4: every token of the user stops verifying, the one of this request included. */
  logoutAll(uid: string): Promise<void>;
  /** Every earlier token of the user stops verifying; the returned one keeps the caller signed in. */
  changePassword(uid: string, dto: PasswordChangeDto): Promise<{ token: string }>;
}

/**
 * Password and Google sign-in (ADR-005: the model, the token service and the Google client are injected).
 * Hashing is asynchronous at config.auth.bcryptCost (ADR-035). Throws AppErrors; knows nothing of HTTP.
 */
export function createAuthService(deps: {
  User: SignInUserModel;
  tokens: TokenService;
  google: GoogleVerifier;
  /** config.auth.bcryptCost: the cost of every hash the API writes, and of the F1 dummy. */
  bcryptCost: number;
}): AuthService {
  const { User, tokens, google, bcryptCost } = deps;

  // F1: compared against when the account has no usable hash (unknown email, Google-only account), so every
  // credential failure costs one bcrypt compare at the configured cost, the cost of every hash the API writes.
  const dummyHash = hashPassword('dummy-password', bcryptCost);

  // C5: one answer for every credential failure.
  const invalidCredentials = () => new UnauthorizedError('Invalid credentials');
  // AM-M5-9: signed at the user's own tokenVersion, or the next logout-all would lock them out of every login.
  const session = async (user: SignInUser): Promise<Session> => ({
    token: await tokens.sign(String(user._id), user.tokenVersion),
    user,
  });

  return {
    async login({ email, password }, log) {
      // AM-M4-1: the hash is select: false, so the one read that compares it asks for it.
      const user = await User.findOne({ email }, '+password');

      // The password, the user and its state fail with the same answer. An account without a usable hash is
      // compared against the dummy, and refused even if the password happens to be the dummy's.
      const hash = user?.password;
      const validPassword = await comparePassword(password, hash, await dummyHash);
      if (!user || !isUsableHash(hash) || !user.state || !validPassword) throw invalidCredentials();

      // P25: only once the compare has decided, and in the background, so it never touches this answer or its
      // timing. The swap is conditional on the old hash, so a password changed meanwhile is never overwritten.
      if (needsRehash(hash, bcryptCost)) {
        void hashPassword(password, bcryptCost)
          .then((rehashed) => User.updateOne({ _id: user._id, password: hash }, { password: rehashed }))
          .then(undefined, (err: unknown) =>
            log.warn({ err }, 'password rehash failed; the next login retries'),
          );
      }

      return session(user);
    },

    async googleSignIn({ id_token }) {
      // P27: every way a Google sign-in fails is this one answer: an invalid token, an unverified or missing address,
      // a password account's address, an inactive account.
      let profile: GoogleProfile;
      try {
        profile = await google.verify(id_token);
      } catch {
        throw invalidCredentials();
      }

      const { name, picture } = profile;
      // §10.5: the Google address is matched the way sign-up and login store and read it (trimmed, lowercased).
      const email = profile.email?.trim().toLowerCase();
      // ADR-036: an address Google has not verified proves nothing about who holds it.
      if (!profile.emailVerified || !email) throw invalidCredentials();

      const existing = await User.findOne({ email });
      // AM-M5-1: a Google sign-in never enters a password account; it would be a silent account link (SEC-12).
      if (existing && !existing.google) throw invalidCredentials();
      const user = existing ?? (await User.create({ name, email, image: picture, google: true })); // no password
      if (!user.state) throw invalidCredentials();

      return session(user);
    },

    async logoutAll(uid) {
      await User.updateOne({ _id: uid }, { $inc: { tokenVersion: 1 } });
    },

    async changePassword(uid, { currentPassword, newPassword }) {
      // F1, extended: exactly one compare at the configured cost, and the one generic answer, whether the current
      // password is wrong or the account has none to check (a Google-only account takes the dummy path).
      const user = await User.findById(uid, '+password');
      const hash = user?.password;
      const validPassword = await comparePassword(currentPassword, hash, await dummyHash);
      if (!user || !isUsableHash(hash) || !user.state || !validPassword) throw invalidCredentials();

      // One atomic update: the new hash and the next tokenVersion land together, on an account still active.
      const password = await hashPassword(newPassword, bcryptCost);
      const updated = await User.findOneAndUpdate(
        { _id: uid, state: true },
        { password, $inc: { tokenVersion: 1 } },
        { returnDocument: 'after' },
      );
      if (!updated) throw invalidCredentials();

      // A fresh token at the new tokenVersion, so the caller stays signed in here (AM-M5-4).
      return { token: await tokens.sign(String(updated._id), updated.tokenVersion) };
    },
  };
}
