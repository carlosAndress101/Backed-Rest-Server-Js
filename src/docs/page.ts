// The /docs page (Decision 4): one pinned Redoc bundle with SRI, no inline script or style, and a plain link to the
// JSON first, so the document stays reachable when the CDN is blocked or the integrity check fails.

/**
 * Redoc's standalone bundle, pinned (ADR-025 by analogy): the latest 2.x at least 24 h old when M8 S5 applied it
 * (2.5.4, published 2026-09-10). `integrity` is the sha384 of those exact bytes; a version bump needs a new hash.
 */
export const UI_BUNDLE = {
  version: '2.5.4',
  integrity: 'sha384-w447zOpYfw/1Tv/5AK9NfHTlQIqE3RVR6KY62jCyy9zNDgO64cMwGGP1Fj0zJVf5',
} as const;

export const UI_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/redoc@${UI_BUNDLE.version}/bundles/redoc.standalone.js`;

/**
 * Merged over helmet's default directives on GET /docs only; the global HELMET_OPTIONS are never widened (D3).
 * script-src is the exact bundle URL, not the CDN host. Redoc's search runs in a blob: worker. No
 * upgrade-insecure-requests: the page loads only its own origin and an https: URL, and that directive would break
 * the page on a plain-HTTP development host.
 * img-src adds exactly cdn.redoc.ly: the bundle fetches its default mini logo from there (observed in the 5.12
 * browser check, per the adjust-only-on-observed-violations rule). The bundle's jsDelivr source map stays blocked
 * on purpose: only open devtools request it, it has no runtime role, and allowing it would widen connect-src to a
 * whole CDN host — expected console noise, not a defect.
 */
export const DOCS_CSP_DIRECTIVES = {
  'script-src': [UI_BUNDLE_URL],
  'worker-src': ['blob:'],
  'img-src': ["'self'", 'data:', 'https://cdn.redoc.ly'],
  'upgrade-insecure-requests': null,
};

export const DOCS_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>API reference</title>
  </head>
  <body>
    <p><a href="/docs/openapi.json">The OpenAPI document (JSON)</a></p>
    <redoc spec-url="/docs/openapi.json"></redoc>
    <script src="${UI_BUNDLE_URL}" integrity="${UI_BUNDLE.integrity}" crossorigin="anonymous"></script>
  </body>
</html>
`;
