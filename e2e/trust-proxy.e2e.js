// ARC-03: load models/server before any other application module.
require('../models/server');

// This file gets its own module registry, so the C5 limiter starts with a
// fresh budget here. Every request sends an empty body: the limiter runs
// before validation, so each one is counted and answered 400 until the 429.

const request = require('supertest');

const Server = require('../models/server');

const LIMIT = 10;

const login = (app, forwardedFor) => {
  const test = request(app).post('/api/auth/login').send({});
  return forwardedFor ? test.set('X-Forwarded-For', forwardedFor) : test;
};

describe('SEC-15 / C9 proxy trust is configured by TRUST_PROXY', () => {
  const original = process.env.TRUST_PROXY;

  const buildWith = (value) => {
    if (value === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = value;
    }
    return new Server().app;
  };

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = original;
    }
  });

  describe('parsing', () => {
    test('unset or empty keeps the Express default (no proxy trusted)', () => {
      expect(buildWith(undefined).get('trust proxy')).toBe(false);
      expect(buildWith('').get('trust proxy')).toBe(false);
    });

    test('a non-negative integer becomes the trusted hop count', () => {
      expect(buildWith('0').get('trust proxy')).toBe(0);
      expect(buildWith('1').get('trust proxy')).toBe(1);
      expect(buildWith('2').get('trust proxy')).toBe(2);
    });

    test.each(['abc', '-1', 'true', '1.5', ' 1', 'loopback'])(
      'TRUST_PROXY=%p makes new Server() throw',
      (value) => {
        expect(() => buildWith(value)).toThrow(/TRUST_PROXY must be a non-negative integer/);
      }
    );
  });

  describe('the auth limiter keys on the client address', () => {
    test('with TRUST_PROXY=1, clients behind the proxy have independent budgets', async () => {
      const app = buildWith('1');
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
      const app = buildWith(undefined);

      for (let i = 0; i < LIMIT; i++) {
        expect((await login(app, `198.51.100.${i + 1}`)).statusCode).toBe(400);
      }

      expect((await login(app, '198.51.100.200')).statusCode).toBe(429);
      expect((await login(app)).statusCode).toBe(429);
    });
  });
});
