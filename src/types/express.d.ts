import type { AuthUser } from '../middlewares/authenticate';

declare global {
  namespace Express {
    interface Request {
      /** Set by authenticate (ADR-028) on every route behind it. */
      user?: AuthUser;
    }
  }
}
