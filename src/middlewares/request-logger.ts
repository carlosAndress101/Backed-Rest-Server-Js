import { randomUUID } from 'node:crypto';

import { pinoHttp } from 'pino-http';

import type { Logger } from '../core/logger';

export const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/; // an inbound id is trusted for correlation only; the charset blocks log injection

/** First middleware: assigns the request id, exposes `req.log`, logs one line per completed request. */
export const requestLogger = (logger: Logger) =>
  pinoHttp({
    logger,
    quietReqLogger: true, // req.log carries only { reqId }, not the whole request, on every log call
    genReqId: (req, res) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customLogLevel: (_req, res) =>
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  });
