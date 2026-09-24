import path from 'node:path';

import cors from 'cors';
import express, { type Express } from 'express';
import helmet, { type HelmetOptions } from 'helmet';

import type { Config } from './config';
import type { Logger } from './core/logger';
import { mountLegacyRoutes } from './legacy';
import { errorHandler } from './middlewares/error-handler';
import { notFound } from './middlewares/not-found';
import { requestLogger } from './middlewares/request-logger';

export interface AppDeps {
  config: Config;
  logger: Logger;
}

// Correct from both src/ (tsx, Vitest) and dist/ (node).
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// T1.3's options, as merged: the CSP and COOP keep the demo page's Google sign-in and fonts
// working, CORP lets other origins embed images.
const HELMET_OPTIONS: HelmetOptions = {
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://accounts.google.com/gsi/style',
        'https://fonts.googleapis.com',
      ],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      frameSrc: ['https://accounts.google.com/gsi/'],
      connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
    },
  },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
};

/** The composition root. Performs no I/O: it neither connects to the database nor listens (ARC-02). */
export function createApp({ config, logger }: AppDeps): Express {
  const app = express();
  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(requestLogger(logger));
  app.use(helmet(HELMET_OPTIONS));
  app.use(cors({ origin: config.cors.origins === '*' ? '*' : [...config.cors.origins] }));
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  mountLegacyRoutes(app);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
