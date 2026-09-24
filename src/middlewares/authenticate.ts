import type { RequestHandler } from 'express';

import { UnauthorizedError } from '../core/errors';
import type { TokenService } from '../core/security/jwt';

export interface AuthUser {
  id: string;
  role: string;
  name: string;
  state: boolean;
}
interface LookupUser {
  _id: unknown;
  role: string;
  state: boolean;
  name: string;
}
export interface UserLookup {
  findById(id: string): PromiseLike<LookupUser | null>;
}

/** ADR-028: same 401 semantics as legacy validarJWT (C4). Async → Express 5 forwards the rejection. */
export const authenticate =
  (deps: { tokens: TokenService; users: UserLookup }): RequestHandler =>
  async (req, _res, next) => {
    const header = req.header('x-token');
    if (!header) throw new UnauthorizedError('No token in the request');
    let uid: string;
    try {
      uid = deps.tokens.verify(header).uid;
    } catch (err) {
      req.log.debug({ err }, 'token rejected'); // LOG-01: the line validar-jwt.js writes
      throw new UnauthorizedError('Invalid token');
    }
    const user = await deps.users.findById(uid);
    if (!user || !user.state) throw new UnauthorizedError('Invalid token');
    req.user = { id: String(user._id), role: user.role, name: user.name, state: user.state };
    next();
  };
