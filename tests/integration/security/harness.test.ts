import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { startTestApp, stopTestApp } from '../../helpers/app';
import { expectStatus } from '../../helpers/assert';

const IN_USE = 3;

/**
 * Asks another process to listen on 127.0.0.1:<port> and resolves to 'listening' or
 * 'EADDRINUSE'. The child answers through its exit code: stdout written right before
 * process.exit() can be lost on a pipe.
 */
const bindFromAnotherProcess = (port: number) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e',
      `const server = require('net').createServer();
       server.once('error', (e) => { process.exitCode = e.code === 'EADDRINUSE' ? ${IN_USE} : 1; });
       server.listen(${port}, '127.0.0.1', () => server.close());`,
    ]);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve('listening');
      else if (code === IN_USE) resolve('EADDRINUSE');
      else reject(new Error(`bind probe exited with ${code}`));
    });
  });

// TEST-02 (T1.8): SuperTest given a bare app listens on the dual-stack wildcard (::)
// but connects to 127.0.0.1, and on macOS another process listening on 127.0.0.1
// with the same port answered the tests' requests instead of the app.
describe('TEST-02 the test harness serves the app on a port no other process can take', () => {
  let server: Server;

  beforeAll(async () => {
    server = await startTestApp();
  });

  afterAll(async () => {
    await stopTestApp();
  });

  test('buildApp() listens on 127.0.0.1, not on the wildcard', () => {
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  test('another process cannot listen on the same loopback port', async () => {
    expect(await bindFromAnotherProcess((server.address() as AddressInfo).port)).toBe('EADDRINUSE');
  });

  test('requests reach the app itself', async () => {
    const res = await request(server).get('/api/no-such-route');

    expectStatus(res, 404);
    expect(res.body).toEqual({ msg: 'Route not found' });
  });
});
