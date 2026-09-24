import type { RequestHandler, Router } from 'express';

import { createUsersController } from './user.controller';
import { UserModel } from './user.model';
import { createUsersRouter } from './user.routes';
import { createUsersService } from './user.service';

// The module's public surface: its router factory, and its model for cross-module readers (ADR-027):
// authenticate's lookup in src/app.ts, and the auth module (T3.4).
export { UserModel, type User, type UserDocument } from './user.model';

export interface UsersModuleDeps {
  authenticate: RequestHandler;
}

/** P15: model → service → controller → router. src/app.ts mounts the result at /api/user. */
export function usersModule(deps: UsersModuleDeps): Router {
  const service = createUsersService({ User: UserModel });
  return createUsersRouter({ controller: createUsersController(service), authenticate: deps.authenticate });
}
