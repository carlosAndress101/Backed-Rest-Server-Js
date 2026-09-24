import path from 'node:path';

import cors from 'cors';
import express, { type Express } from 'express';
import helmet, { type HelmetOptions } from 'helmet';
import { isObjectIdOrHexString } from 'mongoose';

import type { Config } from './config';
import type { Logger } from './core/logger';
import { createTokenService } from './core/security/jwt';
import { mountLegacyRoutes } from './legacy';
import { authenticate, type UserLookup } from './middlewares/authenticate';
import { requireAdmin } from './middlewares/authorize';
import { errorHandler } from './middlewares/error-handler';
import { notFound } from './middlewares/not-found';
import { requestLogger } from './middlewares/request-logger';
import { CategoryModel, categoriesModule } from './modules/categories';
import { ProductModel, productsModule } from './modules/products';
import { searchModule } from './modules/search';
import { UserModel, usersModule } from './modules/users';

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

  const tokens = createTokenService(config.auth.jwtSecret);
  // The users module owns User (ADR-027). A uid that is not an ObjectId is no user, so authenticate answers 401,
  // never the 400 of a CastError.
  const users: UserLookup = {
    findById: (id) => (isObjectIdOrHexString(id) ? UserModel.findById(id) : Promise.resolve(null)),
  };
  const auth = authenticate({ tokens, users });

  app.use('/api/category', categoriesModule({ authenticate: auth, requireAdmin }));
  app.use('/api/product', productsModule({ Category: CategoryModel, authenticate: auth, requireAdmin }));
  app.use(
    '/api/search',
    searchModule({ User: UserModel, Category: CategoryModel, Product: ProductModel, authenticate: auth }),
  );
  app.use('/api/user', usersModule({ authenticate: auth }));
  mountLegacyRoutes(app); // the routes no module owns yet

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
