# Tasks: M8 API Documentation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~2330 authored lines (170 + 370 + 360 + 380 + 380 + 330 + 340, per design Decision 8) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (S1) → PR 2 (S2) → PR 3 (S3) → PR 4 (S4) → PR 5 (S5) → PR 6 (S6) → PR 7 (S7) |
| Delivery strategy | auto-chain |
| Chain strategy | feature-branch-chain (DECIDED — not pending) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

**Branch topology (feature-branch-chain, per design Decision 8):**

```
next
 └── feat/m8-api-documentation          (tracker, draft, no-merge)
      └── feat/m8-s1-remove-public      PR 1  → targets tracker
           └── feat/m8-s2-flag-components   PR 2  → targets PR 1 branch
                └── feat/m8-s3-builder       PR 3  → targets PR 2 branch
                     └── feat/m8-s4-catalog       PR 4  → targets PR 3 branch
                          └── feat/m8-s5-mount        PR 5  → targets PR 4 branch
                               └── feat/m8-s6-docs         PR 6  → targets PR 5 branch
                                    └── feat/m8-s7-ledgers      PR 7  → targets PR 6 branch (📍 current slice marker moves with apply)
```

Merge order: PR1 → PR2 → ... → PR7 → tracker → `next`. If a child PR ever shows a previous slice's diff, retarget/rebase before requesting review (treat as a base bug, per `chained-pr` skill).

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Remove `public/` demo page, simplify `HELMET_OPTIONS`, fix the 3 blast-radius tests (D1/CQ-07) | PR 1 | `pnpm vitest run tests/integration/platform/app.test.ts tests/integration/platform/server.test.ts tests/integration/security/reliability.test.ts` | `pnpm dev` then `curl -i http://localhost:1500/` expecting 404 `NOT_FOUND` | Revert restores `public/`, the static mount, the GIS headers, and the 3 test files together; no other slice depends on these files existing |
| 2 | `DOCS_ENABLED` flag (env/config/server warning), `src/docs/` lint layer, `error-catalog.ts`, `components.ts`, sampled response-contract test | PR 2 | `pnpm vitest run tests/unit/config.test.ts tests/unit/docs/error-catalog.test.ts tests/unit/docs/components.test.ts tests/integration/docs/response-contract.test.ts` | `DOCS_ENABLED=yes pnpm start` expecting exit 1 naming `DOCS_ENABLED` | Revert removes `src/docs/error-catalog.ts`, `src/docs/components.ts`, their tests, and the config/server changes; `/docs` is not yet mounted, so no runtime route is affected |
| 3 | `openapi.ts` builder (`toJsonSchema`, `buildOpenApiDocument`) with synthetic-operation unit tests and `tests/helpers/openapi.ts` | PR 3 | `pnpm vitest run tests/unit/docs/openapi.test.ts` | N/A — pure functions with no I/O; no server boot needed to exercise them (synthetic-operation unit tests cover all behavior) | Revert removes `src/docs/openapi.ts` and `tests/helpers/openapi.ts`; nothing yet imports the builder into the running app |
| 4 | `operations.ts` (21 real operations) wired to module schemas, plus the drift/DTO/version tests against MATRIX and the schema glob | PR 4 | `pnpm vitest run tests/unit/docs/operations.test.ts` | N/A — the document is built and asserted in-process against `MATRIX`; no `/docs` route exists yet to probe over HTTP | Revert removes `src/docs/operations.ts` and its test; the builder from PR 3 is unaffected |
| 5 | `page.ts`, `index.ts` (`docsModule()`), the `app.ts` mount, matrix rows #26/#27 + 7-index permutations, docs integration tests | PR 5 | `pnpm vitest run tests/unit/docs/page.test.ts tests/integration/docs/docs.test.ts tests/integration/security/authorize-matrix.test.ts` | `DOCS_ENABLED=true pnpm dev` then `curl -i http://localhost:1500/docs` and `curl -i http://localhost:1500/docs/openapi.json`, confirming 200 + docs CSP on the first and 200 + global CSP on the second | Revert removes the `/docs` mount in `app.ts`, `src/docs/page.ts`, `src/docs/index.ts`, and the matrix rows/permutation changes together; S1–S4 files are unaffected |
| 6 | `README.md`, `.env.example` rename + `DOCS_ENABLED`, `ERROR_CODES.md`, doc-drift tests (env keys, scripts, error codes) | PR 6 | `pnpm vitest run tests/unit/docs/doc-drift.test.ts` | `cp .env.example .env` (placeholders filled), then `pnpm dev` boots without a `ConfigError` | Revert removes `README.md`, `ERROR_CODES.md`, reverts the `.env.example` rename, and drops the drift-test assertions added in this slice; the running app is unaffected (docs were already mounted in PR 5) |
| 7 | `api.http` + its drift test; ledger closures (TECH_DEBT, API_PROGRESS, ROADMAP, CHANGELOG, ARCHITECTURE ADR-045+) | PR 7 | `pnpm vitest run tests/unit/docs/doc-drift.test.ts` plus full `pnpm test` | Open `api.http` in the VS Code REST Client (or JetBrains HTTP Client) against a running `pnpm dev` instance and run the sign-up → log-in → authenticated-call sequence manually; record pass/fail | Revert removes `api.http` and reverts the 5 ledger files to their pre-slice content; no runtime behavior changes |

---

## Fixed Constraints (owner decisions D1–D6, non-negotiable at apply time)

- **D1** — Remove `public/` entirely (8 files); no replacement demo page.
- **D2** — OpenAPI generation uses `z.toJSONSchema({ io: 'input' })` on each module's own exported zod schemas, zero new dependencies; no module file under `src/modules/` changes.
- **D3** — `/docs` is a static HTML page plus a pinned Redoc CDN bundle (exact version, SRI hash); CSP scoped to `GET /docs` only, global `HELMET_OPTIONS` is never widened.
- **D4** — The `search` module's documentation comes from the existing exported `SEARCH_COLLECTIONS` constant; `src/modules/search/` is not touched and gets no new zod schema.
- **D5** — `DOCS_ENABLED` is a strict `'true' | 'false'` literal union (never `z.coerce.boolean()`); unset resolves to on in `development`/`test` and off in `production`.
- **D6** — The error-code catalogue lives at root `ERROR_CODES.md`, linked from `README.md`, not duplicated into it.

Standing constraints for every task that creates a `src/**` file: per-file coverage bar 90% lines / 90% functions / 80% branches / 90% statements, no `vi.mock` (ADR-023), zero new npm dependencies or lockfile changes (ADR-025), Conventional Commit messages, no AI attribution in commit messages.

TDD mode is **disabled** for this project (source: `sdd-init` testing-capabilities; runner `pnpm test` / vitest 5). Tasks below run ordinary functional checks (write test + implementation together, verify both pass) rather than a mandated RED → GREEN → REFACTOR sequence. The design's Threat Matrix section is explicitly `N/A` for this change (no shell/VCS/PR automation boundary is touched), so no threat-matrix RED-test tasks apply.

---

## Phase 1: Remove `public/` demo page and simplify global headers (Slice S1, ~170 lines)

- [x] 1.1 Delete `public/index.html`, `public/js/auth.js`, `public/css/index.css`, and `public/assets/{github,linkedin,logo,twitter,web}.svg` (8 files total — CQ-07 / D1).
- [x] 1.2 Edit `src/app.ts`: remove the `import path` statement, the `PUBLIC_DIR` constant, and the `app.use(express.static(PUBLIC_DIR))` call; replace `HELMET_OPTIONS` with exactly `{ crossOriginResourcePolicy: { policy: 'cross-origin' }, referrerPolicy: { policy: 'strict-origin-when-cross-origin' } }`, removing the GSI `scriptSrc`/`styleSrc` allowlist entries, the `frameSrc` allowance, the `connectSrc` GSI allowance, and the `crossOriginOpenerPolicy: 'same-origin-allow-popups'` line.
- [x] 1.3 Edit `eslint.config.mjs`: remove the `'public/'` entry from the ignores list (line ~37).
- [x] 1.4 Edit `.prettierignore`: remove the `public/` line (line ~3).
- [x] 1.5 Update `tests/integration/platform/app.test.ts`: replace the GIS/Google-Fonts CSP and COOP assertions (around `:203-215`) with exact-equality checks against the four documented post-removal headers (`content-security-policy`, `cross-origin-opener-policy: same-origin`, `cross-origin-resource-policy: cross-origin`, `referrer-policy: strict-origin-when-cross-origin`), plus `not.toContain('accounts.google.com')` and `not.toContain('fonts.g')` on the CSP value; replace the demo-page test (around `:242-248`) with a `GET /` → 404 `NOT_FOUND` envelope assertion and rename its enclosing `describe` block away from "demo page".
- [x] 1.6 Update `tests/integration/platform/server.test.ts:93-94`: change the smoke-test `fetch('/')` expecting 200 to `fetch('/api/category')` expecting 200.
- [x] 1.7 Update `tests/integration/security/reliability.test.ts:187-188`: change the follow-up `get('/')` expecting 200 to `get('/api/category')` expecting 200 (same "the next request still works" intent, new target route).
- [x] 1.8 Confirm no remaining reference to the removed demo page: `rg -n "public/(index\.html|js/auth\.js|css/index\.css|assets)" src tests` and `rg -n "accounts\.google\.com|same-origin-allow-popups" src tests` both return no matches.

**Verify (PR 1):**
- `pnpm vitest run tests/integration/platform/app.test.ts tests/integration/platform/server.test.ts tests/integration/security/reliability.test.ts`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` (full suite — confirms no other test still depends on `public/` or the old headers, per spec scenario "No test depends on the removed demo page")

**Evidence to record:** pasted pass/fail output of each command above; confirmation that the 3 named blast-radius test files pass; output of the `rg` greps from 1.8 showing zero matches.

---

**Phase 1 (S1) evidence — completed 2026-10-04**: commit bde2491 (14 files, +18/−150, 168 authored lines). public/ (8 files) deleted; src/app.ts without express.static/PUBLIC_DIR, HELMET_OPTIONS = CORP cross-origin + referrerPolicy only; eslint ignores and .prettierignore cleaned. Blast-radius tests fixed (app.test.ts exact-CSP + GET / 404 envelope; server.test.ts:93 and reliability.test.ts:187 → /api/category). Focused suites 44/44; full suite 1274/1274; typecheck/lint/format exit 0. Residue greps clean in src/ (tests/ matches are the not.toContain assertion and Google token issuer fixtures — task 1.8's repo-wide grep wording should be read as src/-scoped). TESTER PASS (wH:pG); REVIEWER APPROVE zero findings (wH:pC — security posture improved, CORP keep justified by the media 302). RDD: range 802faee..bde2491 HIGH → consent granted → native 4R APPROVED with 4 advisory SUGGESTIONs (R2-csp-literal, R3-csp-exact-string, R3-liveness-probe-route, R4-001 — test-detail follow-ups), acknowledged, authority burned (lineage review-bea24c1a85258b3a); reviewed boundary bde2491. Route: delegated (writer wH:p7).

## Phase 2: `DOCS_ENABLED` flag, docs lint layer, error catalog, response components (Slice S2, ~370 lines)

- [x] 2.1 Edit `src/config/env.ts`: add `DOCS_ENABLED: z.enum(['true', 'false'], "must be 'true' or 'false'").transform((value) => value === 'true').optional()` to `envSchema`.
- [x] 2.2 Edit `src/config/index.ts`: add `readonly docs: { readonly enabled: boolean }` to the `Config` type and resolve it in `loadConfig()` as `docs: { enabled: env.DOCS_ENABLED ?? env.NODE_ENV !== 'production' }`.
- [x] 2.3 Edit `src/server.ts`: add the production boot-warning line next to the existing ADR-022 CORS warning — `if (config.env === 'production' && config.docs.enabled) logger.warn('DOCS_ENABLED=true: /docs serves the API description in production')`.
- [x] 2.4 Update `tests/unit/config.test.ts`: add all 9 `NODE_ENV × {unset, 'true', 'false'}` cells; assert `''` behaves as unset; assert invalid values (`'1'`, `'yes'`, `'TRUE'`, `' true'`, `'on'`) each raise a `ConfigError` matching `/must be 'true' or 'false'\n\s+→ at DOCS_ENABLED/`; add `docs: { enabled: true }` to the existing defaults `toEqual` assertion.
- [x] 2.5 Edit `eslint.config.mjs`: add the `src/docs/**/*.ts` composition layer forbidding imports matching `\.(routes|controller|model)$|^mongoose$|(^|/)(middlewares|database)(/|$)`, per design Decision 1.
- [x] 2.6 Create `src/docs/error-catalog.ts`: `ERROR_CATALOG` as `const satisfies Record<ErrorCode, ErrorCatalogEntry>` covering all 9 `ErrorCode` values from `src/core/errors/app-error.ts` in that file's declared order (status + summary per code), and `ERROR_CODES = Object.keys(ERROR_CATALOG) as [ErrorCode, ...ErrorCode[]]`.
- [x] 2.7 Create `src/docs/components.ts`: docs-only zod schemas `ValidationIssue`, `ErrorEnvelope` (`code: z.enum(ERROR_CODES)`), `PageMeta`, `Category`, `Product`, `User`, `Session` (`{ token, user }`), `TokenGrant` (`{ token }`), all `z.looseObject`, registered in one `z.registry<{ id: string }>()` and converted via a single `z.toJSONSchema(registry, { uri: (id) => '#/components/schemas/' + id, io: 'input' })` call with `$id`/`$schema` stripped per schema; export `BEARER_SCHEME = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }` with the `x-token` deprecation description (ADR-032).
- [x] 2.8 Create `tests/unit/docs/error-catalog.test.ts`: for each of the 9 codes, assert `new <Class>(…).status === ERROR_CATALOG[code].status` by instantiating the real error classes; assert `ERROR_CODES` equals the 9 codes in `app-error.ts`'s declared order.
- [x] 2.9 Create `tests/unit/docs/components.test.ts`: assert every `$ref` in the registry output resolves under `components.schemas`; assert no `$id`/`$schema`/`__shared` keys remain; assert `ErrorEnvelope.code.enum` deep-equals `ERROR_CODES`; add `expectTypeOf<z.output<typeof ErrorEnvelope>>().toExtend<ErrorEnvelope>()` against `src/core/http/envelope.ts` (enforced by `pnpm typecheck`).
- [x] 2.10 Create `tests/integration/docs/response-contract.test.ts`: using `startTestApp`, exercise sign-up (→ `User`), log-in (→ `Session`), create/get/list category and product (→ `Category`/`Product`/`PageMeta`), change-password (→ `TokenGrant`), a 404 and a 422 (→ `ErrorEnvelope`), parsing each real response body with the matching component schema via `Schema.parse(res.body…)`.

**Verify (PR 2):**
- `pnpm vitest run tests/unit/config.test.ts tests/unit/docs/error-catalog.test.ts tests/unit/docs/components.test.ts tests/integration/docs/response-contract.test.ts`
- `pnpm typecheck` (covers the `expectTypeOf` envelope check)
- `pnpm lint` (covers the new `src/docs/**` layer rule)
- Coverage check on new files: `pnpm test:coverage -- src/docs/error-catalog.ts src/docs/components.ts` (or project's per-file coverage report) confirming ≥90/90/80/90.

**Evidence to record:** pasted pass/fail output of each command; confirmation that `DOCS_ENABLED=yes pnpm start` exits 1 naming `DOCS_ENABLED` (runtime harness for this slice); per-file coverage numbers for the two new `src/docs/` files.

---

**Phase 2 (S2) evidence — completed 2026-10-04**: commit 1fc73bc (10 files, +440). DOCS_ENABLED strict literal union + transform in src/config/env.ts (no z.coerce.boolean; '' = unset; invalid value → ConfigError naming DOCS_ENABLED, boot-checked by hand: DOCS_ENABLED=yes exits 1); config.docs.enabled shape + 3-line production boot warn in src/server.ts (in scope per D5; the automated prod-boot test belongs to S5 with the mount — deviation noted). src/docs/ lint layer verified fail-closed with a throwaway file (4 rejections, schemas import accepted). error-catalog.ts (9 codes, order-coupled test parsed from app-error.ts source) and components.ts (single z.registry + z.toJSONSchema io:'input', real $refs, no $id/$schema/__shared residue, uid deprecated, BEARER_SCHEME with x-token deprecation note). 4 test files, 112 tests; full suite 1311/1311; per-file coverage 100% lines on both new src/docs files; typecheck/lint/format exit 0; package.json untouched. Size 440 vs ~370 forecast (stricter tests) — PR2 over the 400 budget, size decision deferred to publication. TESTER PASS (wH:pG); REVIEWER APPROVE zero findings (wH:pC). RDD: bde2491..1fc73bc medium/slice_budget_reached → granted → review-reliability APPROVED with 2 advisory SUGGESTIONs (R3-error-envelope-sampling, R3-prod-docs-warning-untested — the latter lands with S5's boot test), acknowledged, authority burned (lineage review-863b48d043ba87bc); boundary 1fc73bc. Route: delegated (writer wH:p7).

## Phase 3: OpenAPI builder (`openapi.ts`) and schema conversion (Slice S3, ~360 lines)

- [x] 3.1 Create `src/docs/openapi.ts`: `ApiOperation`, `ApiTag`, `Security`, `ResponseBody` types; `export const API_VERSION = '3.0.0'` (matches current `package.json` version, bumped with every release); `toJsonSchema(schema)` wrapping `z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' })` with the root `$schema` key stripped; `buildOpenApiDocument(operations)` assembling the full document per the mapping table in design Decision 5 (params → path parameters, query → query parameters with `required` from the JSON Schema `required` array, body → `requestBody` with `required = !schema.safeParse(undefined).success`, success 200/201/204/302 envelopes, errors → `$ref` responses with `INTERNAL` added to every operation, security none/bearer/optional mapping).
- [x] 3.2 In `buildOpenApiDocument`, implement the build-time invariant checks that throw: duplicate `operationId`; duplicate `(method, path)`; a mismatch between a path template's `{param}` segments and its `params` schema keys; a converted schema containing `$defs`, a non-component `$ref`, or a `__shared` registry bucket.
- [x] 3.3 Create `tests/helpers/openapi.ts`: `collectRefs`, `resolvePointer`, and `pathParams` walker utilities used by this and later slices' tests.
- [x] 3.4 Create `tests/unit/docs/openapi.test.ts` with synthetic (non-production) operations covering every builder branch: path params, query params, body (including optional body via `.default({})` and multipart); success 200/201 with `data`, `data-list`, and `page` envelopes; 204; 302 with a `Location` header; security `none`/`bearer`/`optional`; `INTERNAL` auto-added to every operation; throws on a duplicate `operationId`, a duplicate `(method, path)`, and a path/params mismatch.
- [x] 3.5 In the same test file, assert document-level structural invariants using the `tests/helpers/openapi.ts` walkers: `openapi` field matches `3.1.x`; every `$ref` resolves; every `operationId` is unique; every `{param}` path segment has a corresponding required `in: path` parameter.
- [x] 3.6 In the same test file, add the negative control: `z.toJSONSchema(loginBody, { io: 'output' })` throws (confirms why `io: 'input'` is required everywhere, per the `openapi-docs` spec's "Output-mode conversion would throw" scenario).

**Verify (PR 3):**
- `pnpm vitest run tests/unit/docs/openapi.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- Coverage check on `src/docs/openapi.ts` confirming ≥90/90/80/90 per-file.

**Evidence to record:** pasted pass/fail output; confirmation all builder-throw branches are exercised (list which synthetic case maps to which invariant); per-file coverage for `src/docs/openapi.ts`.

---

**Phase 3 (S3) evidence — completed 2026-10-04**: commit a325608 (3 new files, +702: src/docs/openapi.ts 232 lines, tests/unit/docs/openapi.test.ts 440, tests/helpers/openapi.ts 30). Builder assembles info/servers/components/securitySchemes and takes the operation list as input (S4 contract per design Decision 5). Structural invariants each with a dedicated throw test: duplicate operationId, duplicate path+method, path/params mismatch (3 cases), non-component $ref, $defs/__shared residue. io:'input' proven load-bearing: loginBody converts in input mode (openapi.test.ts:145-151) and the SAME DTO with io:'output' throws "Transforms cannot be represented" (:153-154). 38 new tests; full suite 1349/1349; openapi.ts per-file coverage 100% lines/functions/branches; typecheck/lint/format exit 0; no deps. Deviations: unreachable 'converted.properties ?? {}' fallback removed (ZodObject always emits properties — reviewer confirmed); info.title/description/servers chosen by the writer (reviewer judged reasonable); 702 lines vs ~360 forecast (exhaustive per-branch tests) — PR3 size decision deferred to publication. TESTER PASS (wH:pG); REVIEWER APPROVE zero findings (wH:pC). RDD: 1fc73bc..a325608 medium/slice_budget_reached → owner DECLINED this candidate (candidate-scoped; boundary stays 1fc73bc; medium-tier verification satisfied by writer self-verification + TESTER full gate + independent reviewer). Route: delegated (writer wH:p7).

## Phase 4: Operation catalog (`operations.ts`) and drift guards (Slice S4, ~380 lines)

- [x] 4.1 Create `src/docs/operations.ts`: `API_OPERATIONS` with exactly 21 entries, one per live `/api/*` operation, each referencing its module's exported `*.schemas.ts` zod schema(s) by identity (no retyping) per the interface shape in design (`operationId`, `method`, `path`, `tag`, `summary`, `description`, `security`, optional `params`/`query`/`body`, `success`, `errors`).
- [x] 4.2 In `src/docs/operations.ts`, add the two documentation-only schemas that are not module exports: `searchParams = z.object({ collection: z.enum(SEARCH_COLLECTIONS), term: z.string() })` (imported from `src/modules/search/search.service.ts`, D4 — no change to that module) and `imageUpload = z.object({ file: z.file().max(MAX_FILE_BYTES).describe(...) })` (imported from `src/modules/media/media.upload.ts`).
- [x] 4.3 Create `tests/unit/docs/operations.test.ts` implementing every drift guard from design Decision 5's table:
  - `(method, path)` set equality against MATRIX rows under `/api/` (21 unique pairs), converting `{x}` to `:x`.
  - `security` consistency: MATRIX anonymous cells all-2xx/3xx → documented `none`; none-anonymous → `bearer`; mixed → `optional`.
  - Documented success status is a superset-compatible match of MATRIX 2xx/3xx statuses.
  - Documented error statuses are a superset of MATRIX 4xx statuses (no undocumented 401/403 cell).
  - `VALIDATION_FAILED` present if and only if `params`/`query`/`body` is, by identity, an export of some `src/modules/*/*.schemas.ts` file.
  - Every module DTO (via `fs.globSync('src/modules/*/*.schemas.ts')` + dynamic import of every `ZodType` export) is referenced by some operation.
  - Transport errors: a JSON body operation documents `BAD_REQUEST` and `PAYLOAD_TOO_LARGE`; path-param operations document `BAD_REQUEST`.
  - Search enum: the search operation's `collection` enum deep-equals `SEARCH_COLLECTIONS`, and `BAD_REQUEST` is documented for it.
  - `info.version` equals `package.json`'s `version` field via the `API_VERSION` constant.
- [x] 4.4 In the same test file, assert the real `buildOpenApiDocument(API_OPERATIONS)` output passes every structural invariant from Phase 3 (reusing `tests/helpers/openapi.ts`).

**Verify (PR 4):**
- `pnpm vitest run tests/unit/docs/operations.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- Coverage check on `src/docs/operations.ts` confirming ≥90/90/80/90.
- Fail-closed scratch check (not committed): temporarily comment out one operation entry and re-run the drift test, confirming it fails naming the undocumented route; then restore the entry and re-run green.

**Evidence to record:** pasted pass/fail output per drift guard category; the scratch fail-closed run's before/after output (recorded as task evidence, not committed, per design Decision 2's precedent); per-file coverage for `src/docs/operations.ts`.

---

**Phase 4 (S4) evidence — completed 2026-10-04**: commit b9cbc16 (2 new files, +555: src/docs/operations.ts 367-line catalog of the 21 live operations, tests/unit/docs/operations.test.ts). Drift guard derives the live inventory from the app/permission matrix (not a copied fixture) — fail-closed scratch-check logged: removing deleteProduct fails naming the route, restore byte-identical, 93/93 green. Version triangle test ties API_VERSION, info.version and package.json (all 3.0.0). D4 honored: search module untouched; SEARCH_COLLECTIONS imported only for the documenting enum; result cap 20 hardcoded with pointer comment to the private MAX_RESULTS (reviewer: acceptable trade-off under D4; silent-drift risk documented). Error lists per operation derived from matrix + real middleware/service behavior (writer judgment, reviewer spot-checked). Full suite 1442/1442; operations.ts 100% lines; typecheck/lint/format exit 0; no deps. Size 555 vs ~380 forecast (full per-operation error lists). TESTER PASS (wH:pG); REVIEWER APPROVE zero findings (wH:pC, fresh context after /clear). RDD: a325608..b9cbc16 medium/slice_budget_reached → owner DECLINED (candidate-scoped; boundary stays 1fc73bc; medium-tier verification satisfied by writer self-verification + TESTER + reviewer). Route: delegated (writer wH:p7).

## Phase 5: `/docs` serving, mount, matrix accommodation (Slice S5, ~380 lines)

> **Network read required.** Pinning the exact Redoc version and computing its `sha384` SRI hash (`curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`) requires one explicitly owner-authorized remote read at apply time, per design's Open Questions. **If that authorization is not granted at apply time**, skip 5.3/5.4's HTML+CDN work and ship the JSON-only fallback: `GET /docs/openapi.json` remains fully functional and tested; `GET /docs` HTML serving becomes a follow-up task, recorded explicitly in this phase's evidence as "network read declined — HTML page deferred."

- [x] 5.1 Request owner authorization for the one-time network read described above before starting 5.3. Record the explicit grant or decline as task evidence.
- [x] 5.2 Select the latest Redoc 2.x version published at least 24h before the task (exact `x.y.z`, no ranges, no `@latest`), per ADR-025's precedent for pinned external assets.
- [x] 5.3 (network read, requires 5.1 grant) Fetch `https://cdn.jsdelivr.net/npm/redoc@<version>/bundles/redoc.standalone.js` and compute its `sha384` integrity hash.
- [x] 5.4 Create `src/docs/page.ts`: `UI_BUNDLE = { version, integrity }` (from 5.2/5.3, or a placeholder pin with a tracked follow-up if 5.1 was declined), `UI_BUNDLE_URL` derived from it, `DOCS_CSP_DIRECTIVES` (`'script-src': [UI_BUNDLE_URL]`, `'worker-src': ['blob:']`, `'upgrade-insecure-requests': null`), and `DOCS_PAGE_HTML` — no inline script or style, a visible fallback link to `/docs/openapi.json` first, a `<redoc spec-url="/docs/openapi.json">` element, and one `<script src=UI_BUNDLE_URL integrity=UI_BUNDLE.integrity crossorigin="anonymous">` tag.
- [x] 5.5 Create `src/docs/index.ts`: `docsModule({ buildDocument = () => buildOpenApiDocument(API_OPERATIONS) }: DocsModuleDeps = {})` returning a `Router` with `GET /` (docs-scoped CSP middleware, `Cache-Control: no-cache`, HTML response) and `GET /openapi.json` (`Cache-Control: no-cache`, the JSON built and stringified once at module-construction time, not per request).
- [x] 5.6 Edit `src/app.ts`: add `if (config.docs.enabled) app.use('/docs', docsModule());` after the `/api` mounts and before `notFound`.
- [x] 5.7 Edit `tests/helpers/permission-matrix.ts`: add `'/docs'` to `MOUNT_PREFIXES`; add rows `#26 GET /docs` and `#27 GET /docs/openapi.json`, each `cases: [{ caller: 'anonymous', status: 200 }]` representative of every caller (matching the `#22` row's shape).
- [x] 5.8 Edit `tests/integration/security/authorize-matrix.test.ts`: add `fire()` cases for `#26` and `#27`; extend the TEST-05 fixed permutations from 6 to 7 indices (`:212-219`, `:228`); pass `DOCS_ENABLED: 'true'` explicitly to `buildIntrospectableApp()` and to the cell suite's `startTestApp()` so an ambient shell value cannot change the router count.
- [x] 5.9 Create `tests/unit/docs/page.test.ts`: assert `UI_BUNDLE.version` matches `^\d+\.\d+\.\d+$`; assert `UI_BUNDLE.integrity` matches `^sha384-[A-Za-z0-9+/]{64}$`; assert the HTML has exactly one `<script src=UI_BUNDLE_URL integrity crossorigin="anonymous">` tag, no inline `<script>` body, and the fallback link; assert `DOCS_CSP_DIRECTIVES['script-src']` equals `[UI_BUNDLE_URL]`. Add an opt-in test (gated on `VERIFY_SRI=1`, skipped by default) that fetches the bundle and checks the hash — this is a remote read and needs user authorization when actually run.
- [x] 5.10 Create `tests/integration/docs/docs.test.ts`: enabled case — both endpoints return 200 with correct content types; the JSON body deep-equals `buildOpenApiDocument(API_OPERATIONS)`; a repeated request returns the same ETag; `If-None-Match` returns 304. CSP — `/docs` carries the exact docs CSP string from design (`default-src 'self';...;script-src <UI_BUNDLE_URL>;...;worker-src blob:`); `/docs/openapi.json` and `/api/category` carry the unchanged global CSP without `cdn.jsdelivr.net`. Build-once — inject a counting `buildDocument` fake via `docsModule({ buildDocument })` on a bare `express()` (TEST-02 pattern) and assert exactly 1 call across 2 requests. Flag matrix — all 9 `NODE_ENV × DOCS_ENABLED` cells mount the routes or return the 404 envelope as documented; an invalid `DOCS_ENABLED` value makes `startTestApp` reject with `ConfigError`.
- [x] 5.11 Fail-closed scratch check (not committed): temporarily remove matrix rows #26/#27, re-run `authorize-matrix.test.ts`, confirm it fails with "match no known prefix" (or equivalent), then restore the rows and re-run green.
- [ ] 5.12 Manual check (recorded as task evidence, not a committed test): open `/docs` in a browser with `DOCS_ENABLED=true`, confirm zero CSP violations in the console and that Redoc renders all 21 operations; adjust `DOCS_CSP_DIRECTIVES` only if a violation is observed.

**Verify (PR 5):**
- `pnpm vitest run tests/unit/docs/page.test.ts tests/integration/docs/docs.test.ts tests/integration/security/authorize-matrix.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` (full suite — confirms the matrix/permutation change doesn't regress other ADR-044 coverage)
- Coverage check on `src/docs/page.ts` and `src/docs/index.ts` confirming ≥90/90/80/90.

**Evidence to record:** the 5.1 authorization decision (granted/declined) and its consequence; pasted pass/fail output of each command; the 5.11 scratch fail-closed before/after output; the 5.12 manual browser-console observation.

---

**Phase 5 (S5) evidence — tasks 5.1-5.11 completed 2026-10-04; 5.12 PENDING OWNER browser check**: commit 532cb9b (8 files, +355/−9: src/docs/index.ts, src/docs/page.ts, src/app.ts mount, matrix fixture + authorize-matrix tests, server.test.ts S2 carry-over, docs/page tests). Redoc pinned: redoc@2.5.4 (npm latest, published 567h before the run — ADR-025 age gate satisfied), https://cdn.jsdelivr.net/npm/redoc@2.5.4/bundles/redoc.standalone.js, integrity sha384-w447zOpYfw/1Tv/5AK9NfHTlQIqE3RVR6KY62jCyy9zNDgO64cMwGGP1Fj0zJVf5, crossorigin; bundle 1,103,471 bytes sha256 dcaf7661...500b (one authorized network read). docsModule({ buildDocument }) builds once at creation (counting-fake DI test); ETag + 304; Cache-Control no-cache; docs-scoped CSP via standalone helmet.contentSecurityPolicy (exact design string asserted; /api/* global CSP unchanged); flag off = router absent = standard 404 (no existence leak); 3x3 NODE_ENV x DOCS_ENABLED matrix + DOCS_ENABLED=yes ConfigError + prod-boot forced-on serves /docs/openapi.json (S2 carry-over landed). Matrix rows #26/#27 anonymous 200, permutations 6→7, DOCS_ENABLED pinned 'true' in fixtures; fail-closed scratch-check logged (rows removed → pairRouters fail naming 1 unmatched router, 9 tests fail; restored byte-identical, 103/103). Full suite 1471 passed + 1 skipped (VERIFY_SRI opt-in); new files 100% lines; typecheck/lint/format exit 0; no npm deps. TESTER PASS (wH:pG, SRI hash verified); REVIEWER APPROVE zero findings (wH:pC). RDD: b9cbc16..532cb9b HIGH → owner DECLINED (candidate-scoped; boundary stays 1fc73bc; high-tier verification satisfied: writer self-verification + independent TESTER + independent reviewer). 5.12 (manual browser check: DOCS_ENABLED=true pnpm dev → http://localhost:1500/docs, no CSP console errors, 21 operations rendered) awaits the owner. Route: delegated (writer wH:p7).

## Phase 6: Developer documentation artifacts — README, `.env.example`, `ERROR_CODES.md` (Slice S6, ~330 lines)

- [x] 6.1 Rename `.example.env` to `.env.example` with `git mv` (preserves history); add a `DOCS_ENABLED=` entry with an explanatory comment; confirm all existing keys remain and no secret value is populated.
- [x] 6.2 Create root `README.md` following the Decision 7 outline: one-paragraph description; Quick path (Node 24, pnpm, MongoDB, install, `.env.example` copy, migrate/seed, `pnpm dev` + `/docs` link); Curl quick start (sign-up/log-in → authenticated call); API reference section linking `/docs`, `/docs/openapi.json`, `api.http`, `ERROR_CODES.md`, `API_PROGRESS.md`; Environment table covering every `envSchema` key (including `DOCS_ENABLED`'s 3-environment table); Scripts table covering every `package.json` script; Architecture section (5-line summary + links to `ARCHITECTURE.md`, `API_PROGRESS.md`, `ROADMAP.md`, `TECH_DEBT.md`, `CHANGELOG.md`, no reproduction of their content); Manual Google sign-in section (how to mint an `id_token` now that the demo page is gone); Tests section (`pnpm test`, mongodb-memory-server, coverage gates, no `vi.mock`).
- [x] 6.3 Create root `ERROR_CODES.md` following the Decision 7 shape: an envelope example (`{ "error": { "code", "message", "details"? } }`, ADR-021) first; then a table with all 9 codes in `app-error.ts` order (Code | HTTP | Meaning | Typical triggers | `details`); then a "How raw errors map (`toAppError`)" section (body-parser 413 → 413; other exposed 4xx/URIError → `BAD_REQUEST`; Mongo 11000 → 409; Mongoose `ValidationError`/`CastError` → 400; anything else → 500 with cause logged); then a `details` (422 only) section describing the `{ path, message }` array shape with an example.
- [x] 6.4 Create `tests/unit/docs/doc-drift.test.ts` (README/env-example/error-codes portion — the `api.http` portion is added in Phase 7): assert every `envSchema.shape` key appears as `` `KEY` `` in `README.md` and as `^KEY=` in `.env.example`; assert every `package.json` script appears as `` `pnpm <name>` `` in `README.md`; assert a copy of `.env.example` with secret placeholders filled passes `loadConfig()` without rejecting; assert `SECRET_KEY`, `CLOUDINARY_URL`, and `SEED_ADMIN_PASSWORD` are empty placeholders in `.env.example` (no real-looking credential pattern); assert `ERROR_CODES.md` has exactly one row `` ^\| `CODE` \| STATUS \| `` per `ErrorCode`; assert `README.md` links `ARCHITECTURE.md`, `API_PROGRESS.md`, and `ERROR_CODES.md`.

**Verify (PR 6):**
- `pnpm vitest run tests/unit/docs/doc-drift.test.ts`
- `cp .env.example .env` (with placeholders filled with valid-shaped local values), then `pnpm dev` — confirm `loadConfig()` does not reject due to a missing/malformed key.
- `pnpm lint` / markdown link check if configured.

**Evidence to record:** pasted pass/fail output; confirmation the filled `.env.example` boots cleanly; confirmation no secret-shaped value exists in the committed `.env.example`.

---

**Phase 6 (S6) evidence — completed 2026-10-04**: commit c872bf0 (4 files, +292: README.md, ERROR_CODES.md, tests/unit/docs/doc-drift.test.ts, .env.example rename+DOCS_ENABLED line — the env line appended by the owner, .env* writes are permission-restricted for the agents). README: 14 env keys + DOCS_ENABLED 3x3 table + 12 scripts + 5-bullet architecture summary linking ARCHITECTURE/API_PROGRESS/ROADMAP/TECH_DEBT/CHANGELOG; curl quick start executed live (sign-up, login, authenticated category create, GET /docs 200). ERROR_CODES.md: envelope + 9 codes in app-error.ts order + toAppError mapping + 422 details with real zod messages. Doc-drift tests 60/60: env keys both docs ↔ envSchema, scripts ↔ package.json, one row per code ↔ ERROR_CATALOG, secrets empty, example boots via loadConfig, required README links. Full suite 1531 passed + 1 skipped, exit 0; typecheck/lint/format clean. TESTER PASS (wH:pG). REVIEWER approved with one actionable note — applied as FIX: known-gap comment in doc-drift.test.ts (ERROR_CODES.md "How raw errors map" prose is not test-bound; spot-check on to-app-error.ts changes). RDD: 532cb9b..c872bf0 medium/under_budget — recorded, slice pending (boundary stays 1fc73bc). Route: delegated (writer wH:p7; env line owner; fix inline).

## Phase 7: `api.http` collection and ledger closures (Slice S7, ~340 lines)

- [x] 7.1 Create root `api.http`: file variables first (`@baseUrl = http://localhost:1500`, `@token`, `@categoryId`, `@productId`, `@userId`); exactly 21 requests separated by `###`, each with `# @name <operationId>` matching the catalog's `operationId`s, in runnable session order (sign up → log in → catalog CRUD → search → media → users (admin) → change password → deletes → Google → `logoutAll` last, since it revokes the token); every bearer-authenticated request sends `Authorization: Bearer {{token}}`; use only syntax shared by the VS Code REST Client and the JetBrains HTTP Client.
- [x] 7.2 Extend `tests/unit/docs/doc-drift.test.ts` with the `api.http` portion: assert the file's `@name` values equal the 21 `operationId`s (no missing, no extraneous); assert each request's method and path match its operation's template (treating `{{var}}` as a path segment); assert every bearer request sends `Authorization: Bearer {{token}}`.
- [x] 7.3 Edit `TECH_DEBT.md`: mark DOC-01 closed, referencing this change; mark CQ-07 closed, referencing this change and the removal decision.
- [x] 7.4 Edit `API_PROGRESS.md`: mark row 23 (former demo-page route) as removed, per the existing convention for other removed rows; add rows 26 (`GET /docs`) and 27 (`GET /docs/openapi.json`); update any totals/summary counts affected by these additions/removals.
- [x] 7.5 Edit `ROADMAP.md`: update the M8 entry with its completed outcome.
- [x] 7.6 Edit `CHANGELOG.md`'s `[Unreleased]` section: add an `Added` entry describing the generated OpenAPI document, `/docs` serving, and the developer documentation deliverables (README, `.env.example`, `ERROR_CODES.md`, `api.http`); add a `Removed` entry describing the demo-page removal as a non-API asset change; add a `Changed` entry for the simplified global security headers if not already covered by the `Removed` entry.
- [x] 7.7 Edit `ARCHITECTURE.md`: add ADR entries starting at ADR-045 recording the accepted decisions D1 through D6 (OpenAPI generation via native `z.toJSONSchema`; dependency-free CDN-pinned static docs UI; the `DOCS_ENABLED` flag shape; the search-route documentation approach; the error-catalogue root placement; the `public/` removal and header simplification); add rule 6 to §2.3 stating `src/docs/` reads module contracts (`*.schemas.ts` exports and named constants) and nothing else; add a §1.14 "State after M8" summary.

**Verify (PR 7 — also the Phase 8 close-out gate below):**
- `pnpm vitest run tests/unit/docs/doc-drift.test.ts`
- Full pipeline: `pnpm lint && pnpm typecheck && pnpm test`

**Evidence to record:** pasted pass/fail output of the full pipeline; confirmation TECH_DEBT DOC-01 and CQ-07 both show closed status with a reference to this change.

---

## Phase 8: Close-out and delivery verification (gate for PR 7, no new source files)

- [x] 8.1 Run the full pipeline green: `pnpm lint`, `pnpm typecheck`, `pnpm test` (with coverage) — all pass with no skipped/pending tests related to this change.
- [x] 8.2 Blast-radius guard — confirm `src/` changes are confined to exactly the designed file list (the File Changes table in `design.md`): run `git diff --stat next... -- src/` and check every touched path against that table; confirm no file under `src/modules/`, `src/core/`, or `src/middlewares/` appears in the diff (design's explicit "no changes under these directories" guarantee).
- [x] 8.3 Dependency guard — confirm `package.json` and the lockfile have an empty diff against `next` (ADR-025, zero new npm dependencies): `git diff next... -- package.json pnpm-lock.yaml` returns no output.
- [x] 8.4 Confirm `TECH_DEBT.md` shows both DOC-01 and CQ-07 closed, `API_PROGRESS.md` row 23 marked removed with rows 26/27 present, `ROADMAP.md`'s M8 row reflects its outcome, `CHANGELOG.md`'s `[Unreleased]` holds the Added/Removed/Changed entries, and `ARCHITECTURE.md` holds ADR-045 onward plus §2.3 rule 6 and §1.14.
- [x] 8.5 Confirm `API_VERSION` in `src/docs/openapi.ts` matches `package.json`'s `version` field (re-run the version-match test from Phase 4 as a final sanity check before requesting review on PR 7).
- [x] 8.6 Record final evidence summary across all 7 slices (which commands ran, pass/fail, any declined network read from Phase 5, any `size:exception` if a slice ended up over budget) before handing off to `sdd-apply`'s delivery step.

**Verify:** `pnpm lint && pnpm typecheck && pnpm test` (same full pipeline as 8.1, re-run as the final gate); `git diff --stat next...` reviewed against the design's File Changes table.

**Evidence to record:** final full-pipeline output; the blast-radius diff-stat output annotated against the allowed file list; the empty dependency-diff output.

**Phase 7 (S7) evidence — completed 2026-10-04**: commit e19719c (13 files, +1864/−11; first attempt lost to a machine-sleep interruption, restarted clean). api.http: the 21 operations per module with host/token variables, placeholder credentials only; doc-drift suite extended to 96 tests binding api.http coverage. TECH_DEBT: DOC-01 → fixed (M8/S2–S7, five commit hashes + the self-referential S7 ledgers commit), CQ-07 → fixed (M8/S1, bde2491); no other row. API_PROGRESS: demo-page row per convention + the two /docs routes. ROADMAP: M8 delivered 2026-10-04, release 3.1.0 pending. CHANGELOG [Unreleased]: M8 section with GET /-now-404 under Removed labeled 3.1.0 (spec-correct MINOR classification; Breaking heading deliberately not used — ADR-024). ARCHITECTURE: §1.14, §2.3 rule 6, ADR-045..ADR-050 mapped to owner decisions D1-D6. M8 openspec artifacts committed in the same slice (M7 precedent). Attribution grep clean. TESTER PASS; REVIEWER APPROVE zero findings (fresh-context). RDD: c872bf0..e19719c medium/slice_budget_reached → owner DECLINED (candidate-scoped; medium tier covered by writer+TESTER+reviewer). Route: delegated (writer wH:p7).

**Phase 8 (close-out gate) evidence — completed 2026-10-04**: full pipeline GREEN at e19719c (TESTER wH:pG): format:check, lint, typecheck, build all exit 0; test:coverage 69 files / 1567 passed + 1 skipped (VERIFY_SRI opt-in), 0 failed, global stmts ~98.9% / branches 98.87% / functions 99.07% / lines 99.32%, thresholds held; audit --prod 0 advisories. Blast-radius guard (orchestrator): git diff --name-only 802faee..HEAD entirely within the design file list (NONE outside); dependency guard: package.json + pnpm-lock.yaml diff empty (ADR-025); src/modules|core|middlewares churn: none. Outstanding owner item: task 5.12 manual browser check (non-blocking for the gate; required before publication).
