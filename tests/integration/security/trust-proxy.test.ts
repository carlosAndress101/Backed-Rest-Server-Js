// This file gets its own module registry, so the C5 limiter starts with a
// fresh budget here. Every request sends an empty body: the limiter runs
// before validation, so each one is counted and answered 400 until the 429.
import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, describe, expect, inject, test } from 'vitest';

import { createApp } from '../../../src/app';
import { ConfigError, loadConfig } from '../../../src/config';
import { createLogger } from '../../../src/core/logger';
import { startTestApp, stopTestApp } from '../../helpers/app';

const LIMIT = 10;

const login = (app: Server, forwardedFor?: string) => {
  const test = request(app).post('/api/auth/login').send({});
  return forwardedFor ? test.set('X-Forwarded-For', forwardedFor) : test;
};

describe('SEC-15 / C9 proxy trust is configured by TRUST_PROXY', () => {
  const buildWith = (value?: string) => startTestApp({ TRUST_PROXY: value });

  // AM-5: startTestApp() resolves to the http.Server, which does not expose the Express app,
  // so the parsing tests read the setting from the app it serves: createApp(loadConfig(env)).
  const appWith = (value?: string) => {
    const config = loadConfig({ ...process.env, MONGO_CLOUD: inject('mongoUri'), TRUST_PROXY: value });
    return createApp({ config, logger: createLogger(config) });
  };

  afterAll(async () => {
    await stopTestApp();
  });

  describe('parsing', () => {
    test('unset or empty keeps the Express default (no proxy trusted)', () => {
      expect(appWith(undefined).get('trust proxy')).toBe(false);
      expect(appWith('').get('trust proxy')).toBe(false);
    });

    test('a non-negative integer becomes the trusted hop count', () => {
      expect(appWith('0').get('trust proxy')).toBe(0);
      expect(appWith('1').get('trust proxy')).toBe(1);
      expect(appWith('2').get('trust proxy')).toBe(2);
    });

    test.each(['abc', '-1', 'true', '1.5', ' 1', 'loopback'])(
      'TRUST_PROXY=%j makes new Server() throw',
      async (value) => {
        await expect(buildWith(value)).rejects.toThrow(ConfigError);
        await expect(buildWith(value)).rejects.toThrow(/TRUST_PROXY/);
      },
    );
  });

  describe('the auth limiter keys on the client address', () => {
    test('with TRUST_PROXY=1, clients behind the proxy have independent budgets', async () => {
      const app = await buildWith('1');
      const clientA = '203.0.113.10';
      const clientB = '203.0.113.20';

      for (let i = 0; i < LIMIT; i++) {
        expect((await login(app, clientA)).statusCode).toBe(400);
      }
      expect((await login(app, clientA)).statusCode).toBe(429);

      // Another client behind the same proxy is not locked out by client A.
      expect((await login(app, clientB)).statusCode).toBe(400);
      expect((await login(app, clientA)).statusCode).toBe(429);
    });

    test('with TRUST_PROXY unset, rotating X-Forwarded-For does not escape the limit', async () => {
      const app = await buildWith(undefined);

      for (let i = 0; i < LIMIT; i++) {
        expect((await login(app, `198.51.100.${i + 1}`)).statusCode).toBe(400);
      }

      expect((await login(app, '198.51.100.200')).statusCode).toBe(429);
      expect((await login(app)).statusCode).toBe(429);
    });
  });
});
