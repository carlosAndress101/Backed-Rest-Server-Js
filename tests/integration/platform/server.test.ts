// src/server.ts runs in a spawned process (the way it runs in production), so it is excluded from
// in-process coverage (vitest.config.mts).
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, inject, test, vi } from 'vitest';

const ROOT = path.join(__dirname, '..', '..', '..');
const BOOT_TIMEOUT_MS = 20_000;
const running = new Set<ChildProcess>();

interface Booted {
  readonly output: () => { stdout: string; stderr: string };
  readonly exited: Promise<number | null>;
  readonly signal: (signal: NodeJS.Signals) => void;
}

/** Starts `node --import tsx src/server.ts` with exactly `env` (plus PATH and HOME). */
function boot(env: NodeJS.ProcessEnv): Booted {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  child.once('exit', () => running.delete(child));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  return {
    output: () => ({ stdout, stderr }),
    exited: once(child, 'exit').then(([code]) => code as number | null),
    signal: (signal) => child.kill(signal),
  };
}

/** A port that is free on 127.0.0.1 right now. */
async function freePort(): Promise<number> {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  probe.close();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  return address.port;
}

const validEnv = (port: number): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  PORT: String(port),
  MONGO_CLOUD: `${inject('mongoUri')}server-${randomUUID()}`,
  SECRET_KEY: 'test-secret-at-least-32-characters-long',
  GOOGLE_CLIENT_ID: 'test-client-id',
  CLOUDINARY_URL: 'cloudinary://key:secret@demo',
});

describe('src/server.ts', () => {
  afterEach(() => {
    // a failed assertion must not leave a server running
    for (const child of running) child.kill('SIGKILL');
  });

  test.each([
    ['a required variable is missing', { SECRET_KEY: undefined }, 'SECRET_KEY'],
    ['TRUST_PROXY is not a hop count (C9)', { TRUST_PROXY: 'abc' }, 'TRUST_PROXY'],
  ])(
    'exits 1 before listening when %s',
    async (_case, overrides, variable) => {
      const server = boot({ ...validEnv(await freePort()), ...overrides });

      expect(await server.exited).toBe(1);
      const { stdout, stderr } = server.output();
      expect(stderr).toContain('ConfigError: Invalid environment');
      expect(stderr).toContain(`at ${variable}`);
      expect(stdout).not.toContain('server listening');
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'boots, serves, refuses a second instance on its port and exits 0 on SIGTERM',
    async () => {
      const port = await freePort();
      const server = boot(validEnv(port));
      await vi.waitFor(() => expect(server.output().stdout).toContain('server listening'), {
        timeout: BOOT_TIMEOUT_MS,
      });

      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-request-id')).toBeTruthy();

      const second = boot(validEnv(port));
      expect(await second.exited).toBe(1);
      expect(second.output().stderr).toContain('EADDRINUSE');

      server.signal('SIGTERM');
      expect(await server.exited).toBe(0);
      expect(server.output().stdout).toContain('shutting down');
    },
    BOOT_TIMEOUT_MS * 2,
  );
});
