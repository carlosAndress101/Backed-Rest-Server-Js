// SEC-08 (ADR-030): an upload is an image by its magic bytes, never by its name or its Content-Type; and the
// parser's own quirks (C10, HTTP-02).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import type { Request, Response } from 'express';
import { describe, expect, test, vi } from 'vitest';

import { PayloadTooLargeError } from '../../../src/core/errors';
import { fileParser, isSupportedImage, MAX_FILE_BYTES } from '../../../src/modules/media/media.upload';
import { listTempFiles, newTempFiles, waitForNoTempLeak } from '../../helpers/uploads';

describe('isSupportedImage', () => {
  test.each([
    ['PNG', '89504e470d0a1a0a'],
    ['JPEG (JFIF)', 'ffd8ffe000104a46'],
    ['JPEG (Exif)', 'ffd8ffe1'],
    ['GIF87a', '474946383761'],
    ['GIF89a', '474946383961'],
  ])('accepts %s', (_type, hex) => {
    expect(isSupportedImage(Buffer.from(hex, 'hex'))).toBe(true);
  });

  test.each([
    ['an empty file', ''],
    ['a truncated PNG signature', '895049'],
    ['a truncated JPEG signature', 'ffd8'],
    ['WebP', '52494646'],
    ['BMP', '424d'],
    ['PDF', '25504446'],
    ['SVG', '3c737667'],
    ['HTML', '3c21646f'],
    ['a PHP script', '3c3f7068'],
    ['ZIP', '504b0304'],
    ['a PNG signature one byte in', '0089504e47'],
  ])('rejects %s', (_type, hex) => {
    expect(isSupportedImage(Buffer.from(hex, 'hex'))).toBe(false);
  });
});

test('the size limit is 5 MB', () => {
  expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
});

describe('fileParser', () => {
  test('a body cut off mid-file settles the request once, though express-fileupload reports it twice', async () => {
    const before = listTempFiles();
    const body = Buffer.from(
      '--b\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nffd8ff',
    );
    const req = Object.assign(new PassThrough(), {
      method: 'PUT',
      headers: { 'content-type': 'multipart/form-data; boundary=b', 'content-length': String(body.length) },
      log: { warn: vi.fn() },
    });
    const res = new EventEmitter();
    const next = vi.fn();

    fileParser(req as unknown as Request, res as unknown as Response, next);
    req.end(body);

    // The file stream fails first (next() with no file), then the form ("Unexpected end of form"):
    // only the first may reach Express, or the second hits the final handler after the response.
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(next).toHaveBeenCalledTimes(1);

    res.emit('close');
    expect(await waitForNoTempLeak(before)).toEqual([]);
  });

  test('a file over 5 MB is a PayloadTooLargeError with the upload message (F4, AM-M3-10)', async () => {
    const before = listTempFiles();
    const body = Buffer.concat([
      Buffer.from(
        '--b\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n',
      ),
      Buffer.alloc(MAX_FILE_BYTES + 1, 1),
      Buffer.from('\r\n--b--\r\n'),
    ]);
    const req = Object.assign(new PassThrough(), {
      method: 'PUT',
      headers: { 'content-type': 'multipart/form-data; boundary=b', 'content-length': String(body.length) },
      log: { warn: vi.fn() },
    });
    const res = Object.assign(new EventEmitter(), { headersSent: false });
    // As the error handler does: it answers before express-fileupload aborts, which then only drains the body.
    const next = vi.fn(() => {
      res.headersSent = true;
    });

    fileParser(req as unknown as Request, res as unknown as Response, next);
    req.end(body);

    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    const [error] = next.mock.calls[0] as unknown[];
    expect(error).toBeInstanceOf(PayloadTooLargeError);
    expect(error).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'The file is larger than 5 MB',
    });

    res.emit('close');
    expect(await waitForNoTempLeak(before)).toEqual([]);
  });

  // T3.7R: the folder used to be removed asynchronously on close, so a process that exited right after the
  // response (a test worker's SIGTERM, server.ts's process.exit) could keep it; and a file part parsed after the
  // cleanup had run recreated it.
  describe('C10: no temp folder outlives the response', () => {
    const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const body = Buffer.concat([
      Buffer.from(
        '--b\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n',
      ),
      PNG,
      Buffer.from('\r\n--b--\r\n'),
    ]);
    const multipartRequest = () =>
      Object.assign(new PassThrough(), {
        method: 'PUT',
        headers: { 'content-type': 'multipart/form-data; boundary=b', 'content-length': String(body.length) },
        log: { warn: vi.fn() },
      });
    const response = (closed = false) => Object.assign(new EventEmitter(), { closed });
    const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    test("the folder is gone by the time the response's close event returns: an exit right after keeps nothing", async () => {
      const before = listTempFiles();
      const req = multipartRequest();
      const res = response();
      const next = vi.fn();

      fileParser(req as unknown as Request, res as unknown as Response, next);
      req.end(body);
      await vi.waitFor(() => expect(next).toHaveBeenCalledWith());
      const { tempFilePath } = (req as unknown as Request).files!.file as { tempFilePath: string };
      const folder = path.dirname(tempFilePath);
      expect(fs.existsSync(folder)).toBe(true);

      res.emit('close');

      // Checked synchronously: nothing is left in flight for an exit to cut short.
      expect(fs.existsSync(folder)).toBe(false);
      expect(newTempFiles(before)).toEqual([]);
    });

    test('a file part parsed after the cleanup ran writes nothing, and the rest of the body is drained', async () => {
      const before = listTempFiles();
      const req = multipartRequest();
      const res = response();
      const next = vi.fn();

      fileParser(req as unknown as Request, res as unknown as Response, next);
      res.emit('close');
      await later(50); // any cleanup has run by now
      req.end(body); // the late write: the file part only reaches the parser now

      await vi.waitFor(() => expect(req.readableEnded).toBe(true));
      await later(50);
      expect(next).not.toHaveBeenCalled();
      expect(newTempFiles(before)).toEqual([]);
    });

    test('a response that closed before the parser started: nothing is parsed or written', async () => {
      const before = listTempFiles();
      const req = multipartRequest();
      const next = vi.fn();

      fileParser(req as unknown as Request, response(true) as unknown as Response, next);
      req.end(body);

      await later(50);
      expect(next).not.toHaveBeenCalled();
      expect(newTempFiles(before)).toEqual([]);
    });

    test('a folder that cannot be removed is logged at warn with the folder', () => {
      vi.spyOn(fs, 'rmSync').mockImplementation(() => {
        throw new Error('simulated cleanup failure');
      });
      const req = multipartRequest();
      const res = response();

      fileParser(req as unknown as Request, res as unknown as Response, vi.fn());
      res.emit('close');

      expect(req.log.warn).toHaveBeenCalledExactlyOnceWith(
        {
          err: expect.objectContaining({ message: 'simulated cleanup failure' }),
          tempFileDir: expect.stringContaining(path.join(os.tmpdir(), `upload-${process.pid}-`)),
        },
        'upload temp folder not removed',
      );
    });
  });
});
