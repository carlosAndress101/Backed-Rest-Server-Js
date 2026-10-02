import type { RequestHandler } from 'express';

import { envelope } from '../../core/http/envelope';
import type { GoogleDto, LoginDto, PasswordChangeDto } from './auth.schemas';
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

  // §2.1 #24: 204; the caller's own token stops verifying too (AM-M5-4). req.user is set by authenticate.
  const logoutAll: RequestHandler = async (req, res) => {
    await service.logoutAll(req.user!.id);
    res.status(204).end();
  };

  // §2.1 #25: 200 env({ token }), a fresh token that survives the change it made.
  const changePassword: RequestHandler = async (req, res) => {
    const { token } = await service.changePassword(req.user!.id, req.body as PasswordChangeDto);
    res.status(200).json(envelope({ token }));
  };

  return { login, googleSignIn, logoutAll, changePassword };
}
