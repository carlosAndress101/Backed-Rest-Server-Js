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
];

export function createLogger(config: Pick<Config, 'logLevel'>, destination?: pino.DestinationStream): Logger {
  return pino({ level: config.logLevel, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, destination);
}
