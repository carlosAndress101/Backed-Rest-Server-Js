import pino, { type Logger } from 'pino';

import type { Config } from '../config';

export type { Logger };

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-token"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'err.errors.password.value', // Mongoose ValidationError on User
  'err.errors.password.properties.value',
  // LOG-02 (T4.2G F1): a Mongoose ValidationError carries every rejected value, whatever the path; the validator
  // messages are fixed, so these are the only copies.
  'err.errors.*.value',
  'err.errors.*.properties.value',
];

export function createLogger(config: Pick<Config, 'logLevel'>, destination?: pino.DestinationStream): Logger {
  return pino({ level: config.logLevel, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, destination);
}
