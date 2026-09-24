// The hashing module (M5 design §3.3, ADR-035): P24 async bcrypt at the configured cost, P26 the byte-counting
// policy, and the F1 building blocks (one compare, against the stored hash or the dummy).
import bcrypt from 'bcrypt';
import { describe, expect, test, vi } from 'vitest';

import {
  MAX_PASSWORD_BYTES,
  comparePassword,
  costOf,
  hashPassword,
  isUsableHash,
  needsRehash,
  passwordPolicy,
} from '../../../src/core/security/password';

const HASH_4 = bcrypt.hashSync('correct-horse', 4);

describe('passwordPolicy (P26, SEC-16)', () => {
  const issues = (value: unknown) => {
    const result = passwordPolicy.safeParse(value);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  test.each([
    ['8 characters', 'a'.repeat(8)],
    ['72 ASCII bytes', 'a'.repeat(72)],
    ['18 four-byte emoji (72 bytes)', '😀'.repeat(18)],
    ['24 three-byte characters (72 bytes)', '€'.repeat(24)],
  ])('accepts %s', (_case, password) => {
    expect(issues(password)).toEqual([]);
  });

  test.each([
    ['7 characters', 'a'.repeat(7)],
    ['73 ASCII bytes', 'a'.repeat(73)],
    // 38 UTF-16 units, so a character count would let it through; bcrypt would drop its last 4 bytes
    ['19 emoji: 76 bytes in 38 UTF-16 units', '😀'.repeat(19)],
    ['25 three-byte characters (75 bytes)', '€'.repeat(25)],
  ])('refuses %s', (_case, password) => {
    expect(issues(password)).not.toEqual([]);
  });

  // [P4]: bcrypt reads 72 bytes, so two passwords with the same first 72 bytes are the same password to it. The
  // policy refuses both before either is hashed, so no such pair can ever be stored.
  test('two passwords sharing their first 72 bytes are both refused, so bcrypt never conflates them', () => {
    const prefix = 'p'.repeat(MAX_PASSWORD_BYTES);
    const first = `${prefix}-first`;
    const second = `${prefix}-second`;

    expect(bcrypt.compareSync(second, bcrypt.hashSync(first, 4))).toBe(true); // the collision the policy prevents
    expect(issues(first)).toEqual(['must be at most 72 bytes (bcrypt only uses the first 72)']);
    expect(issues(second)).toEqual(['must be at most 72 bytes (bcrypt only uses the first 72)']);
  });

  test('refuses what is not a string', () => {
    expect(issues(12345678)).not.toEqual([]);
    expect(issues(['a'.repeat(8)])).not.toEqual([]);
  });
});

describe('hashes', () => {
  test.each([
    ['a $2b$ hash', HASH_4, true],
    ['a $2a$ hash', HASH_4.replace('$2b$', '$2a$'), true],
    ['a $2y$ hash', HASH_4.replace('$2b$', '$2y$'), false],
    ['cost 03', HASH_4.replace('$04$', '$03$'), false],
    ['cost 32', HASH_4.replace('$04$', '$32$'), false],
    ['a truncated hash', HASH_4.slice(0, -1), false],
    ["the old ':D' placeholder", ':D', false],
    ['no password at all', undefined, false],
    ['null', null, false],
  ])('isUsableHash: %s is %s', (_case, hash, usable) => {
    expect(isUsableHash(hash)).toBe(usable);
  });

  test('costOf reads the cost a hash was made at', () => {
    expect(costOf(HASH_4)).toBe(4);
    expect(costOf(bcrypt.hashSync('x', 10))).toBe(10);
  });

  test('needsRehash is true exactly when the cost differs from the configured one', () => {
    expect(needsRehash(HASH_4, 10)).toBe(true);
    expect(needsRehash(HASH_4, 4)).toBe(false);
  });

  test('hashPassword hashes asynchronously at the given cost (PERF-01)', async () => {
    const hash = vi.spyOn(bcrypt, 'hash');

    const hashed = await hashPassword('correct-horse', 5);

    expect(hash).toHaveBeenCalledExactlyOnceWith('correct-horse', 5);
    expect(costOf(hashed)).toBe(5);
    expect(await bcrypt.compare('correct-horse', hashed)).toBe(true);
  });
});

describe('comparePassword (F1)', () => {
  const DUMMY = bcrypt.hashSync('dummy-password', 4);

  test('compares once against a usable stored hash', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');

    await expect(comparePassword('correct-horse', HASH_4, DUMMY)).resolves.toBe(true);
    await expect(comparePassword('wrong', HASH_4, DUMMY)).resolves.toBe(false);

    expect(compare.mock.calls.map(([, hash]) => hash)).toEqual([HASH_4, HASH_4]);
  });

  test.each([
    ['no password (a Google-only account)', undefined],
    ["the ':D' placeholder", ':D'],
    ['a $2y$ hash', HASH_4.replace('$2b$', '$2y$')],
  ])('compares once against the dummy for %s', async (_case, stored) => {
    const compare = vi.spyOn(bcrypt, 'compare');

    await comparePassword('correct-horse', stored, DUMMY);

    expect(compare).toHaveBeenCalledExactlyOnceWith('correct-horse', DUMMY);
  });
});
