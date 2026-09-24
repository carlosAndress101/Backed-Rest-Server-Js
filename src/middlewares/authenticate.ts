import type { Request, RequestHandler, Response } from 'express';

import { UnauthorizedError } from '../core/errors';
import type { TokenClaims, TokenService } from '../core/security/jwt';

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
  /** Compared with the token's `tv` (ADR-033); never copied to req.user. */
  tokenVersion: number;
}
export interface UserLookup {
  findById(id: string): PromiseLike<LookupUser | null>;
}

// RFC 6750: the scheme exactly as ADR-032 fixes it, one space, then a b64token (a JWT's characters are a subset).
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

/**
 * P22 (ADR-032): `Authorization: Bearer` first. x-token is read only when there is no Authorization header at all,
 * and marks the response `Deprecation: true` (RFC 9745). A present but malformed Authorization header yields no
 * token (a 401), never a fallback to x-token.
 */
function tokenOf(req: Request, res: Response): string | undefined {
  const authorization = req.header('authorization');
  if (authorization !== undefined) return BEARER.exec(authorization)?.[1];
  const legacy = req.header('x-token');
  if (!legacy) return undefined;
  res.setHeader('Deprecation', 'true'); // Sunset (RFC 8594) joins it once 4.0.0 has a date
  return legacy;
}

/** ADR-028/032/033: the C4 401 semantics over Bearer (or x-token), plus the tokenVersion check. */
export const authenticate =
  (deps: { tokens: TokenService; users: UserLookup }): RequestHandler =>
  async (req, res, next) => {
    const token = tokenOf(req, res);
    if (!token) throw new UnauthorizedError('No token in the request');
    let claims: TokenClaims;
    try {
      claims = deps.tokens.verify(token);
    } catch (err) {
      req.log.debug({ err }, 'token rejected'); // LOG-01: the line 2.x wrote
      throw new UnauthorizedError('Invalid token');
    }
    const user = await deps.users.findById(claims.uid);
    // P23: a revoked token (an older tokenVersion) is the same 401 as any other invalid token.
    if (!user || !user.state || user.tokenVersion !== claims.tokenVersion)
      throw new UnauthorizedError('Invalid token');
    req.user = { id: String(user._id), role: user.role, name: user.name, state: user.state };
    next();
  };
