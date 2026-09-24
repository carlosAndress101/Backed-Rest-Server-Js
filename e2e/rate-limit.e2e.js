// ARC-03: load models/server before any other application module.
require('../models/server');

// This file is deliberately dedicated to C5 so no other test consumes the
// limiter's budget. The enumeration check lives in auth.e2e.js.
jest.mock('../helpers/google-verify', () => ({
  googleVerify: jest.fn(),
}));

const request = require('supertest');
const mongoose = require('mongoose');

const { connectDatabase, buildApp, clearDatabase } = require('./helpers/db');
const { googleVerify } = require('../helpers/google-verify');

const LIMIT = 10;

describe('SEC-06 rate limiting on the auth surface', () => {
  let app;

  beforeAll(async () => {
    await connectDatabase();
    app = buildApp();
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await clearDatabase();
    jest.clearAllMocks();
  });

  test('POST /api/auth/login returns 429 after more than 10 requests per IP', async () => {
    const credentials = { email: 'rate-limited@example.com', password: 'whatever-123' };

    const responses = [];
    for (let i = 0; i < LIMIT + 1; i++) {
      responses.push(await request(app).post('/api/auth/login').send(credentials));
    }

    responses.slice(0, LIMIT).forEach((res) => {
      expect(res.statusCode).toBe(401);
    });
    expect(responses[LIMIT].statusCode).toBe(429);
  });

  test('POST /api/auth/google returns 429 after more than 10 requests per IP', async () => {
    googleVerify.mockResolvedValue({
      name: 'Google User',
      picture: 'https://example.com/p.png',
      email: 'rate-google@example.com',
    });

    const responses = [];
    for (let i = 0; i < LIMIT + 1; i++) {
      responses.push(await request(app).post('/api/auth/google').send({ id_token: 'fake-token' }));
    }

    expect(responses.filter((res) => res.statusCode === 429).length).toBeGreaterThanOrEqual(1);
    expect(responses[LIMIT].statusCode).toBe(429);
  });
});
