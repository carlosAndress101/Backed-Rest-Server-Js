import type { Router } from 'express';

import type { TokenService } from '../../core/security/jwt';
import { createAuthController } from './auth.controller';
import { createAuthRouter } from './auth.routes';
import { createAuthService, type SignInUserModel } from './auth.service';
import { GoogleClient } from './google.client';

export type { SignInUser, SignInUserModel } from './auth.service';

export interface AuthModuleDeps {
  /** The users module's UserModel: src/app.ts passes it in (§2.3 rule 4). */
  User: SignInUserModel;
  /** The x-token service src/app.ts builds for authenticate, so a signed token is one authenticate accepts. */
  tokens: TokenService;
  /** config.auth.googleClientId: the audience a Google ID token must carry. */
  googleClientId: string;
}

/** P15: client → service → controller → router. src/app.ts mounts the result at /api/auth. No model of its own. */
export function authModule(deps: AuthModuleDeps): Router {
  const service = createAuthService({
    User: deps.User,
    tokens: deps.tokens,
    google: new GoogleClient(deps.googleClientId),
  });
  return createAuthRouter({ controller: createAuthController(service) });
}
