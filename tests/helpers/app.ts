// Contract P6 (M2 design §5.1, §7.2): the harness every integration test file builds its app with.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type { Express } from 'express';
import mongoose from 'mongoose';
import { inject } from 'vitest';

import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createLogger } from '../../src/core/logger';
import { connectDatabase, disconnectDatabase } from '../../src/database/connection';

// One database per test file (each file runs in its own process), shared by every app the file builds.
const DATABASE_URI = `${inject('mongoUri')}test-${randomUUID()}`;
const logLines: string[] = [];
const servers: Server[] = [];

/**
 * Builds the app from `process.env` merged with `overrides` (C9 tests pass e.g. `{ TRUST_PROXY: '1' }`).
 * Rejects with ConfigError when the merged env is invalid. Connects the file's database on first use.
 */
export async function startTestApp(overrides: NodeJS.ProcessEnv = {}): Promise<Server> {
  const config = loadConfig({ ...process.env, MONGO_CLOUD: DATABASE_URI, ...overrides });
  if (mongoose.connection.readyState === mongoose.ConnectionStates.disconnected) {
    await connectDatabase(config.mongoUri);
  }
  const app = createApp({
    config,
    logger: createLogger(config, { write: (line: string) => logLines.push(line) }),
  });
  return serve(app); // TEST-02: never hand SuperTest a bare app (AM-5)
}

/** Listens on 127.0.0.1 (never `::`) so no other local process can own the port (TEST-04: HTTP/1.1 keep-alive, the Node default). */
function serve(app: Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(server);
    });
  });
}

/** Closes every server this file started, then drops the file's database and disconnects. */
export async function stopTestApp(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
}

export async function clearDatabase(): Promise<void> {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
}

/** Everything the app logged since the last clearLogs(); tests log nothing unless they pass a LOG_LEVEL override. */
export const loggedText = (): string => logLines.join('');
export const clearLogs = (): void => {
  logLines.length = 0;
};
