# Design: M8 API Documentation

## Technical Approach

M8 documents the frozen 3.0 contract from code. The design adds one new composition-level feature folder,
`src/docs/`, that converts the modules' own zod DTOs with zod 4.6.5's native `z.toJSONSchema` (`io: 'input'`) and
assembles an OpenAPI 3.1.1 document by hand. `createApp` mounts it at `/docs` only when the new `DOCS_ENABLED`
setting resolves on. Drift guards tie every documented fact back to an existing source of truth: the ADR-044
permission matrix, the modules' `*.schemas.ts` exports, `ErrorCode`, `envSchema`, and `package.json`. There are
no new dependencies (ADR-025) and no `vi.mock` (ADR-023). Runtime behavior changes in exactly three places: the
`/docs` mount, the flag, and the D1 removal of `public/`.

### Decisions at a glance

| # | Topic | Decision |
|---|---|---|
| 1 | Module layout | New `src/docs/` folder at composition level. `src/core/` cannot host it: lint rule §2.3/5 bans `core → modules`. Route metadata is a **static catalog** (`API_OPERATIONS`), not Express introspection. |
| 2 | ADR-044 drift check | `/docs` is an `express.Router()` with **two new matrix rows** (#26, #27) and a `/docs` mount prefix. This matches the `openapi-docs` spec. |
| 3 | `DOCS_ENABLED` | `z.enum(['true','false'], …).transform(v => v === 'true').optional()`. `loadConfig` resolves `config.docs.enabled = env.DOCS_ENABLED ?? NODE_ENV !== 'production'`. |
| 4 | `/docs` serving | `GET /docs` serves a static HTML page that loads a pinned **Redoc standalone** bundle from jsDelivr with SRI. `GET /docs/openapi.json` serves cached JSON. Both use `Cache-Control: no-cache` and the Express ETag. A `helmet.contentSecurityPolicy` instance applies to `GET /docs` only. |
| 5 | Generation | Every schema is converted with `io: 'input'`. Response components are docs-only zod schemas, converted through a zod registry so they get `$ref`s. The catalog lists errors explicitly, and `INTERNAL` is added to every operation. The security scheme is `bearerAuth` (http bearer, JWT). |
| 6 | `public/` removal | Delete 8 files, `express.static` and `PUBLIC_DIR`. `HELMET_OPTIONS` keeps only CORP `cross-origin` and the referrer policy. **CORP stays**: route #22's 302 image redirect needs it. Three tests change. |
| 7 | Docs artifacts | Root `README.md`, `ERROR_CODES.md` and `api.http`. `.example.env` is renamed to `.env.example`. Doc-drift tests cover env keys, scripts, error codes and `.http` operations. |
| 8 | Delivery | 7 slices of at most about 400 authored lines each, on a feature-branch chain from `next`. Slice order: D1 → flag+components → builder → catalog → mount → docs → `.http`+ledgers. |

## Architecture Decisions

### Decision 1: `src/docs/` feature folder with a static operation catalog

**Choice.** Add a new top-level feature folder, `src/docs/`, that sits at the composition level next to `src/app.ts`:

```
src/docs/
├── index.ts          # public surface: docsModule(deps?) → Router (the only import app.ts makes)
├── openapi.ts        # ApiOperation type, toJsonSchema(), buildOpenApiDocument(): pure, no I/O
├── components.ts     # docs-only zod response components, componentSchemas(), BEARER_SCHEME
├── error-catalog.ts  # ERROR_CATALOG satisfies Record<ErrorCode, …>, ERROR_CODES
├── operations.ts     # API_OPERATIONS: the 21 operations, referencing each module's exported schemas
└── page.ts           # UI_BUNDLE (pinned version + SRI), DOCS_PAGE_HTML, DOCS_CSP_DIRECTIVES
```

`operations.ts` deep-imports each module's `*.schemas.ts` file, plus two exported constants: `SEARCH_COLLECTIONS`
(`src/modules/search/search.service.ts:20`) and `MAX_FILE_BYTES` (`src/modules/media/media.upload.ts:11`). **No
file under `src/modules/` changes.** This keeps D4's "no module change" literally true for every module, not only
search.

A new lint layer in `eslint.config.mjs` covers the folder:

```js
layer(
  ['src/docs/**/*.ts'],
  COMPOSITION,
  rule(
    'docs reads module contracts only: never routes, controllers, models, middlewares or the database (§2.3 rule 6).',
    '\\.(routes|controller|model)$|^mongoose$|(^|/)(middlewares|database)(/|$)',
  ),
),
```

ARCHITECTURE §2.3 gains a rule 6, which states that `src/docs/` reads module contracts (`*.schemas.ts` and exported
constants) and nothing else.

**Alternatives considered:**
- **`src/core/openapi/`, as the proposal suggested.** Rejected. `eslint.config.mjs:11-14` (`FEATURE_MODULES`, applied
  to `src/core/**` at `:59-65`) and ARCHITECTURE §2.3 rule 5 forbid `core` from importing `modules/`, and the catalog
  must import every module's schemas. Splitting a module-agnostic builder into `core` and the catalog into `src/docs/`
  would be a second abstraction with one consumer (§2.1 YAGNI).
- **`src/modules/docs/`.** Rejected. Rule 4 (`SIBLING_MODULE`, `eslint.config.mjs:7-10`) forbids a module from
  importing another module's schemas.
- **Per-module `*.openapi.ts` files that each `index.ts` re-exports.** Rejected. This touches all six modules, which
  breaks D4 ("no module change"), and still needs a central place for the search exception.
- **Introspecting Express for route metadata.** Rejected. Express 5 layers expose no mount prefix
  (`authorize-matrix.test.ts:38-41`, AM-M6-6). `validate(part, schema)` closes over its schema
  (`src/middlewares/validate.ts:9-11`), so reading schemas would require changing `validate`, which is out of scope.
  `authenticate` presence would also have to be detected by function identity.

**Rationale.** A static catalog is explicit and reviewable, and API_PROGRESS can be read side by side with it. The
drift tests (Decision 5) make it fail closed. The chain is transitive: the live routers equal MATRIX (ADR-044, already
tested), and MATRIX's `/api` rows equal `API_OPERATIONS` (new test), so the documented operations equal the live
operations. Request schemas are imported by identity and never retyped.

### Decision 2: ADR-044, `/docs` as a Router with matrix rows #26 and #27

**Choice.** Mount `/docs` as an `express.Router()` and keep ADR-044's "every registered route has a row" literally
true:
- `tests/helpers/permission-matrix.ts`:
  - add `'/docs'` to `MOUNT_PREFIXES`;
  - add rows `#26 GET /docs` and `#27 GET /docs/openapi.json`, each with `cases: [{ caller: 'anonymous', status: 200 }]`
    and representative of every caller, like #22. The ids continue API_PROGRESS numbering.
- `tests/integration/security/authorize-matrix.test.ts`:
  - add `fire()` cases `#26` and `#27`;
  - extend the TEST-05 fixed permutations from 6 to 7 indices (`:212-219`, `:228`);
  - pass `DOCS_ENABLED: 'true'` explicitly to `buildIntrospectableApp()` and to the cell suite's `startTestApp()`, so
    an ambient shell value cannot change the router count.
- API_PROGRESS gets rows 26 and 27, so "API_PROGRESS carries the same matrix" stays true.
- The OpenAPI drift guard compares the catalog only with the MATRIX rows whose path starts with `/api/`. The document
  does not describe its own `/docs` endpoints.

**Alternatives considered:**
- **Mount outside a Router (`app.get('/docs', …)`).** In Express 5 that creates a route layer named `handle`
  (`router@2.2.0/index.js:425-441`), which the drift check's `layer.name === 'router'` filter
  (`authorize-matrix.test.ts:55-58`) silently skips. Rejected. It relies on a blind spot of the check, needs a second
  inventory to stay fail-closed, and contradicts the "single source" rule (AM-M6-6) and the spec requirement
  "ADR-044 permission-matrix accommodation".
- **Flag-off in the matrix tests (`DOCS_ENABLED: 'false'` in `buildIntrospectableApp`).** Rejected. It hides
  registered routes from the check on purpose, so the checked app is no longer the app the suite runs.

**Rationale.** This is the honest reading of ADR-044, and the spec (`openapi-docs`, last requirement) already
requires it. The pairing algorithm needs no change: `/docs` is the only prefix whose fixture pairs cover
`{GET '', GET '/openapi.json'}`. The cost is mechanical: about 25 lines of fixture plus the seven permutation arrays.
The fail-closed property is confirmed by a scratch run during apply (remove the two rows → `match no known prefix`),
as M7 did for TEST-05.

### Decision 3: `DOCS_ENABLED`, a strict literal union with resolution in `loadConfig`

**Choice.**

```ts
// src/config/env.ts — D5 (ADR-047). Strict: never z.coerce.boolean(), which reads the string 'false' as true.
DOCS_ENABLED: z
  .enum(['true', 'false'], "must be 'true' or 'false'")
  .transform((value) => value === 'true')
  .optional(),
```

```ts
// src/config/index.ts
/** D5 (ADR-047): /docs and /docs/openapi.json are mounted only when true. */
readonly docs: { readonly enabled: boolean };
// loadConfig()
docs: { enabled: env.DOCS_ENABLED ?? env.NODE_ENV !== 'production' },
```

```ts
// src/server.ts, next to the ADR-022 CORS warning
if (config.env === 'production' && config.docs.enabled) {
  logger.warn('DOCS_ENABLED=true: /docs serves the API description in production');
}
```

| `DOCS_ENABLED` | development | test | production |
|---|---|---|---|
| unset, or `''` (`loadConfig` drops empty values, `index.ts:39`) | on | on | **off** |
| `true` | on | on | on, plus a `warn` at boot |
| `false` | off | off | off |
| anything else (`1`, `yes`, `TRUE`, ` true`) | `ConfigError … → at DOCS_ENABLED` | same | same |

**Alternatives considered:**
- **`z.coerce.boolean()`.** Rejected: `'false'` would parse as `true`.
- **`z.stringbool()`.** Rejected: it accepts `1/yes/on`, and D5 fixes the domain to exactly `'true' | 'false'`.
- **Resolving the default in `createApp`.** Rejected. Config owns defaults (the `LOG_LEVEL` precedent, `index.ts:53`),
  and `createApp` stays a plain reader.

**Rationale.** The schema shape follows the `TRUST_PROXY` precedent: strict parse, then transform, then `.optional()`.
The default lives where every other default lives. `'false'` and `''` behave as the D5 table says.

### Decision 4: `/docs` serving, CSP and caching

**Choice.** The router is built inside `docsModule()`:

```ts
// src/docs/index.ts
export interface DocsModuleDeps {
  /** Injected only by tests (ADR-023): proves the document is built once per app, never per request. */
  readonly buildDocument?: () => OpenApiDocument;
}
export function docsModule({ buildDocument = () => buildOpenApiDocument(API_OPERATIONS) }: DocsModuleDeps = {}): Router {
  const json = JSON.stringify(buildDocument()); // once, when createApp runs
  const router = Router();
  router.get('/', contentSecurityPolicy({ directives: DOCS_CSP_DIRECTIVES }), (_req, res) => {
    res.set('Cache-Control', 'no-cache').type('html').send(DOCS_PAGE_HTML);
  });
  router.get('/openapi.json', (_req, res) => {
    res.set('Cache-Control', 'no-cache').type('json').send(json);
  });
  return router;
}
// src/app.ts, after the /api mounts and before notFound:
// D5 (ADR-047): when disabled, /docs is absent (the standard 404), never a distinct refusal.
if (config.docs.enabled) app.use('/docs', docsModule());
```

**How each part works:**
- **Routes.** `GET /docs` (also `/docs/`, because routing is not strict) and `GET /docs/openapi.json`. HEAD comes for
  free. Any other `/docs/*` path falls through to `notFound`.
- **Caching.**
  - `Cache-Control: no-cache` tells clients to revalidate on every load.
  - `res.send` adds Express's weak ETag automatically, so a matching `If-None-Match` gets a 304.
  - The document only changes on deploy, so revalidation is cheap and never stale.
- **UI.** `page.ts` holds `UI_BUNDLE = { version, integrity }` and derives the URL from them:
  `https://cdn.jsdelivr.net/npm/redoc@${version}/bundles/redoc.standalone.js`.
  - `version` is an exact `x.y.z`: the latest Redoc 2.x published at least 24 h before the task (ADR-025 applied by
    analogy). No ranges, no `@latest`.
  - `integrity` is `sha384-…`, computed from those exact bytes.
  - The HTML has **no inline script and no inline style**. It contains a visible fallback link to
    `/docs/openapi.json`, a `<redoc spec-url="/docs/openapi.json">` element, and
    `<script src=… integrity=… crossorigin="anonymous">`.
- **Docs CSP.** `helmet.contentSecurityPolicy` (exported by helmet 8.3.0, `index.cjs:135-154,563-587`) is applied to
  `GET /docs` only. It overwrites the global header through `res.setHeader`, and the global `HELMET_OPTIONS` are never
  widened. It merges over helmet's defaults (`useDefaults: true`):
  - `'script-src'`: `[UI_BUNDLE.url]`. An exact path source, so not even the whole CDN host is allowed.
  - `'worker-src'`: `['blob:']`. Redoc's search runs in a blob worker.
  - `'upgrade-insecure-requests'`: `null`. The page fetches only its own origin and an `https:` URL, and this
    directive would break the page on plain-HTTP non-localhost dev hosts.
- **JSON-only fallback.** `/docs/openapi.json` never depends on the CDN. If the CDN is blocked or the SRI check
  fails, the page still shows the link, and agents use the JSON directly.

**Alternatives considered:**
- **Swagger UI (`swagger-ui-dist`).** It has "try it out", but needs two assets, two SRI hashes, an inline init script
  that needs a CSP hash, and `validatorUrl: null` to stop a third-party call. Rejected because it has more CSP surface.
  `api.http` and the curl quick start cover "try it".
- **Scalar.** Rejected. It loads fonts from its own CDN by default, its API changes quickly, and its bundle is larger.
- **Two app-level routes.** Rejected by Decision 2.
- **Building the document per request, or lazily.** Rejected. The spec requires one build per app instance at
  startup. Building eagerly also means an unrepresentable schema fails `createApp` (fail fast) instead of a request.

**Rationale.** One pinned asset, no inline code, an exact-URL `script-src`, SRI, and production off by default give
the smallest possible CSP blast radius. The JSON is built and serialized once, and handlers only send a string.

### Decision 5: Generation, components, security, error contract, and drift guards

**Choice: conversion.** `toJsonSchema(schema)` wraps
`z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' })` and strips the root
`$schema` key. `io: 'input'` is used **everywhere**:
- `.transform` would throw in output mode (`zod/v4/core/json-schema-processors.js:339-341`).
- Input mode resolves pipes to their input side (`:730-737`), so the email DTOs document a plain string with
  `maxLength: 254`.
- `.default` fields leave `required` and carry `default` (pagination: `limit` is an integer from 1 to 50, default 5).
- `z.coerce.number()` documents `integer`.
- Response components contain no transforms or defaults, so input and output describe the same shape. One mode
  keeps the spec's "every converted schema uses `io: 'input'`" literal.

**Known fidelity limit.** `format: email` is lost, because it sits on the piped side, and the `passwordPolicy` byte
refinement cannot be represented. The operation descriptions state both rules in prose.

**Choice: mapping to OpenAPI.**

| Operation part | Rendered as |
|---|---|
| `params` (`z.object`) | One `in: path` parameter per property, always `required: true` |
| `query` (`z.object`) | One `in: query` parameter per property; `required` comes from the JSON Schema `required` array |
| `body` | `requestBody` with `content[mediaType].schema`; `required = !schema.safeParse(undefined).success`, so `updateUserBody`'s `.default({})` gives an optional body, matching the bodiless-PUT 200 in `app.test.ts:250-255` |
| `success` (200/201) | `{ data: $ref }`, `{ data: [anyOf $ref], maxItems }` or `{ data: [$ref], meta: $ref PageMeta }` |
| `success` (204) | No content |
| `success` (302) | A `Location` header (`string`, `format: uri`) |
| `errors` | `responses[status] = { $ref: '#/components/responses/<CODE>' }`; the builder adds `INTERNAL` (500) to every operation |
| `security` | `'bearer'` → `[{ bearerAuth: [] }]`; `'optional'` → `[{}, { bearerAuth: [] }]` (search); `'none'` → omitted (there is no top-level `security`) |

**Choice: build-time invariants.** `buildOpenApiDocument` throws, failing `createApp` and the tests, on:
- a duplicate `operationId`;
- a duplicate `(method, path)`;
- a mismatch between the `{param}` segments of a path template and the keys of its `params` schema;
- a converted schema that contains `$defs`, a non-component `$ref`, or a `__shared` registry bucket.

**Choice: components.** `components.ts` defines docs-only zod schemas:
- `ValidationIssue`, `ErrorEnvelope` (`code: z.enum(ERROR_CODES)`) and `PageMeta`;
- coarse resources: `Category`, `Product`, `User`, `Session` (`{ token, user }`) and `TokenGrant` (`{ token }`).

The resources are `z.looseObject`: they list the stable fields and allow extras. `user` and `category` references are
`string | { id, name, … }`, because services populate them on some reads (`product.service.ts:47-48`,
`category.service.ts:26`). Dates are `z.iso.datetime()`. `uid` carries `.meta({ deprecated: true })`. All of them are
registered in one `z.registry<{ id: string }>()` and converted in a single `z.toJSONSchema(registry, { uri: (id) =>
'#/components/schemas/' + id, io: 'input' })` call. That call yields real `$ref`s (`Session.user → User`,
`ErrorEnvelope.details.items → ValidationIssue`) and the per-schema `$id` and `$schema` keys are stripped.

Fallback: if the registry output misbehaves in apply, convert each component on its own, inlined. The structural
tests decide.

These schemas are **executable**. A sampled contract test parses real API responses with them (see Testing Strategy).
`pnpm typecheck` enforces `expectTypeOf<z.output<typeof ErrorEnvelope>>().toExtend<ErrorEnvelope>()` against
`src/core/http/envelope.ts`.

**Choice: security scheme.**
`bearerAuth = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }`. Its description says that the deprecated
`x-token` header is still read when no `Authorization` header is present, that those responses carry
`Deprecation: true`, and that `x-token` is removed in 4.0.0 (`src/middlewares/authenticate.ts:26-40`, ADR-032).
`x-token` is **not** declared as a second scheme, so tools never offer the deprecated path.

**Choice: error contract.**

```ts
export const ERROR_CATALOG = {
  BAD_REQUEST: { status: 400, summary: '…' },
  /* … all 9 codes, in app-error.ts order … */
  INTERNAL: { status: 500, summary: '…' },
} as const satisfies Record<ErrorCode, ErrorCatalogEntry>;
export const ERROR_CODES = Object.keys(ERROR_CATALOG) as [ErrorCode, ...ErrorCode[]];
```

A missing or extra code fails to compile: `satisfies` checks exhaustiveness and excess keys. The catalog feeds three
things: the `ErrorEnvelope.code` enum, `components.responses.<CODE>`, and the `ERROR_CODES.md` drift test.
`app-error.ts` is untouched.

Nuance documented in `ERROR_CODES.md`: `BAD_REQUEST` is not always 400. `toAppError` wraps other HTTP-layer 4xx
errors with that code, such as body-parser's 415 for an unsupported charset (`to-app-error.ts:22-23`).

**Choice: drift guards.** All of them fail closed.

| Guard | Source of truth | Fails when |
|---|---|---|
| (METHOD, path) set equality, after converting `{x}` to `:x` | MATRIX rows under `/api/` (21 unique pairs) | A route is added or removed without a catalog change |
| `security` | MATRIX anonymous cells: all rows have an anonymous 2xx/3xx → `none`; none do → `bearer`; mixed → `optional` | Auth is documented wrong |
| Success status | MATRIX 2xx/3xx statuses are a subset of the documented success | The wrong status is documented |
| Errors | MATRIX 4xx statuses are a subset of the documented error statuses | A 401/403 cell is undocumented |
| `VALIDATION_FAILED` | Present **if and only if** `params`/`query`/`body` is, by identity, an export of some `src/modules/*/*.schemas.ts` | 422 is promised for the documentation-only search and upload schemas, or missing elsewhere |
| Every module DTO is wired in | `fs.globSync('src/modules/*/*.schemas.ts')`, then every `ZodType` export is referenced by some operation | A new DTO is not wired in |
| Transport errors | A JSON body requires `BAD_REQUEST` and `PAYLOAD_TOO_LARGE`; path params require `BAD_REQUEST` | Generic failures are undocumented |
| Search enum | `collection.enum` deep-equals `SEARCH_COLLECTIONS`, and `BAD_REQUEST` is documented | D4 drift |
| `info.version` | Equals `package.json` `version` (`API_VERSION` constant) | A release forgets the documented version |

**Alternatives considered:**
- **Hand-written JSON for components.** Rejected: it cannot be checked against live responses.
- **Precise response models.** Out of scope (proposal).
- **An OpenAPI validator dependency.** Rejected by ADR-025. Structural invariant tests cover it instead.
- **Reading `package.json` at runtime for `info.version`.** Rejected: it is I/O inside `createApp` (ARC-02), and
  `rootDir: src` blocks a JSON import.

**Rationale.** Every fact in the document traces to code, and every hand-written part (summaries, error lists,
coarse components) is pinned by a test against a source that already exists.

### Decision 6: CQ-07, removing `public/` and simplifying the global headers

**Choice.**
- Delete `public/index.html`, `public/js/auth.js`, `public/css/index.css` and `public/assets/{github,linkedin,logo,twitter,web}.svg`
  (8 files, 111 lines).
- In `src/app.ts`, remove `import path`, `PUBLIC_DIR` (`:28`) and `app.use(express.static(PUBLIC_DIR))` (`:62`).
- Simplify the helmet options:

```ts
// Helmet's defaults (CSP, COOP same-origin, …) plus two API choices: CORP cross-origin, so other origins can embed the
// image GET /api/uploads/:collection/:id redirects to (#22), and the referrer policy.
const HELMET_OPTIONS: HelmetOptions = {
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
};
```

- Drop the dead `public/` ignore entries from `eslint.config.mjs:37` and `.prettierignore:3`.

**Resulting global headers** (asserted exactly; these are the helmet 8.3.0 defaults from `index.cjs:14-26`):
- `content-security-policy`: `default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests`
- `cross-origin-opener-policy`: `same-origin`
- `cross-origin-resource-policy`: `cross-origin` (unchanged)
- `referrer-policy`: `strict-origin-when-cross-origin` (unchanged)

**Why CORP stays.** The code shows it is not page-only:
- `GET /api/uploads/:collection/:id` is public. It answers `res.redirect(302, …)` (`media.controller.ts:20-23`;
  matrix #22: anonymous → 302), and consumers embed it as `<img src>`.
- That image load is a cross-origin no-cors request. The Fetch "cross-origin resource policy check" runs on the
  response, redirects included, before the redirect is followed.
- Helmet's default CORP is `same-origin`, which would block those embeds.
- The existing comment at `app.ts:30-31` and M1's task (`docs/tasks/M1-stabilization.md:121`) already name image
  embedding as CORP's reason.
- The demo-page spec requires CORP to stay unless it is proven page-only. That proof does not exist, and the
  evidence points the other way.

**Test blast radius:**

| File | Change |
|---|---|
| `tests/integration/platform/app.test.ts:203-215` | Replace the GIS assertions with exact-equality checks on the four headers above, plus `not.toContain('accounts.google.com')` and `'fonts.g'`. |
| `tests/integration/platform/app.test.ts:242-248` | Replace "GET / serves the demo page" with "GET / is 404 NOT_FOUND (CQ-07)". Rename the `describe` at `:234`. |
| `tests/integration/platform/server.test.ts:93-94` | `fetch('/')` expecting 200 becomes `fetch('/api/category')` expecting 200. |
| `tests/integration/security/reliability.test.ts:187-188` | The follow-up `get('/')` expecting 200 becomes `get('/api/category')` expecting 200. The intent ("the next request works") is unchanged. |

The other `get('/')` header tests in `app.test.ts` (request id, `x-powered-by`, CORS) still pass on the 404, because
those middlewares run before `notFound`.

**Alternatives considered:**
- **A strict API-only CSP (`default-src 'none'`).** Deferred: it is hardening beyond D1's "simplify" and fits M9's
  production checklist better.
- **Dropping CORP.** Rejected by the evidence above.

### Decision 7: Documentation artifacts

| Artifact | Decision |
|---|---|
| `README.md` (root, new) | Follows the cognitive-doc-design shape (outline below). It links to the deep material and never copies it. |
| `.env.example` | `git mv .example.env .env.example` keeps the history: the file already exists and lists every key (`.example.env:1-27`). Add `DOCS_ENABLED=` with an explanatory comment. Secrets stay empty. Historical `.example.env` mentions in ARCHITECTURE and the design docs stay as they are. |
| `ERROR_CODES.md` (root, new, D6) | An envelope example first, then a table, then the raw-error mapping and the `details` semantics (shape below). |
| `api.http` (root, new) | A single file. File variables come first (`@baseUrl = http://localhost:1500`, `@token`, `@categoryId`, `@productId`, `@userId`). Then 21 requests separated by `###`, each with `# @name <operationId>`, in runnable session order: sign up → log in → catalog CRUD → search → media → users (admin) → change password → deletes → Google → `logoutAll` last, because it revokes the token. Bearer requests send `Authorization: Bearer {{token}}`. It uses only the subset of syntax shared by the VS Code REST Client and the JetBrains HTTP Client. |

**README outline:**

```
# Backed REST Server
<One paragraph: what the API serves (users, categories, products, search, media), for whom, contract 3.x.>

## Quick path
1. Node 24 (.nvmrc), pnpm 12 (corepack enable), MongoDB ≥ 4.4
2. pnpm install
3. cp .env.example .env, then fill MONGO_CLOUD, SECRET_KEY, GOOGLE_CLIENT_ID, CLOUDINARY_URL
4. pnpm migrate up   (then pnpm seed for the first admin)
5. pnpm dev, then open http://localhost:1500/docs
## Curl quick start            sign up → log in (token) → authenticated call
## API reference               /docs, /docs/openapi.json, api.http, ERROR_CODES.md, API_PROGRESS.md
## Environment                 table: Variable | Required | Default | Purpose (every envSchema key, DOCS_ENABLED table)
## Scripts                     table: `pnpm <name>` | What it does (every package.json script)
## Architecture                5-line summary, then links to ARCHITECTURE.md (§2, §1.14), API_PROGRESS.md, ROADMAP.md,
                               TECH_DEBT.md, CHANGELOG.md
## Manual Google sign-in       how to mint an id_token for GOOGLE_CLIENT_ID now that the demo page is gone
## Tests                       pnpm test (mongodb-memory-server), coverage gates, no vi.mock
```

**`ERROR_CODES.md` shape:**

```
# Error codes
<Envelope: { "error": { "code", "message", "details"? } } (ADR-021), JSON example. Switch on `code`, never on `message`.>
## Codes
| Code | HTTP | Meaning | Typical triggers | `details` |
|---|---|---|---|---|
| `BAD_REQUEST` | 400 | … | malformed JSON; undecodable path escape; operator object in a filter; unknown search
                              collection; missing or non-image upload; other HTTP-layer 4xx (for example 415) keep this code | — |
| … 8 more rows, in app-error.ts order …
## How raw errors map (toAppError)   body-parser 413 → 413; other exposed 4xx/URIError → BAD_REQUEST; Mongo 11000 → 409;
                                     Mongoose ValidationError/CastError → 400; anything else → 500 (cause logged with x-request-id)
## `details` (422 only)              [{ path, message }], every issue, example
```

**Rationale.** Root placement follows the ledger convention (API_PROGRESS.md, TECH_DEBT.md). Each artifact leads with
the quick path, and the doc-drift tests (Testing Strategy) keep the hand-written content honest.

### Decision 8: Test plan and slice order

The **test plan** is in Testing Strategy.

**Slice order.** Delivery is `auto-chain` on a feature-branch chain: a tracker branch `feat/m8-api-documentation`
off `next`. PR #1 targets the tracker, and each later PR targets the previous slice's branch. `sdd-tasks` owns the
binding forecast.

| Slice | Content | About this many authored lines |
|---|---|---|
| S1 | D1: delete `public/`, simplify `HELMET_OPTIONS`, update the 3 tests, drop the dead ignore entries | 170 |
| S2 | `DOCS_ENABLED` (env, config, server warning, tests); the `src/docs/` lint layer; `error-catalog.ts`; `components.ts`; the sampled response-contract integration test | 370 |
| S3 | `openapi.ts` builder and `toJsonSchema`, with synthetic-operation unit tests and `tests/helpers/openapi.ts` (walks `$ref`s and JSON pointers) | 360 |
| S4 | `operations.ts` (21 operations) and the drift and DTO tests against MATRIX and the schema glob | 380 |
| S5 | `page.ts`, `index.ts`, the `app.ts` mount, matrix rows #26 and #27 with the `authorize-matrix` updates, and the docs integration tests | 380 |
| S6 | `README.md`, the `.env.example` rename plus `DOCS_ENABLED`, `ERROR_CODES.md`, and the doc-drift tests | 330 |
| S7 | `api.http` with its drift test; ledgers: TECH_DEBT (DOC-01, CQ-07), API_PROGRESS (#23 ✂️, #26, #27, totals), ROADMAP M8, CHANGELOG `[Unreleased]`, ARCHITECTURE ADR-045…050 and §1.14 | 340 |

S1 lands first because it is isolated and small, and it settles `app.ts` and `app.test.ts` before S5 edits them
again. S2 through S5 are strictly ordered. S6 and S7 can swap.

## Data Flow

```
boot   loadConfig ─► config.docs.enabled ─► createApp
                                              │
                         enabled? ── no ──►  (no /docs layer) ─► GET /docs* ─► notFound ─► 404 envelope
                              │
                             yes
                              ▼
                     docsModule()                                  (once per app instance)
                       buildOpenApiDocument(API_OPERATIONS)
                         ├─ request: modules/*/*.schemas.ts ─ z.toJSONSchema(io:'input') ─► parameters / requestBody
                         ├─ components.ts registry ─ z.toJSONSchema(registry, uri) ─► components.schemas ($ref)
                         └─ ERROR_CATALOG ─► components.responses + ErrorEnvelope.code enum
                       JSON.stringify ─► cached string
                              │
           GET /docs ─► docs CSP ─► static HTML ─(browser)─► jsDelivr Redoc (SRI) ─► fetch /docs/openapi.json
           GET /docs/openapi.json ─► cached JSON  (Cache-Control: no-cache, ETag → 304)
```

```
Drift chain (tests)
live routers ══ MATRIX (ADR-044) ══ API_OPERATIONS ══ api.http (@name)
module *.schemas.ts exports ⊆ operation schemas (identity)
ErrorCode ══(compile)══ ERROR_CATALOG ══ AppError statuses ══ ERROR_CODES.md rows
envSchema keys ⊆ README, .env.example        package.json scripts ⊆ README
```

## File Changes

| File | Action | Slice | Description |
|---|---|---|---|
| `public/index.html`, `public/js/auth.js`, `public/css/index.css`, `public/assets/*.svg` (5) | Delete | S1 | CQ-07 / D1 |
| `src/app.ts` | Modify | S1, S5 | S1: drop static, `PUBLIC_DIR`, `path`, the GIS CSP and COOP. S5: `if (config.docs.enabled) app.use('/docs', docsModule())` |
| `eslint.config.mjs` | Modify | S1, S2 | S1: drop `'public/'` from ignores. S2: add the `src/docs/**` layer |
| `.prettierignore` | Modify | S1 | Drop `public/` |
| `tests/integration/platform/app.test.ts` | Modify | S1 | Exact header asserts; `/` is 404 |
| `tests/integration/platform/server.test.ts` | Modify | S1, S2 | S1: `/` → `/api/category`. S2: invalid `DOCS_ENABLED` exits 1; a production boot with `DOCS_ENABLED=true` warns and serves `/docs/openapi.json` |
| `tests/integration/security/reliability.test.ts` | Modify | S1 | Follow-up `/` → `/api/category` |
| `src/config/env.ts` | Modify | S2 | `DOCS_ENABLED` entry |
| `src/config/index.ts` | Modify | S2 | `Config.docs.enabled` and its resolution |
| `src/server.ts` | Modify | S2 | Production warning when docs are on |
| `tests/unit/config.test.ts` | Modify | S2 | All 9 cells, invalid values, `''` treated as unset; `docs` added to the defaults `toEqual` |
| `src/docs/error-catalog.ts` | Create | S2 | `ERROR_CATALOG`, `ERROR_CODES` |
| `src/docs/components.ts` | Create | S2 | Response components, registry conversion, `BEARER_SCHEME` |
| `tests/unit/docs/error-catalog.test.ts` | Create | S2 | Catalog statuses equal `new <X>Error().status`; codes in order |
| `tests/unit/docs/components.test.ts` | Create | S2 | Registry output: `$ref`s resolve, no `$id`/`$schema`/`__shared`; `expectTypeOf` envelope check |
| `tests/integration/docs/response-contract.test.ts` | Create | S2 | Sampled live responses parse with the component schemas |
| `src/docs/openapi.ts` | Create | S3 | Types, `toJsonSchema`, `buildOpenApiDocument`, `API_VERSION` |
| `tests/helpers/openapi.ts` | Create | S3 | `collectRefs`, `resolvePointer`, `pathParams` |
| `tests/unit/docs/openapi.test.ts` | Create | S3 | Builder branches and invariants with synthetic operations; the output-mode negative control |
| `src/docs/operations.ts` | Create | S4 | `API_OPERATIONS` plus the two documentation-only schemas (search params, image upload) |
| `tests/unit/docs/operations.test.ts` | Create | S4 | Drift guards (Decision 5), DTO glob, real-document invariants, version |
| `src/docs/page.ts` | Create | S5 | `UI_BUNDLE`, `DOCS_PAGE_HTML`, `DOCS_CSP_DIRECTIVES` |
| `src/docs/index.ts` | Create | S5 | `docsModule()` |
| `tests/helpers/permission-matrix.ts` | Modify | S5 | `'/docs'` prefix; rows #26 and #27 |
| `tests/integration/security/authorize-matrix.test.ts` | Modify | S5 | `fire` #26/#27; 7-index permutations; pinned `DOCS_ENABLED: 'true'` |
| `tests/unit/docs/page.test.ts` | Create | S5 | Pin and SRI format, HTML references, CSP directives; an opt-in SRI network check |
| `tests/integration/docs/docs.test.ts` | Create | S5 | Endpoints, flag matrix, CSP scoping, caching, build-once |
| `.example.env` → `.env.example` | Rename + Modify | S6 | `git mv`; add `DOCS_ENABLED=` |
| `README.md` | Create | S6 | Decision 7 outline |
| `ERROR_CODES.md` | Create | S6 | Decision 7 shape |
| `tests/unit/docs/doc-drift.test.ts` | Create | S6, S7 | README env keys and scripts; `.env.example` keys, boot and no secrets; `ERROR_CODES.md` rows; S7 adds `api.http` |
| `api.http` | Create | S7 | 21 requests |
| `TECH_DEBT.md`, `API_PROGRESS.md`, `ROADMAP.md`, `CHANGELOG.md`, `ARCHITECTURE.md` | Modify | S7 | DOC-01 and CQ-07 closed; #23 ✂️; #26 and #27 added; M8 outcome; `[Unreleased]` Added/Changed/Removed; ADR-045…050; §1.14 "State after M8"; §2.3 rule 6 |

There are no changes under `src/modules/`, `src/core/` or `src/middlewares/`, and none to `package.json` or the
lockfile.

## Interfaces / Contracts

```ts
// src/docs/openapi.ts
export const API_VERSION = '3.0.0'; // == package.json version (tested); bumped with every release
export type ApiTag = 'Auth' | 'Users' | 'Categories' | 'Products' | 'Search' | 'Media';
export type Security = 'none' | 'bearer' | 'optional';
export type ResponseBody =
  | { readonly envelope: 'data'; readonly of: ComponentName | readonly ComponentName[] } // array → anyOf
  | { readonly envelope: 'data-list'; readonly of: readonly ComponentName[]; readonly maxItems: number }
  | { readonly envelope: 'page'; readonly of: ComponentName };

export interface ApiOperation {
  readonly operationId: string;               // also the api.http `# @name`
  readonly method: 'get' | 'post' | 'put' | 'delete';
  readonly path: `/api/${string}`;            // OpenAPI template: /api/category/{id}
  readonly tag: ApiTag;
  readonly summary: string;
  readonly description: string;               // who may call it (API_PROGRESS "Auth"), notable rules
  readonly security: Security;
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: { readonly schema: z.ZodType; readonly mediaType: 'application/json' | 'multipart/form-data' };
  readonly success:
    | { readonly status: 200 | 201; readonly description: string; readonly body: ResponseBody }
    | { readonly status: 204 | 302; readonly description: string };
  readonly errors: readonly Exclude<ErrorCode, 'INTERNAL'>[];
}

export function toJsonSchema(schema: z.ZodType): JsonSchema;          // io:'input', $schema stripped, throws if unrepresentable
export function buildOpenApiDocument(operations: readonly ApiOperation[]): OpenApiDocument; // throws on invariants
```

```ts
// src/docs/operations.ts: an example entry and the two documentation-only schemas
// D4 (ADR-048): documentation only. The route validates nothing; the service answers 400 for an unknown collection.
const searchParams = z.object({ collection: z.enum(SEARCH_COLLECTIONS), term: z.string() });
// Enforced by fileParser/requireImage (400/413), never zod: so no 422.
const imageUpload = z.object({
  file: z.file().max(MAX_FILE_BYTES).describe('One PNG, JPEG or GIF, recognised by its first bytes; at most 5 MB'),
});

{
  operationId: 'updateCategory', method: 'put', path: '/api/category/{id}', tag: 'Categories',
  summary: 'Rename a category',
  description: 'ADMIN_ROLE or VENTAS_ROLE. Categories are shared: there are no creator rights (AM-M6-2).',
  security: 'bearer', params: categoryIdParams,
  body: { schema: updateCategoryBody, mediaType: 'application/json' },
  success: { status: 200, description: 'The updated category', body: { envelope: 'data', of: 'Category' } },
  errors: ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED'],
},
```

```ts
// src/docs/page.ts
export const UI_BUNDLE = { version: 'x.y.z', integrity: 'sha384-…' } as const; // resolved and verified in S5
export const UI_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/redoc@${UI_BUNDLE.version}/bundles/redoc.standalone.js`;
export const DOCS_CSP_DIRECTIVES = {
  'script-src': [UI_BUNDLE_URL],
  'worker-src': ['blob:'],
  'upgrade-insecure-requests': null,
};
export const DOCS_PAGE_HTML: string; // no inline script or style; the fallback link comes first
```

**The `GET /docs` CSP, asserted exactly:**
`default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src <UI_BUNDLE_URL>;script-src-attr 'none';style-src 'self' https: 'unsafe-inline';worker-src blob:`

**HTTP contract:**
- When docs are enabled:
  - `GET /docs` answers `200 text/html; charset=utf-8`, with `Cache-Control: no-cache`, an ETag and the docs CSP.
  - `GET /docs/openapi.json` answers `200 application/json; charset=utf-8`, with `Cache-Control: no-cache`, an ETag
    and the global CSP.
- When docs are disabled, both answer `404 {"error":{"code":"NOT_FOUND","message":"Route not found"}}`.

## Testing Strategy

Every new `src/**` file must meet the per-file 90/90/80/90 bar. Rules for every test: no `vi.mock`, real zod schemas,
plain calls, `startTestApp(overrides)` for flag variants, and injected fakes through `docsModule({ buildDocument })`.

| Layer | What to test | Approach |
|---|---|---|
| Unit: config | All 9 `NODE_ENV × {unset, 'true', 'false'}` cells; `''` is unset; `1`, `yes`, `TRUE`, ` true`, `on` each give a `ConfigError` matching `/must be 'true' or 'false'\n\s+→ at DOCS_ENABLED/`; defaults `toEqual` includes `docs: { enabled: true }` | `loadConfig` with a `VALID` source (`tests/unit/config.test.ts` pattern) |
| Unit: error catalog | For each code, `new <Class>(…).status === ERROR_CATALOG[code].status`; `ERROR_CODES` equals the 9 codes in `app-error.ts` order | Instantiate the real classes |
| Unit: components | Registry output: every `$ref` resolves under `components.schemas`; no `$id`/`$schema`/`__shared`; `ErrorEnvelope.code.enum` equals `ERROR_CODES`; `expectTypeOf` envelope assignability (enforced by `pnpm typecheck`) | Plain calls |
| Unit: builder | Synthetic operations cover every branch: path, query and body parts; optional body; multipart; 200/201 data, data-list and page; 204; 302 with `Location`; security none, bearer and optional; `INTERNAL` added; throws on a duplicate operationId, a duplicate (method, path), and a path/params mismatch. Invariants: `openapi` matches `3.1.x`, all `$ref`s resolve, operationIds are unique, every `{param}` has a required `in: path` parameter. Negative control: `z.toJSONSchema(loginBody, { io: 'output' })` throws | `tests/helpers/openapi.ts` walkers |
| Unit: catalog drift | Every guard in the Decision 5 table; the search enum equals `SEARCH_COLLECTIONS`; `info.version` equals the `package.json` version; the real document passes the builder invariants | Import `MATRIX`; `fs.globSync` and dynamic import of `*.schemas.ts` |
| Unit: page | `version` matches `^\d+\.\d+\.\d+$`; `integrity` matches `^sha384-[A-Za-z0-9+/]{64}$`; the HTML has exactly one `<script src=UI_BUNDLE_URL integrity crossorigin="anonymous">`, no inline `<script>` body, and the fallback link; the CSP `script-src` equals `[UI_BUNDLE_URL]`. An opt-in (`VERIFY_SRI=1`, skipped by default) test fetches the bundle and checks the hash | Plain asserts. The opt-in test is a remote read and needs user authorization when run |
| Integration: docs | Enabled: both endpoints return 200 with the right type; the JSON deep-equals `buildOpenApiDocument(API_OPERATIONS)`; a repeated request gets the same ETag; `If-None-Match` gives 304. CSP: `/docs` has the exact docs CSP; `/docs/openapi.json` and `/api/category` have the global CSP without `cdn.jsdelivr.net`. Build-once: a counting `buildDocument` fake plus 2 requests gives 1 call. Flag matrix: 9 cells × 2 routes, mounted or a 404 envelope; an invalid value makes `startTestApp` reject with `ConfigError` | `startTestApp({ NODE_ENV, DOCS_ENABLED })`; `docsModule()` on a bare `express()` behind `node:http` (TEST-02) for the DI case |
| Integration: response contract | Sign up gives `User`; log in gives `Session`; create, get and list a category and a product give `Category`/`Product` and `PageMeta`; change password gives `TokenGrant`; a 404 and a 422 parse with `ErrorEnvelope` | Real API through `startTestApp`; `Schema.parse(res.body…)` |
| Integration: ADR-044 | Fixture rows #26/#27 fire 200; the drift and TEST-05 permutations pass with 7 routers | The existing suite, updated. Scratch run: remove the rows → fails closed (evidence recorded in tasks, not committed) |
| Integration: D1 headers | Exact global CSP, COOP `same-origin`, CORP `cross-origin`, referrer policy; `GET /` is 404 `NOT_FOUND` | `app.test.ts` |
| Process: `server.ts` | `DOCS_ENABLED=yes` exits 1 naming it; `NODE_ENV=production DOCS_ENABLED=true` logs the warning and `GET /docs/openapi.json` returns 200; `/api/category` returns 200 after boot | `server.test.ts` spawn pattern (`server.ts` is excluded from coverage) |
| Doc drift | Every `envSchema.shape` key appears as `` `KEY` `` in README and as `^KEY=` in `.env.example`; every `package.json` script appears as `` `pnpm <name>` `` in README; `.env.example` with secret placeholders filled passes `loadConfig`; `SECRET_KEY`, `CLOUDINARY_URL` and `SEED_ADMIN_PASSWORD` are empty in the example; `ERROR_CODES.md` has exactly one row `` ^\| `CODE` \| STATUS \| `` per code; README links `ARCHITECTURE.md`, `API_PROGRESS.md` and `ERROR_CODES.md`; `api.http` `@name`s equal the operationIds (21), each request's method and path match its template (with `{{var}}` treated as a segment), and every `bearer` request sends `Authorization: Bearer {{token}}` | `fs.readFileSync` from the repository root |
| Manual (S5, once) | Open `/docs` in a browser: zero CSP violations in the console, Redoc renders all 21 operations | Recorded as task evidence; adjust `DOCS_CSP_DIRECTIVES` only on observed violations |

## Threat Matrix

The skill's matrix covers command and VCS/PR boundaries. It does not apply here: this change adds an HTTP route,
which is not a shell, subprocess, VCS automation, PR automation or file-classification boundary.

| Boundary | Applicability | Reason |
|---|---|---|
| Documentation-like paths | N/A | `api.http`, `README.md` and `ERROR_CODES.md` are data read by editors and humans. The app and CI never execute or classify them. |
| Git repository selection | N/A | No git automation |
| Commit state | N/A | No commit automation |
| Push state | N/A | No push automation |
| PR commands | N/A | No PR automation |

The HTTP surface's own risks are covered by Decisions 3, 4 and 6 and their tests:
- production exposure is off by default, the flag is parsed strictly, and a boot warning fires when it is on;
- the CDN supply chain is limited by an exact version, SRI and an exact-URL `script-src`;
- the CSP is scoped to `GET /docs`;
- no endpoint reveals that docs exist when they are disabled.

## Migration / Rollout

- **No data migration.** No database, index, or persisted state is involved.
- **Operational:**
  - Production keeps docs **off** unless `DOCS_ENABLED=true`. Turning them on logs a `warn` at boot.
  - `DOCS_ENABLED=false` is the runtime kill switch in any environment, with no revert needed.
  - An invalid value now stops the boot (ADR-019).
- **Client-visible changes:**
  - Every response carries the helmet default CSP and COOP `same-origin`. The GIS allowances are removed.
  - `GET /` becomes a 404 envelope.
  - These are recorded in CHANGELOG `[Unreleased]` under Removed and Changed.
- **Release:** MINOR (3.1.0) under ADR-024, confirmed at release. That commit bumps `package.json` and `API_VERSION`
  together, and the version test enforces it.
- **Rollback:** each slice reverts independently with `git revert`. Reverting S5 removes the mount, matrix rows
  #26/#27 and the permutation changes together. Reverting S1 restores `public/`, the static mount, the GIS headers
  and the three tests.

## Open Questions

- [ ] **Network read needed in S5 (non-blocking for S1–S4, S6, S7).** Pinning the Redoc version and computing
  `sha384` (`curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`) needs one explicitly authorized remote
  read. If it is not authorized, only the HTML part of S5 waits; `GET /docs/openapi.json` ships.
- [ ] **Spec wording to reconcile (non-blocking).** The `openapi-docs` scenario "Invalid value fails boot fast" lists
  `''` as an invalid example. That contradicts the same requirement's table ("unset / empty → default") and
  `loadConfig`'s empty-means-unset rule (`src/config/index.ts:38-39`). This design follows the table, so `''` means
  unset.
- [ ] **Spec wording to reconcile (non-blocking).** The "built once" scenario suggests a call-count spy on the
  exported builder. This design meets it through ADR-023 factory injection (`docsModule({ buildDocument })` with a
  counting fake), because spying on an ESM named export is not possible.
- [ ] **Proposal correction (informational).** The proposal says there is "no `.env.example`", but `.example.env`
  already exists and is complete. It is renamed, not created.
