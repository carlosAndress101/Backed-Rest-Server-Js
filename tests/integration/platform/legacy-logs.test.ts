// LOG-01 / ADR-020: the legacy sites of the M2 ledger (§4.8) log through req.log, bound to the request id,
// and nothing reaches the console.
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { v2 as cloudinary } from 'cloudinary';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearLogs, loggedText, startTestApp, stopTestApp } from '../../helpers/app';
import { PASSWORD, createUser, logRecords, signIn, type SignedIn } from './support';

const PNG = Buffer.from('not really a png: the upload routes check only the extension');
const NEW_ASSET = 'https://res.cloudinary.com/demo/image/upload/v1/new-asset.png';
const OLD_ASSET = 'https://res.cloudinary.com/demo/image/upload/v1/old-asset.png';

/** The log records written for one request. */
const recordsOf = (reqId: string) => logRecords(loggedText()).filter((record) => record.reqId === reqId);

describe('LOG-01: legacy code logs through req.log, never the console', () => {
  let server: Server;
  let admin: SignedIn;
  let consoleCalls: () => number;

  beforeAll(async () => {
    server = await startTestApp({ LOG_LEVEL: 'debug' });
    admin = await signIn(server, 'ADMIN_ROLE');
  });

  beforeEach(() => {
    clearLogs();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    consoleCalls = () => spies.reduce((calls, spy) => calls + spy.mock.calls.length, 0);
  });

  afterEach(() => {
    vi.unstubAllEnvs(); // restoreMocks does not undo vi.stubEnv
  });

  afterAll(stopTestApp);

  const replaceImage = (reqId: string) =>
    request(server)
      .put(`/api/uploads/user/${admin.id}`)
      .set('x-token', admin.token)
      .set('x-request-id', reqId)
      .attach('file', PNG, 'avatar.png');

  test('a rejected token is logged at debug with its cause', async () => {
    const res = await request(server).get('/api/user').set('x-token', 'not-a-jwt').set('x-request-id', 'jwt');

    expect(res.status).toBe(401);
    expect(recordsOf('jwt')).toContainEqual(
      expect.objectContaining({
        level: 20,
        msg: 'token rejected',
        err: expect.objectContaining({ message: 'jwt malformed' }),
      }),
    );
    expect(consoleCalls()).toBe(0);
  });

  test('a token that cannot be signed rejects with the original error, which the platform logs', async () => {
    const { email } = await createUser();
    vi.stubEnv('SECRET_KEY', '');

    const res = await request(server)
      .post('/api/auth/login')
      .set('x-request-id', 'sign')
      .send({ email, password: PASSWORD });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ msg: 'Internal server error' });
    expect(recordsOf('sign')).toContainEqual(
      expect.objectContaining({
        level: 50,
        err: expect.objectContaining({ message: 'secretOrPrivateKey must have a value' }),
      }),
    );
    expect(consoleCalls()).toBe(0);
  });

  test('an orphaned Cloudinary asset is logged at error with its URL (C11)', async () => {
    vi.spyOn(cloudinary.uploader, 'upload').mockResolvedValue({ secure_url: NEW_ASSET } as never);
    vi.spyOn(mongoose.model('User').prototype, 'save').mockRejectedValueOnce(
      new Error('simulated save failure'),
    );

    const res = await replaceImage('orphan');

    expect(res.status).toBe(500);
    expect(recordsOf('orphan')).toContainEqual(
      expect.objectContaining({
        level: 50,
        msg: 'orphaned Cloudinary asset: the record was not saved',
        asset: NEW_ASSET,
        collection: 'user',
        id: admin.id,
      }),
    );
    expect(consoleCalls()).toBe(0);
  });

  test('a previous asset that cannot be destroyed is logged at warn and the update still succeeds', async () => {
    await mongoose.model('User').updateOne({ _id: admin.id }, { image: OLD_ASSET });
    vi.spyOn(cloudinary.uploader, 'upload').mockResolvedValue({ secure_url: NEW_ASSET } as never);
    vi.spyOn(cloudinary.uploader, 'destroy').mockRejectedValue(new Error('simulated destroy failure'));

    const res = await replaceImage('destroy');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ image: NEW_ASSET });
    expect(recordsOf('destroy')).toContainEqual(
      expect.objectContaining({
        level: 40,
        msg: 'previous Cloudinary asset not destroyed',
        err: expect.objectContaining({ message: 'simulated destroy failure' }),
      }),
    );
    expect(consoleCalls()).toBe(0);
  });

  test('an upload temp folder that cannot be removed is logged at warn with the folder', async () => {
    const realRm = fs.rm;
    vi.spyOn(fs, 'rm').mockImplementation(
      (target: fs.PathLike, options: fs.RmOptions, done: fs.NoParamCallback) =>
        realRm(target, options, () => done(new Error('simulated cleanup failure'))),
    );

    // the Cloudinary route: it never writes under uploads/, which the security suite owns (TEST-03)
    vi.spyOn(cloudinary.uploader, 'upload').mockResolvedValue({ secure_url: NEW_ASSET } as never);
    vi.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' });

    const res = await replaceImage('cleanup');

    expect(res.status).toBe(200);
    // the folder is removed once the response is over, so the line can follow the response
    await vi.waitFor(() =>
      expect(recordsOf('cleanup')).toContainEqual(
        expect.objectContaining({
          level: 40,
          msg: 'upload temp folder not removed',
          tempFileDir: expect.stringContaining(path.join(os.tmpdir(), 'upload-')),
          err: expect.objectContaining({ message: 'simulated cleanup failure' }),
        }),
      ),
    );
    expect(consoleCalls()).toBe(0);
  });
});
