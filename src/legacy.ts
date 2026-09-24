// The only TS→JS seam (ADR-017). An entry is removed when its M3 module lands; the file is deleted with the last one.
import type { Express, RequestHandler, Router } from 'express';

// Legacy JS is loaded with Node's own require: one module instance shared by app, tests and every transform.
const LEGACY_ROUTES: ReadonlyArray<readonly [string, string]> = [['/api/auth', '../routes/auth']];

// Express 5 leaves req.body undefined when no parser ran; legacy handlers were written against Express 4's `{}`.
// It also keeps multipart fields on a plain object: express-fileupload adds them to an existing body, and only
// creates a null-prototype one when there is none.
const legacyBodyCompat: RequestHandler = (req, _res, next) => {
  req.body ??= {};
  next();
};

export function mountLegacyRoutes(app: Express): void {
  for (const [path, file] of LEGACY_ROUTES) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const router = require(file) as Router;
    app.use(path, legacyBodyCompat, router);
  }
}
