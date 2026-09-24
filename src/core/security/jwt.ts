import jwt from 'jsonwebtoken';

/** What a session token proves besides the registered claims (ADR-033/034, P21). */
export interface TokenClaims {
  readonly uid: string;
  /** The user's tokenVersion when the token was signed; a later bump revokes the token (ADR-033). */
  readonly tokenVersion: number;
}

/** The session token: `{ uid, tv, iss, aud, iat, exp }`, HS256. The transport is Bearer, x-token until 4.0.0. */
export interface TokenService {
  /**
   * Signs a token for `uid` at `tokenVersion`. The default 0 keeps the M4 call site compiling until T5.2 passes
   * the user's own version; a wrong version fails closed (the token is refused), never open.
   */
  sign(uid: string, tokenVersion?: number): Promise<string>;
  /** Returns the claims; throws when the token is malformed, expired, badly signed, or fails alg/iss/aud. */
  verify(token: string): TokenClaims;
}

export interface TokenServiceOptions {
  /** config.auth.jwtTtlSeconds (JWT_TTL, default 4h). */
  readonly ttlSeconds: number;
}

// ADR-034: they identify this API, so they are code, never per-deployment configuration.
export const TOKEN_ISSUER = 'backed-rest-server';
export const TOKEN_AUDIENCE = 'backed-rest-server-clients';
// Pinned on sign and on verify: an unpinned verify also accepts HS384/HS512 tokens made with the same secret.
const ALGORITHM = 'HS256';

export function createTokenService(secret: string, { ttlSeconds }: TokenServiceOptions): TokenService {
  return {
    sign: (uid, tokenVersion = 0) =>
      new Promise((resolve, reject) => {
        const options: jwt.SignOptions = {
          algorithm: ALGORITHM,
          issuer: TOKEN_ISSUER,
          audience: TOKEN_AUDIENCE,
          expiresIn: ttlSeconds,
        };
        jwt.sign({ uid, tv: tokenVersion }, secret, options, (error, token) => {
          if (error) reject(error);
          else if (token === undefined) reject(new Error('jsonwebtoken returned no token'));
          else resolve(token);
        });
      }),
    verify(token) {
      const payload = jwt.verify(token, secret, {
        algorithms: [ALGORITHM],
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
      });
      if (
        typeof payload === 'string' ||
        typeof payload.uid !== 'string' ||
        !Number.isInteger(payload.tv) ||
        (payload.tv as number) < 0 ||
        typeof payload.exp !== 'number'
      ) {
        throw new jwt.JsonWebTokenError('jwt payload has no uid, tv or exp');
      }
      return { uid: payload.uid, tokenVersion: payload.tv as number };
    },
  };
}
