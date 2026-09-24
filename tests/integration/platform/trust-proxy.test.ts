// The C5 login limiter belongs to the auth module, so each app below has its own, with a fresh budget, and
// keys it on a different address.
import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, describe, expect, test } from 'vitest';

import { startTestApp, stopTestApp } from '../../helpers/app';
import { requestSeenByApp } from './support';

/** One login attempt (an empty body: the limiter runs before validation and counts it). */
const login = (server: Server, forwardedFor: string) =>
  request(server).post('/api/auth/login').set('X-Forwarded-For', forwardedFor).send({});

/** The `remaining` count of the draft-7 `RateLimit` header. */
const remaining = (res: { headers: Record<string, string> }): number =>
  Number(/remaining=(\d+)/.exec(res.headers.ratelimit ?? '')?.[1]);

describe('C9: createApp applies config.trustProxy to req.ip, the C5 limiter key', () => {
  afterAll(stopTestApp);

  test('with TRUST_PROXY=1 each client behind the proxy has its own budget', async () => {
    const server = await startTestApp({ TRUST_PROXY: '1' });

    const { req, res: first } = await requestSeenByApp(server, () => login(server, '203.0.113.10'));
    const other = await login(server, '203.0.113.20');
    const repeat = await login(server, '203.0.113.10');

    expect(req.app.get('trust proxy')).toBe(1);
    expect([first.status, other.status, repeat.status]).toEqual([422, 422, 422]);
    expect([remaining(first), remaining(other), remaining(repeat)]).toEqual([9, 9, 8]);
  });

  test('with TRUST_PROXY unset, X-Forwarded-For is ignored and every request shares the socket budget', async () => {
    const server = await startTestApp({ TRUST_PROXY: undefined });

    const { req, res: first } = await requestSeenByApp(server, () => login(server, '198.51.100.1'));
    const rotated = await login(server, '198.51.100.2');

    expect(req.app.get('trust proxy')).toBe(false);
    expect([first.status, rotated.status]).toEqual([422, 422]);
    expect([remaining(first), remaining(rotated)]).toEqual([9, 8]);
  });
});
