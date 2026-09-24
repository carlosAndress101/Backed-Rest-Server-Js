import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RequestHandler } from 'express';
import fileUpload from 'express-fileupload';

import { AppError, BadRequestError } from '../../core/errors';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

// F4: the 5 MB limit answers 413 with the JSON envelope (abortOnLimit then only drains and closes the request).
const tooLarge: RequestHandler = (_req, _res, next) => {
  next(new AppError(413, 'BAD_REQUEST', 'The file is larger than 5 MB'));
};

// One file, max 5 MB, written to a temp file (never kept in memory).
const uploadOptions = {
  useTempFiles: true,
  createParentPath: true,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  abortOnLimit: true,
  limitHandler: tooLarge,
};

/** HTTP-02: a malformed multipart body is the client's error (400); failing to write the temp file stays a 500. */
const asParserError = (err: unknown): unknown =>
  err instanceof AppError || (err instanceof Error && 'syscall' in err)
    ? err
    : new BadRequestError('Malformed multipart body', err);

/**
 * C10: parses the multipart body of the upload route only. Mount it after authentication, authorization and
 * param validation, so a rejected request never writes a temp file.
 *
 * The request's temp files go into their own folder under os.tmpdir() (created with the first file), removed
 * as a whole once the response is over, whatever the exit path. A folder also catches the file
 * express-fileupload fails to delete itself when an upload breaks off mid-file, which never reaches req.files.
 */
export const fileParser: RequestHandler = (req, res, next) => {
  const tempFileDir = path.join(os.tmpdir(), `upload-${process.pid}-${randomUUID()}`);

  res.on('close', () => {
    fs.rm(tempFileDir, { recursive: true, force: true, maxRetries: 3 }, (err) => {
      if (err) req.log.warn({ err, tempFileDir }, 'upload temp folder not removed');
    });
  });

  // express-fileupload can call back twice (a body cut off mid-file fails both the file and the form),
  // so only the first outcome counts.
  let settled = false;
  const done = (err?: unknown) => {
    if (settled) return;
    settled = true;
    if (err === undefined) next();
    else next(asParserError(err));
  };

  try {
    fileUpload({ ...uploadOptions, tempFileDir })(req, res, done);
  } catch (err) {
    done(err); // busboy throws synchronously on a multipart content type without a boundary
  }
};

const SIGNATURES = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG
  Buffer.from([0x47, 0x49, 0x46, 0x38]), // GIF ("GIF8")
];
const HEAD_BYTES = Math.max(...SIGNATURES.map((magic) => magic.length));

/** SEC-08: the file's own first bytes decide its type, never its name or the client's Content-Type. */
export const isSupportedImage = (head: Buffer): boolean =>
  SIGNATURES.some((magic) => head.subarray(0, magic.length).equals(magic));

const readHead = async (file: string): Promise<Buffer> => {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/** After fileParser: exactly one file, in the "file" field, that is a PNG, JPEG or GIF by its magic bytes. */
export const requireImage: RequestHandler = async (req, _res, next) => {
  const file = req.files?.file;
  if (!file || Array.isArray(file)) throw new BadRequestError('No file was uploaded in the "file" field');
  if (!isSupportedImage(await readHead(file.tempFilePath)))
    throw new BadRequestError('The file must be a PNG, JPEG or GIF image');
  next();
};
