import { Router } from 'express';
import { contentSecurityPolicy } from 'helmet';

import { buildOpenApiDocument, type OpenApiDocument } from './openapi';
import { API_OPERATIONS } from './operations';
import { DOCS_CSP_DIRECTIVES, DOCS_PAGE_HTML } from './page';

export interface DocsModuleDeps {
  /** Injected only by tests (ADR-023): proves the document is built once per app, never per request. */
  readonly buildDocument?: () => OpenApiDocument;
}

/**
 * GET /docs (the Redoc page, with its own CSP) and GET /docs/openapi.json. The document is built and serialized
 * once, here, when createApp runs: an unrepresentable schema fails the boot, and a request only sends a string.
 * `Cache-Control: no-cache` plus Express's ETag make every load a cheap revalidation.
 */
export function docsModule({
  buildDocument = () => buildOpenApiDocument(API_OPERATIONS),
}: DocsModuleDeps = {}): Router {
  const json = JSON.stringify(buildDocument());
  const router = Router();

  router.get('/', contentSecurityPolicy({ directives: DOCS_CSP_DIRECTIVES }), (_req, res) => {
    res.set('Cache-Control', 'no-cache').type('html').send(DOCS_PAGE_HTML);
  });
  router.get('/openapi.json', (_req, res) => {
    res.set('Cache-Control', 'no-cache').type('json').send(json);
  });

  return router;
}
