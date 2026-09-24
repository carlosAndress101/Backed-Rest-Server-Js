import jwt from 'jsonwebtoken';

/** The x-token session token. Interim: M5 adds iss/aud/tokenVersion and moves the transport to Bearer. */
export interface TokenService {
  sign(uid: string): Promise<string>;
  /** Returns the token's uid; throws when the token is malformed, expired, badly signed or has no uid. */
  verify(token: string): { uid: string };
}

// The same payload ({ uid }), secret and lifetime as helpers/generar-jwt.js, so either side accepts the other's tokens.
const TOKEN_TTL = '4h';

export function createTokenService(secret: string): TokenService {
  return {
    sign: (uid) =>
      new Promise((resolve, reject) => {
        jwt.sign({ uid }, secret, { expiresIn: TOKEN_TTL }, (error, token) => {
          if (error) reject(error);
          else if (token === undefined) reject(new Error('jsonwebtoken returned no token'));
          else resolve(token);
        });
      }),
    verify(token) {
      const payload = jwt.verify(token, secret);
      if (typeof payload === 'string' || typeof payload.uid !== 'string') {
        throw new jwt.JsonWebTokenError('jwt payload has no uid');
      }
      return { uid: payload.uid };
    },
  };
}
