import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';

import bcrypt from 'bcrypt';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';

const PASSWORD = 'platform-password';

export interface SignedIn {
  readonly id: string;
  readonly token: string;
}

/**
 * Creates a user straight in the file's database and signs in through the real login route. Each call
 * spends one request of the per-process login limiter (10 per window), so a file signs in sparingly.
 */
export async function signIn(
  server: Server,
  role: 'USER_ROLE' | 'ADMIN_ROLE' = 'USER_ROLE',
): Promise<SignedIn> {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  // The legacy models are registered by createApp's first require of the legacy routers.
  const user = await mongoose.model('User').create({
    name: 'Platform User',
    email,
    password: await bcrypt.hash(PASSWORD, 4),
    role,
  });
  const res = await request(server).post('/api/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: String(user._id), token: res.body.token };
}

export type AppRequest = IncomingMessage & { body?: unknown; app: Express };

/**
 * Sends one request and returns the response together with the request object the app handled, read after
 * the response: tests see `req.body` as the handlers left it, and `req.app`, without reaching into the harness.
 */
export async function requestSeenByApp<T>(
  server: Server,
  send: () => PromiseLike<T>,
): Promise<{ req: AppRequest; res: T }> {
  const seen: AppRequest[] = [];
  const record = (req: AppRequest) => void seen.push(req);
  server.on('request', record);
  let res: T;
  try {
    res = await send();
  } finally {
    server.off('request', record);
  }
  const [req] = seen;
  if (seen.length !== 1 || req === undefined) throw new Error(`expected one request, saw ${seen.length}`);
  return { req, res };
}

/** Parses the JSON lines the app logged. */
export const logRecords = (text: string): Record<string, unknown>[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
