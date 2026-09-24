// C10 over real HTTP (T3.7R): however an upload request ends, its temp folder is gone by the time the server has
// handled the response's close. It is checked right then, never polled: a process that exits next (a shutdown, a
// test worker's SIGTERM) must find nothing left to remove. Only the parser, its checks and the error handler run;
// no database, no Cloudinary.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

import express, { type RequestHandler } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';

import { NotFoundError } from '../../../src/core/errors';
import { errorHandler } from '../../../src/middlewares/error-handler';
import { fileParser, MAX_FILE_BYTES, requireImage } from '../../../src/modules/media/media.upload';
import { listTempFiles, newTempFiles } from '../../helpers/uploads';

const BOUNDARY = 't37r-boundary';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const partHead = (field = 'file', filename = 'photo.png') =>
  Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      'Content-Type: image/png\r\n\r\n',
  );
const partEnd = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
const nextPart = Buffer.from(`\r\n--${BOUNDARY}\r\n`);
const filePart = (content: Buffer, field = 'file') => Buffer.concat([partHead(field), content]);
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What the route does after the parser, by outcome.
const outcomes: Record<string, RequestHandler> = {
  stored: (_req, res) => void res.status(200).json({ data: 'stored' }),
  missing: () => {
    throw new NotFoundError('User not found');
  },
  failing: () => {
    throw new Error('cloudinary is down');
  },
};
const outcome: RequestHandler = (req, res, next) => outcomes[String(req.params.outcome)]!(req, res, next);
const withLog: RequestHandler = (req, _res, next) => {
  Object.assign(req, { log: { warn: vi.fn() } });
  next();
};
const slowStart: RequestHandler = (_req, _res, next) => void setTimeout(next, 100); // as authenticate's lookup

const app = express();
app.put('/upload/:outcome', withLog, fileParser, requireImage, outcome);
app.put('/slow/:outcome', withLog, slowStart, fileParser, requireImage, outcome);
app.use(errorHandler);

describe('an upload request leaves no temp folder once its response has closed', () => {
  let server: http.Server;
  let port: number;
  let closeHandled: () => void = () => undefined;
  let mkdirSync: MockInstance<typeof fs.mkdirSync>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      // Registered before the app's listeners, so this runs once every close listener, fileParser's included, has.
      res.on('close', () => setImmediate(() => closeHandled()));
      app(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    ({ port } = server.address() as net.AddressInfo);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    mkdirSync = vi.spyOn(fs, 'mkdirSync');
  });

  /** The per-request folders express-fileupload created during the test. */
  const foldersCreated = () =>
    mkdirSync.mock.calls.filter(([dir]) => String(dir).includes(`upload-${process.pid}-`)).length;

  /** Runs one request; resolves once the server has handled its response's close, with what the client saw. */
  const exchange = async (send: () => Promise<number | string>) => {
    const before = listTempFiles();
    const handled = new Promise<void>((resolve) => {
      closeHandled = resolve;
    });
    const seen = await send();
    await handled;
    return { seen, leftBehind: newTempFiles(before) };
  };

  /** A PUT through http.request: the status, or the socket error when the server cut the upload short. */
  const put = (url: string, body: Buffer) =>
    new Promise<number | string>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: url,
          headers: {
            'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
            'content-length': body.length,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        },
      );
      req.on('error', (err: NodeJS.ErrnoException) => resolve(err.code!)); // TEST-04: an early 413 can reset it
      req.end(body);
    });

  test.each([
    ['a stored image', '/upload/stored', Buffer.concat([filePart(PNG), partEnd]), 200],
    ['no file in the "file" field', '/upload/stored', Buffer.concat([filePart(PNG, 'other'), partEnd]), 400],
    [
      'a file that is not an image (MIME)',
      '/upload/stored',
      Buffer.concat([filePart(Buffer.from('<svg/>')), partEnd]),
      400,
    ],
    ['a record that does not exist (404)', '/upload/missing', Buffer.concat([filePart(PNG), partEnd]), 404],
    ['a controller error (500)', '/upload/failing', Buffer.concat([filePart(PNG), partEnd]), 500],
    [
      'a parse error after a complete file part',
      '/upload/stored',
      Buffer.concat([
        filePart(PNG),
        nextPart,
        Buffer.from('Content-Disposition: form-data; name="x"\r\n\r\nno end'),
      ]),
      400,
    ],
    ['a body that ends in the middle of the file', '/upload/stored', filePart(PNG), 400],
    [
      'two files (only the first is written)',
      '/upload/stored',
      Buffer.concat([filePart(PNG), nextPart, partHead(), PNG, partEnd]),
      200,
    ],
  ])('%s', async (_case, url, body, status) => {
    const { seen, leftBehind } = await exchange(() => put(url, body));

    expect(seen).toBe(status);
    expect(foldersCreated()).toBe(1);
    expect(leftBehind).toEqual([]);
  });

  test('a file over 5 MB (413)', async () => {
    const tooBig = Buffer.concat([filePart(Buffer.alloc(MAX_FILE_BYTES + 1024, 1)), partEnd]);

    const { seen, leftBehind } = await exchange(() => put('/upload/stored', tooBig));

    expect([413, 'EPIPE', 'ECONNRESET']).toContain(seen);
    expect(foldersCreated()).toBe(1);
    expect(leftBehind).toEqual([]);
  });

  /** Sends the request head and `sent` bytes of a longer body, then destroys the socket once `until` holds. */
  const abortedUpload = (url: string, sent: Buffer, until: () => boolean) =>
    new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          `PUT ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: multipart/form-data; boundary=${BOUNDARY}\r\n` +
            `Content-Length: ${sent.length + 1024 * 1024}\r\n\r\n`,
        );
        socket.write(sent);
        void vi
          .waitFor(() => expect(until()).toBe(true))
          .then(() => {
            socket.destroy();
            resolve('aborted');
          });
      });
    });

  test('a client that aborts mid-upload', async () => {
    const { seen, leftBehind } = await exchange(() =>
      abortedUpload('/upload/stored', filePart(Buffer.alloc(64 * 1024, 1)), () => foldersCreated() === 1),
    );

    expect(seen).toBe('aborted');
    expect(leftBehind).toEqual([]);
  });

  test('a client that leaves before the parser starts', async () => {
    const before = listTempFiles();
    const whole = Buffer.concat([filePart(PNG), partEnd]);

    await exchange(() => abortedUpload('/slow/stored', whole, () => true));
    await later(200); // the parser's turn only comes after the client has left

    expect(foldersCreated()).toBe(0);
    expect(newTempFiles(before)).toEqual([]);
  });
});
