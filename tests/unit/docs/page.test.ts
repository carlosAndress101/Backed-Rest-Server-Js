// The /docs page (Decision 4): one pinned, integrity-checked script and nothing inline.
import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { DOCS_CSP_DIRECTIVES, DOCS_PAGE_HTML, UI_BUNDLE, UI_BUNDLE_URL } from '../../../src/docs/page';

describe('UI_BUNDLE', () => {
  test('pins an exact version and a sha384 integrity hash', () => {
    expect(UI_BUNDLE.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(UI_BUNDLE.integrity).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  });

  test('the URL is the pinned standalone bundle on jsDelivr', () => {
    expect(UI_BUNDLE_URL).toBe(
      `https://cdn.jsdelivr.net/npm/redoc@${UI_BUNDLE.version}/bundles/redoc.standalone.js`,
    );
  });

  // A remote read: run only with VERIFY_SRI=1, and only with the owner's authorization (M8 tasks 5.9).
  test.skipIf(process.env.VERIFY_SRI !== '1')(
    'the integrity hash matches the bytes the CDN serves',
    async () => {
      const res = await fetch(UI_BUNDLE_URL);
      const digest = createHash('sha384')
        .update(Buffer.from(await res.arrayBuffer()))
        .digest('base64');

      expect(res.status).toBe(200);
      expect(`sha384-${digest}`).toBe(UI_BUNDLE.integrity);
    },
  );
});

describe('DOCS_PAGE_HTML', () => {
  test('has exactly one script tag: the pinned bundle, with its integrity and crossorigin', () => {
    const tags = [...DOCS_PAGE_HTML.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag);

    expect(tags).toEqual([
      `<script src="${UI_BUNDLE_URL}" integrity="${UI_BUNDLE.integrity}" crossorigin="anonymous">`,
    ]);
  });

  test('has no inline script body and no inline style', () => {
    const bodies = [...DOCS_PAGE_HTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(
      ([, body]) => body,
    );

    expect(bodies).toEqual(['']);
    expect(DOCS_PAGE_HTML).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=/i);
  });

  test('links the JSON first, then renders it with Redoc', () => {
    const link = DOCS_PAGE_HTML.indexOf('<a href="/docs/openapi.json">');
    const redoc = DOCS_PAGE_HTML.indexOf('<redoc spec-url="/docs/openapi.json"></redoc>');
    const script = DOCS_PAGE_HTML.indexOf('<script');

    expect(link).toBeGreaterThan(-1);
    expect(redoc).toBeGreaterThan(link);
    expect(script).toBeGreaterThan(redoc);
  });
});

describe('DOCS_CSP_DIRECTIVES', () => {
  test('allows exactly the bundle URL as a script, blob: workers, the redoc.ly logo host for images, and drops upgrade-insecure-requests', () => {
    expect(DOCS_CSP_DIRECTIVES).toEqual({
      'script-src': [UI_BUNDLE_URL],
      'worker-src': ['blob:'],
      'img-src': ["'self'", 'data:', 'https://cdn.redoc.ly'],
      'upgrade-insecure-requests': null,
    });
  });
});
