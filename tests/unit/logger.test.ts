import mongoose from 'mongoose';
import { describe, expect, test } from 'vitest';

import type { LogLevel } from '../../src/config';
import { REDACT_PATHS, createLogger } from '../../src/core/logger';

const SECRET = 'top-secret-value';

type LogRecord = Record<string, unknown>;

/** Reads a nested field of a parsed log line. */
const at = (record: LogRecord | undefined, ...keys: string[]): unknown =>
  keys.reduce<unknown>((value, key) => (value as LogRecord | undefined)?.[key], record);

/** A logger writing to memory; `records()` parses every line written so far. */
const capture = (logLevel: LogLevel) => {
  const lines: string[] = [];
  const logger = createLogger({ logLevel }, { write: (line: string) => void lines.push(line) });
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line) as LogRecord) };
};

type Fixture = {
  /** The object logged, holding SECRET at the redacted path and a non-sensitive sibling. */
  readonly fields: object;
  readonly redacted: readonly string[];
  readonly sibling: readonly string[];
  readonly siblingValue: unknown;
};

// One fixture per REDACT_PATHS entry.
const FIXTURES: Record<string, Fixture> = {
  'req.headers.authorization': {
    fields: { req: { headers: { authorization: `Bearer ${SECRET}`, 'user-agent': 'vitest' } } },
    redacted: ['req', 'headers', 'authorization'],
    sibling: ['req', 'headers', 'user-agent'],
    siblingValue: 'vitest',
  },
  'req.headers["x-token"]': {
    fields: { req: { headers: { 'x-token': SECRET, accept: 'application/json' } } },
    redacted: ['req', 'headers', 'x-token'],
    sibling: ['req', 'headers', 'accept'],
    siblingValue: 'application/json',
  },
  'req.headers.cookie': {
    fields: { req: { headers: { cookie: `session=${SECRET}`, host: 'api.example' } } },
    redacted: ['req', 'headers', 'cookie'],
    sibling: ['req', 'headers', 'host'],
    siblingValue: 'api.example',
  },
  'res.headers["set-cookie"]': {
    fields: { res: { headers: { 'set-cookie': [`session=${SECRET}`], 'content-type': 'text/html' } } },
    redacted: ['res', 'headers', 'set-cookie'],
    sibling: ['res', 'headers', 'content-type'],
    siblingValue: 'text/html',
  },
  password: {
    fields: { password: SECRET, email: 'user@example.com' },
    redacted: ['password'],
    sibling: ['email'],
    siblingValue: 'user@example.com',
  },
  '*.password': {
    fields: { user: { password: SECRET, name: 'Alice' } },
    redacted: ['user', 'password'],
    sibling: ['user', 'name'],
    siblingValue: 'Alice',
  },
  'err.errors.password.value': {
    fields: { err: { errors: { password: { value: SECRET, kind: 'minlength' } } } },
    redacted: ['err', 'errors', 'password', 'value'],
    sibling: ['err', 'errors', 'password', 'kind'],
    siblingValue: 'minlength',
  },
  'err.errors.password.properties.value': {
    fields: { err: { errors: { password: { properties: { value: SECRET, path: 'password' } } } } },
    redacted: ['err', 'errors', 'password', 'properties', 'value'],
    sibling: ['err', 'errors', 'password', 'properties', 'path'],
    siblingValue: 'password',
  },
};

describe('createLogger redaction', () => {
  test('every REDACT_PATHS entry has a fixture below', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...REDACT_PATHS].sort());
  });

  test.each(Object.entries(FIXTURES))('%s is [REDACTED], its sibling is untouched', (_path, fixture) => {
    const { logger, lines, records } = capture('info');

    logger.info(fixture.fields, 'request');

    const [record] = records();
    expect(at(record, ...fixture.redacted)).toBe('[REDACTED]');
    expect(at(record, ...fixture.sibling)).toEqual(fixture.siblingValue);
    expect(lines.join('')).not.toContain(SECRET);
  });

  test('a real Mongoose ValidationError on a password never prints the password', () => {
    const rejectedPassword = 'Pw-7r!x'; // 7 characters: fails the minlength of 8
    const User = mongoose.model(
      'LoggerTestUser',
      new mongoose.Schema({
        name: String,
        password: { type: String, minlength: [8, 'The password is too short'] },
      }),
    );
    const err = new User({ name: 'Alice', password: rejectedPassword }).validateSync();
    const { logger, lines, records } = capture('info');

    logger.error({ err }, 'validation failed');

    const [record] = records();
    expect(at(record, 'err', 'errors', 'password', 'value')).toBe('[REDACTED]');
    expect(at(record, 'err', 'errors', 'password', 'properties', 'value')).toBe('[REDACTED]');
    expect(at(record, 'err', 'message')).toContain('The password is too short');
    expect(lines.join('')).not.toContain(rejectedPassword);
  });

  test('fields outside the redaction list are logged as they are', () => {
    const { logger, records } = capture('info');

    logger.info({ reqId: 'abc-123', url: '/api/user', statusCode: 200 }, 'request completed');

    expect(records()[0]).toMatchObject({
      level: 30,
      msg: 'request completed',
      reqId: 'abc-123',
      url: '/api/user',
      statusCode: 200,
    });
  });
});

describe('createLogger level', () => {
  test('messages below the configured level are dropped', () => {
    const { logger, records } = capture('warn');

    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    expect(logger.level).toBe('warn');
    expect(records().map(({ level, msg }) => [level, msg])).toEqual([
      [40, 'warn'],
      [50, 'error'],
    ]);
  });

  test('trace writes everything', () => {
    const { logger, records } = capture('trace');

    logger.trace('trace');

    expect(records()).toMatchObject([{ level: 10, msg: 'trace' }]);
  });

  test('silent writes nothing, not even fatal', () => {
    const { logger, lines } = capture('silent');

    logger.fatal('fatal');
    logger.error({ password: SECRET }, 'error');

    expect(lines).toEqual([]);
  });
});
