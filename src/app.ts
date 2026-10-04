import cors from 'cors';
import express, { type Express } from 'express';
import helmet, { type HelmetOptions } from 'helmet';
import mongoose, { isObjectIdOrHexString } from 'mongoose';

import type { Config } from './config';
import type { Logger } from './core/logger';
import { createTokenService } from './core/security/jwt';
import { docsModule } from './docs';
import { authenticate, type UserLookup } from './middlewares/authenticate';
import { errorHandler } from './middlewares/error-handler';
import { notFound } from './middlewares/not-found';
import { requestLogger } from './middlewares/request-logger';
import { healthRouter, readyRouter } from './platform/health';
import { authModule } from './modules/auth';
import { CategoryModel, categoriesModule } from './modules/categories';
import { mediaModule } from './modules/media';
import { ProductModel, productsModule } from './modules/products';
import { searchModule } from './modules/search';
import { UserModel, usersModule } from './modules/users';

export interface AppDeps {
  config: Config;
  logger: Logger;
}

// Helmet's defaults (CSP, COOP same-origin, …) plus two API choices: CORP cross-origin, so other origins can embed the
// image GET /api/uploads/:collection/:id redirects to (#22), and the referrer policy.
const HELMET_OPTIONS: HelmetOptions = {
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

  const tokens = createTokenService(config.auth.jwtSecret, { ttlSeconds: config.auth.jwtTtlSeconds });
  // The users module owns User (ADR-027). A uid that is not an ObjectId is no user, so authenticate answers 401,
  // never the 400 of a CastError.
  const users: UserLookup = {
    findById: (id) => (isObjectIdOrHexString(id) ? UserModel.findById(id) : Promise.resolve(null)),
  };
  const auth = authenticate({ tokens, users });

  app.use('/api/category', categoriesModule({ authenticate: auth }));
  app.use('/api/product', productsModule({ Category: CategoryModel, authenticate: auth }));
  app.use(
    '/api/search',
    searchModule({ User: UserModel, Category: CategoryModel, Product: ProductModel, authenticate: auth }),
  );
  app.use('/api/user', usersModule({ authenticate: auth, bcryptCost: config.auth.bcryptCost }));
  app.use(
    '/api/auth',
    authModule({
      User: UserModel,
      tokens,
      googleClientId: config.auth.googleClientId,
      bcryptCost: config.auth.bcryptCost,
      authenticate: auth,
    }),
  );
  app.use(
    '/api/uploads',
    mediaModule({
      User: UserModel,
      Product: ProductModel,
      authenticate: auth,
      cloudinaryUrl: config.media.cloudinaryUrl,
    }),
  );

  // M9 platform routes (ADR-052): liveness needs no dependency; readiness pings the database
  // with a real round-trip. Mounted before notFound so they are never the 404 envelope.
  app.use('/health', healthRouter());
  app.use(
    '/ready',
    readyRouter({
      // A real round-trip, not the possibly stale readyState flag alone (M9 D2).
      checkDb: async () => {
        const db = mongoose.connection.db;
        if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected || db === undefined)
          throw new Error('Database not ready');
        await db.admin().ping();
      },
    }),
  );

  // D5 (ADR-047): when disabled, /docs is absent (the standard 404), never a distinct refusal.
  if (config.docs.enabled) app.use('/docs', docsModule());

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
