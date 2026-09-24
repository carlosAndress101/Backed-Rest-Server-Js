import type { RequestHandler } from 'express';

import { envelope } from '../../core/http/envelope';
import type { GoogleDto, LoginDto } from './auth.schemas';
import type { AuthService } from './auth.service';

export type AuthController = ReturnType<typeof createAuthController>;

/** Thin handlers: read the body validate already parsed, make one service call, send the envelope. */
export function createAuthController(service: AuthService) {
  // The token stays in the body and travels as x-token (M5 moves it to Bearer).
  const login: RequestHandler = async (req, res) => {
    const { token, user } = await service.login(req.body as LoginDto, req.log);
    res.status(200).json(envelope({ token, user }));
  };

  const googleSignIn: RequestHandler = async (req, res) => {
    const { token, user } = await service.googleSignIn(req.body as GoogleDto);
    res.status(200).json(envelope({ token, user }));
  };

  return { login, googleSignIn };
}
