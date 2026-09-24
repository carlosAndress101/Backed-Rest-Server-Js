// This file is deliberately dedicated to C5 so no other test consumes the
// limiter's budget. The enumeration check lives in auth.e2e.js.
import type { Server } from 'node:http';

import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { googleTicket, stubGoogleVerify } from '../../helpers/legacy';

const LIMIT = 10;

describe('SEC-06 rate limiting on the auth surface', () => {
  let app: Server;
  let googleVerify: ReturnType<typeof stubGoogleVerify>;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await clearDatabase();
    googleVerify = stubGoogleVerify();
  });

  test('POST /api/auth/login returns 429 after more than 10 requests per IP', async () => {
    const credentials = { email: 'rate-limited@example.com', password: 'whatever-123' };

    const responses: Response[] = [];
    for (let i = 0; i < LIMIT + 1; i++) {
      responses.push(await request(app).post('/api/auth/login').send(credentials));
    }

    responses.slice(0, LIMIT).forEach((res) => {
      expect(res.statusCode).toBe(401);
    });
    expect(responses[LIMIT]!.statusCode).toBe(429);
  });

  test('POST /api/auth/google returns 429 after more than 10 requests per IP', async () => {
    googleVerify.mockResolvedValue(
      googleTicket({
        name: 'Google User',
        picture: 'https://example.com/p.png',
        email: 'rate-google@example.com',
      }),
    );

    const responses: Response[] = [];
    for (let i = 0; i < LIMIT + 1; i++) {
      responses.push(await request(app).post('/api/auth/google').send({ id_token: 'fake-token' }));
    }

    expect(responses.filter((res) => res.statusCode === 429).length).toBeGreaterThanOrEqual(1);
    expect(responses[LIMIT]!.statusCode).toBe(429);
  });
});
