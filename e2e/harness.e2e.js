// ARC-03: load models/server before any other application module.
require('../models/server');

const { spawn } = require('child_process');
const request = require('supertest');

const { buildApp, closeServers } = require('./helpers/db');

/** Asks another process to listen on 127.0.0.1:<port>; resolves to 'listening' or the error code. */
const bindFromAnotherProcess = (port) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e',
      `require('net').createServer().once('error', (e) => { console.log(e.code); process.exit(0); })
         .listen(${port}, '127.0.0.1', () => { console.log('listening'); process.exit(0); });`,
    ]);
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('exit', () => resolve(out.trim()));
  });

// TEST-02 (T1.8): SuperTest given a bare app listens on the dual-stack wildcard (::)
// but connects to 127.0.0.1, and on macOS another process listening on 127.0.0.1
// with the same port answered the tests' requests instead of the app.
describe('TEST-02 the test harness serves the app on a port no other process can take', () => {
  let server;

  beforeAll(async () => {
    server = await buildApp();
  });

  afterAll(async () => {
    await closeServers();
  });

  test('buildApp() listens on 127.0.0.1, not on the wildcard', () => {
    expect(server.address().address).toBe('127.0.0.1');
  });

  test('another process cannot listen on the same loopback port', async () => {
    expect(await bindFromAnotherProcess(server.address().port)).toBe('EADDRINUSE');
  });

  test('requests reach the app itself', async () => {
    const res = await request(server).get('/api/no-such-route');

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ msg: 'Route not found' });
  });
});
