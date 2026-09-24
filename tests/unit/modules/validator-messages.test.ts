// LOG-02 (T4.2G F1): a rejected value never reaches a validator message, the ValidationError's message or stack,
// or a log line. Mongoose's default messages embed it, and error-handler logs the raw ValidationError (res.err),
// so every validator on the three schemas has a fixed message and the logger redacts the value fields.
import { Writable } from 'node:stream';

import mongoose from 'mongoose';
import { describe, expect, test } from 'vitest';

import { createLogger } from '../../../src/core/logger';
import { CategoryModel } from '../../../src/modules/categories';
import { ProductModel } from '../../../src/modules/products';
import { UserModel } from '../../../src/modules/users';

const MARK = 'LEAKED7f3c';
const NEGATIVE = -731197; // a number cannot hold MARK, so its digits are the marker
const long = (length: number) => MARK + 'x'.repeat(length - MARK.length);
const owner = new mongoose.Types.ObjectId();

const validUser = { name: 'Ada', email: 'ada@example.com', password: 'stored-hash' };
const validProduct = { name: 'KEYBOARD', user: owner, category: new mongoose.Types.ObjectId() };

// [model, path, validator kind, fixed message, what must not leak, document]
const cases: Array<[string, string, string, string, string, () => mongoose.Document]> = [
  [
    'User',
    'name',
    'maxlength',
    'The name must be at most 120 characters',
    MARK,
    () => new UserModel({ ...validUser, name: long(121) }),
  ],
  [
    'User',
    'email',
    'regexp',
    'The email format is invalid',
    MARK,
    () => new UserModel({ ...validUser, email: `${MARK} not an email` }),
  ],
  [
    'User',
    'email',
    'maxlength',
    'The email must be at most 254 characters',
    MARK,
    () => new UserModel({ ...validUser, email: `${long(250)}@example.com` }),
  ],
  [
    'User',
    'image',
    'maxlength',
    'The image must be at most 2048 characters',
    MARK,
    () => new UserModel({ ...validUser, image: long(2049) }),
  ],
  [
    'User',
    'role',
    'enum',
    'The role is not a valid role',
    MARK,
    () => new UserModel({ ...validUser, role: `${MARK}_ROLE` }),
  ],
  [
    'User',
    'tokenVersion',
    'min',
    'The token version cannot be negative',
    String(NEGATIVE),
    () => new UserModel({ ...validUser, tokenVersion: NEGATIVE }),
  ],
  [
    'Category',
    'name',
    'maxlength',
    'The name must be at most 120 characters',
    MARK,
    () => new CategoryModel({ name: long(121), user: owner }),
  ],
  [
    'Product',
    'name',
    'maxlength',
    'The name must be at most 120 characters',
    MARK,
    () => new ProductModel({ ...validProduct, name: long(121) }),
  ],
  [
    'Product',
    'price',
    'min',
    'The price cannot be negative',
    String(NEGATIVE),
    () => new ProductModel({ ...validProduct, price: NEGATIVE }),
  ],
  [
    'Product',
    'description',
    'maxlength',
    'The description must be at most 2000 characters',
    MARK,
    () => new ProductModel({ ...validProduct, description: long(2001) }),
  ],
  [
    'Product',
    'image',
    'maxlength',
    'The image must be at most 2048 characters',
    MARK,
    () => new ProductModel({ ...validProduct, image: long(2049) }),
  ],
];

/** Logs `err` the way the request logger logs res.err, and returns the line. */
const logLine = (err: unknown) => {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  createLogger({ logLevel: 'info' }, destination).error({ err }, 'request failed');
  return lines.join('');
};

describe('validator messages carry no rejected value', () => {
  test.each(cases)('%s › %s (%s)', async (_model, path, kind, message, secret, build) => {
    const error = await build()
      .validate()
      .then(
        () => undefined,
        (rejection: unknown) => rejection as mongoose.Error.ValidationError,
      );

    expect(error).toBeInstanceOf(mongoose.Error.ValidationError);
    const failure = error!.errors[path] as mongoose.Error.ValidatorError;
    expect(failure.kind).toBe(kind);
    expect(failure.message).toBe(message);
    for (const text of [error!.message, error!.stack, failure.message, failure.properties.message]) {
      expect(text).not.toContain(secret);
    }
    expect(logLine(error)).not.toContain(secret);
  });
});
