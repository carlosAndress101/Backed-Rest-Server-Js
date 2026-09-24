// C5 / SEC-06. The auth module creates one limiter per app, shared by /login and /google, so every test here
// gets its own app and starts from a fresh budget. The enumeration check lives in auth.test.ts.
import type { Server } from 'node:http';

import request, { type Response } from 'supertest';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';

import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { stubGoogleClient } from '../../helpers/auth';

const LIMIT = 10;
const RATE_LIMITED = {
  error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
};
const credentials = { email: 'rate-limited@example.com', password: 'whatever-123' };

const login = (app: Server, path = '/api/auth/login') => request(app).post(path).send(credentials);
const googleSignin = (app: Server, path = '/api/auth/google') =>
  request(app).post(path).send({ id_token: 'fake-token' });

/** Sends the requests one after another, so the limiter counts them in order. */
const inOrder = async (sends: Array<() => PromiseLike<Response>>): Promise<Response[]> => {
  const responses: Response[] = [];
  for (const send of sends) responses.push(await send());
  return responses;
};

describe('SEC-06 rate limiting on the auth surface', () => {
  let app: Server;

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    app = await startTestApp(); // a new app: a new limiter with a fresh budget
    await clearDatabase();
    stubGoogleClient({
      name: 'Google User',
      picture: 'https://example.com/p.png',
      email: 'rate-google@example.com',
    });
  });

  test('POST /api/auth/login returns 429 after more than 10 requests per IP', async () => {
    const responses = await inOrder(Array.from({ length: LIMIT + 1 }, () => () => login(app)));

    responses.slice(0, LIMIT).forEach((res) => {
      expect(res.statusCode).toBe(401);
    });
    expect(responses[LIMIT]!.statusCode).toBe(429);
    expect(responses[LIMIT]!.body).toEqual(RATE_LIMITED);
  });

  test('POST /api/auth/google returns 429 after more than 10 requests per IP', async () => {
    const responses = await inOrder(Array.from({ length: LIMIT + 1 }, () => () => googleSignin(app)));

    responses.slice(0, LIMIT).forEach((res) => {
      expect(res.statusCode).toBe(200);
    });
    expect(responses[LIMIT]!.statusCode).toBe(429);
    expect(responses[LIMIT]!.body).toEqual(RATE_LIMITED);
  });

  test('/login and /google spend one shared budget', async () => {
    // Alternating the routes: 5 logins and 5 Google sign-ins use up the budget of both.
    const spent = await inOrder(
      Array.from({ length: LIMIT }, (_, i) => () => (i % 2 ? googleSignin(app) : login(app))),
    );
    const [nextLogin, nextGoogle] = await inOrder([() => login(app), () => googleSignin(app)]);

    expect(spent.map((res) => res.statusCode)).toEqual([401, 200, 401, 200, 401, 200, 401, 200, 401, 200]);
    expect(nextLogin!.statusCode).toBe(429);
    expect(nextGoogle!.statusCode).toBe(429);
  });

  test('malformed requests spend the budget too: the limiter runs before validation', async () => {
    const malformed = await inOrder([
      ...Array.from({ length: LIMIT / 2 }, () => () => request(app).post('/api/auth/login').send({})),
      ...Array.from({ length: LIMIT / 2 }, () => () => request(app).post('/api/auth/google').send({})),
    ]);
    const res = await login(app);

    malformed.forEach((spent) => {
      expect(spent.statusCode).toBe(422);
    });
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual(RATE_LIMITED);
  });

  // Express matches paths case-insensitively and ignores a trailing slash: each variant reaches the same
  // route, and so the same limiter, which keys on the client alone.
  test.each([
    ['/api/AUTH/login', 'login'],
    ['/api/auth/login/', 'login'],
    ['/api/Auth/LOGIN', 'login'],
    ['/api/auth/GOOGLE', 'google'],
    ['/api/auth/google/', 'google'],
  ] as const)('the path variant %s shares the budget', async (path, route) => {
    const spent = await inOrder(Array.from({ length: LIMIT }, () => () => login(app)));
    const res = await (route === 'login' ? login(app, path) : googleSignin(app, path));

    expect(spent.every((r) => r.statusCode === 401)).toBe(true);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual(RATE_LIMITED);
  });

  test('a path that is not an auth route is 404 and never signs in', async () => {
    const spent = await inOrder(Array.from({ length: LIMIT }, () => () => login(app)));
    const encoded = await login(app, '/api/auth/%6Cogin');
    const doubled = await login(app, '/api/auth//login');

    expect(spent.every((r) => r.statusCode === 401)).toBe(true);
    expect(encoded.statusCode).toBe(404);
    expect(doubled.statusCode).toBe(404);
  });

  test('the limiter sends the draft-7 headers only, and Retry-After on the 429', async () => {
    const responses = await inOrder(Array.from({ length: LIMIT + 1 }, () => () => login(app)));
    const first = responses[0]!;
    const limited = responses[LIMIT]!;

    expect(first.headers['ratelimit']).toMatch(/^limit=10, remaining=9, reset=\d+$/);
    expect(first.headers['ratelimit-policy']).toBe('10;w=900');
    expect(limited.headers['ratelimit']).toMatch(/^limit=10, remaining=0, reset=\d+$/);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    for (const res of [first, limited]) {
      expect(Object.keys(res.headers).filter((name) => name.startsWith('x-ratelimit'))).toEqual([]);
    }
  });
});
