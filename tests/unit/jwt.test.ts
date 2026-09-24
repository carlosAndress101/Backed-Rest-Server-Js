// M3 design §3.6: the x-token service. Interim: the same payload, secret and lifetime as 2.x issued.
import jwt from 'jsonwebtoken';
import { describe, expect, test, vi } from 'vitest';

import { createTokenService } from '../../src/core/security/jwt';

const SECRET = 'unit-test-secret';
const UID = '64b7f0c2a1b2c3d4e5f60718';
const FOUR_HOURS = 4 * 60 * 60;
const tokens = createTokenService(SECRET);

describe('createTokenService', () => {
  test('verify returns the uid of a token sign issued', async () => {
    const token = await tokens.sign(UID);

    expect(tokens.verify(token)).toEqual({ uid: UID });
  });

  test('the payload is { uid } and the token lives 4 hours', async () => {
    const payload = jwt.decode(await tokens.sign(UID)) as jwt.JwtPayload;

    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'uid']);
    expect(payload.uid).toBe(UID);
    expect(payload.exp! - payload.iat!).toBe(FOUR_HOURS);
  });

  test('verify returns only the uid, whatever else the token carries', () => {
    const token = jwt.sign({ uid: UID, role: 'ADMIN_ROLE' }, SECRET);

    expect(tokens.verify(token)).toEqual({ uid: UID });
  });

  test('a token 2.x issued stays valid, and its own tokens verify as 2.x verified them', async () => {
    // 2.x signed { uid } with the secret for 4 hours, and verified with jsonwebtoken's defaults.
    const issuedBy2x = jwt.sign({ uid: UID }, SECRET, { expiresIn: '4h' });

    expect(tokens.verify(issuedBy2x)).toEqual({ uid: UID });
    expect(jwt.verify(await tokens.sign(UID), SECRET)).toMatchObject({ uid: UID });
  });

  const rejected: [string, () => string][] = [
    ['signed with another secret', () => jwt.sign({ uid: UID }, 'another-secret')],
    ['expired', () => jwt.sign({ uid: UID, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET)],
    ['not a JWT', () => 'not-a-jwt'],
    ['unsigned (alg none)', () => jwt.sign({ uid: UID }, '', { algorithm: 'none' })],
    ['without a uid', () => jwt.sign({ sub: UID }, SECRET)],
    ['with a non-string uid', () => jwt.sign({ uid: 42 }, SECRET)],
    ['with a string payload', () => jwt.sign('just-a-string', SECRET)],
  ];

  test.each(rejected)('verify throws for a token %s', (_case, token) => {
    expect(() => tokens.verify(token())).toThrow(jwt.JsonWebTokenError);
  });

  test('sign rejects when jsonwebtoken yields neither an error nor a token', async () => {
    vi.spyOn(jwt, 'sign').mockImplementation((...args: unknown[]) => {
      (args[3] as jwt.SignCallback)(null, undefined);
    });

    await expect(tokens.sign(UID)).rejects.toThrow('jsonwebtoken returned no token');
  });

  test('sign rejects with the jsonwebtoken error when the secret is empty', async () => {
    await expect(createTokenService('').sign(UID)).rejects.toThrow('secretOrPrivateKey must have a value');
  });
});
