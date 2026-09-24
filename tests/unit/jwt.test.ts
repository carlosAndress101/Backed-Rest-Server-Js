// M5 design §3.1 (ADR-033/034, P21): the session token { uid, tv, iss, aud, iat, exp }, HS256 pinned on both ends.
import jwt from 'jsonwebtoken';
import { describe, expect, test, vi } from 'vitest';

import { TOKEN_AUDIENCE, TOKEN_ISSUER, createTokenService } from '../../src/core/security/jwt';

const SECRET = 'unit-test-secret-at-least-32-chars';
const UID = '64b7f0c2a1b2c3d4e5f60718';
const FOUR_HOURS = 4 * 60 * 60;
const tokens = createTokenService(SECRET, { ttlSeconds: FOUR_HOURS });

/** Signs `payload` the way the service does, with `overrides` applied: the base for every forged token below. */
const forge = (payload: object, overrides: jwt.SignOptions = {}, secret: string = SECRET) =>
  jwt.sign(payload, secret, {
    algorithm: 'HS256',
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
    expiresIn: '4h',
    ...overrides,
  });

const decode = (token: string) => jwt.decode(token, { complete: true })!;

describe('createTokenService', () => {
  test('verify returns the uid and tokenVersion of a token sign issued', async () => {
    const token = await tokens.sign(UID, 3);

    expect(tokens.verify(token)).toEqual({ uid: UID, tokenVersion: 3 });
  });

  test('sign defaults tokenVersion to 0, the version every user starts at', async () => {
    expect(tokens.verify(await tokens.sign(UID))).toEqual({ uid: UID, tokenVersion: 0 });
  });

  test('the token is HS256 with exactly { uid, tv, iss, aud, iat, exp }, living the configured TTL', async () => {
    const { header, payload } = decode(await tokens.sign(UID, 2));
    const claims = payload as jwt.JwtPayload;

    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'tv', 'uid']);
    expect(claims).toMatchObject({
      uid: UID,
      tv: 2,
      iss: 'backed-rest-server',
      aud: 'backed-rest-server-clients',
    });
    expect(claims.exp! - claims.iat!).toBe(FOUR_HOURS);
  });

  test('the TTL is whatever config gives, in seconds', async () => {
    const short = createTokenService(SECRET, { ttlSeconds: 900 });
    const claims = decode(await short.sign(UID)).payload as jwt.JwtPayload;

    expect(claims.exp! - claims.iat!).toBe(900);
  });

  test('verify returns only uid and tokenVersion, whatever else the token carries', () => {
    expect(tokens.verify(forge({ uid: UID, tv: 1, role: 'ADMIN_ROLE' }))).toEqual({
      uid: UID,
      tokenVersion: 1,
    });
  });

  // [P1] (M5 design §1, ADR-034): what an unpinned verify accepted, and what M5 must refuse.
  const rejected: [string, () => string][] = [
    ['HS384 with the same secret (alg confusion)', () => forge({ uid: UID, tv: 0 }, { algorithm: 'HS384' })],
    ['HS512 with the same secret (alg confusion)', () => forge({ uid: UID, tv: 0 }, { algorithm: 'HS512' })],
    [
      'unsigned (alg none)',
      () =>
        jwt.sign({ uid: UID, tv: 0 }, '', {
          algorithm: 'none',
          issuer: TOKEN_ISSUER,
          audience: TOKEN_AUDIENCE,
        }),
    ],
    ['for another audience', () => forge({ uid: UID, tv: 0 }, { audience: 'another-api-clients' })],
    ['from another issuer', () => forge({ uid: UID, tv: 0 }, { issuer: 'another-api' })],
    [
      'M4-shaped: { uid } only, no iss/aud/tv (every pre-M5 session)',
      () => jwt.sign({ uid: UID }, SECRET, { expiresIn: '4h' }),
    ],
    [
      'signed with another secret',
      () => forge({ uid: UID, tv: 0 }, {}, 'another-secret-at-least-32-characters'),
    ],
    ['expired', () => forge({ uid: UID, tv: 0 }, { expiresIn: -10 })],
    ['not a JWT', () => 'not-a-jwt'],
    ['without a uid', () => forge({ sub: UID, tv: 0 })],
    ['with a non-string uid', () => forge({ uid: 42, tv: 0 })],
    ['without a tv', () => forge({ uid: UID })],
    ['with a string tv', () => forge({ uid: UID, tv: '0' })],
    ['with a negative tv', () => forge({ uid: UID, tv: -1 })],
    ['with a fractional tv', () => forge({ uid: UID, tv: 0.5 })],
    [
      'without an exp (a never-expiring token)',
      () => jwt.sign({ uid: UID, tv: 0 }, SECRET, { issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE }),
    ],
    ['with a string payload', () => jwt.sign('just-a-string', SECRET)],
  ];

  test.each(rejected)('verify throws for a token %s', (_case, token) => {
    expect(() => tokens.verify(token())).toThrow(jwt.JsonWebTokenError);
  });

  test('the fixed iss/aud and HS256 are what verify requires: the forge baseline itself is accepted', () => {
    expect(tokens.verify(forge({ uid: UID, tv: 0 }))).toEqual({ uid: UID, tokenVersion: 0 });
  });

  test('sign rejects when jsonwebtoken yields neither an error nor a token', async () => {
    vi.spyOn(jwt, 'sign').mockImplementation((...args: unknown[]) => {
      (args[3] as jwt.SignCallback)(null, undefined);
    });

    await expect(tokens.sign(UID)).rejects.toThrow('jsonwebtoken returned no token');
  });

  test('sign rejects with the jsonwebtoken error when the secret is empty', async () => {
    await expect(createTokenService('', { ttlSeconds: FOUR_HOURS }).sign(UID)).rejects.toThrow(
      'secretOrPrivateKey must have a value',
    );
  });
});
