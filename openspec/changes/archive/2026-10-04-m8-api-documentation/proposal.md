# Proposal: M8 API Documentation

## Intent

ROADMAP M8's goal is "a self-serve API for consumers and future agents". After 3.0.0 (M3–M7), the API contract is stable: 21 live operations, one error envelope (ADR-021), zod DTOs on every validated route (ADR-029). It is still undocumented for consumers. TECH_DEBT DOC-01 is open ("No README, no OpenAPI spec, no setup guide, no error catalogue"). There is no root `README.md` and no `.env.example`. The only consumer-facing artifact is the `public/` demo page, and CQ-07 records that it points at a dead deployment URL with a hardcoded client id.

This is the right time because the contract M3–M6 batched into 3.0.0 is frozen, and M9 (production readiness) needs a documented surface and a production config story to build on. This change documents that contract from code, closes DOC-01, and takes the CQ-07 decision. Runtime behavior changes only by adding the `/docs` mount and its config flag, plus the CQ-07 outcome the owner approves.

## Scope

### In Scope
1. **OpenAPI 3.1 document generated from the zod DTOs.** Request params, query, and body schemas come from each module's exported zod schemas. Shared components cover the data, page, and error envelopes plus the `ValidationIssue` shape. A Bearer security scheme is included.
2. **`/docs` serving.** `GET /docs/openapi.json` returns the document, and `GET /docs` returns a human-readable view (UI choice: D3). The mount is gated by a new `DOCS_ENABLED` setting, disabled in production unless explicitly flagged (D5), with a CSP that applies only to `/docs`.
3. **Drift guards.** A test fails when the documented operation set differs from the live route set (fail-closed, in the spirit of ADR-044). A compile-time exhaustive error-code table is included. Tests assert that every DTO converts without error.
4. **Root `README.md`.** It covers setup (Node 24, pnpm, MongoDB), environment (every `envSchema` variable), scripts (every `package.json` script), and a short architecture summary that links to `ARCHITECTURE.md`, `API_PROGRESS.md`, and the error catalogue rather than copying them. A committed `.env.example` with placeholder values is included.
5. **`.http` example collection.** It has one request per live API operation (21) and is runnable against `pnpm dev` with base-URL and token variables. The README adds a curl quick start for the sign-in → authenticated call flow.
6. **Error-code catalogue.** It lists all 9 `ErrorCode`s (`src/core/errors/app-error.ts`): HTTP status, meaning, typical triggers (including the `toAppError` mappings: 413, duplicate key → 409, cast/validation → 400, fallback 500), and `details` semantics for 422. Placement is D6.
7. **CQ-07 resolution** for `public/`, per the owner decision (D1).
8. **Search route parameters documented**, per the owner decision (D4).
9. **Ledger closure.** TECH_DEBT DOC-01 and CQ-07 are closed. The API_PROGRESS row 23 status is updated, along with the ROADMAP M8 outcome line and CHANGELOG `[Unreleased]` entries. ARCHITECTURE ADR rows (ADR-045 onward) record the accepted decisions.

### Out of Scope
- Deployment, Docker, `/health`/`/ready`, production config checklist (M9).
- CI additions: OpenAPI lint/validation jobs, publishing the spec, Renovate, CodeQL (M10).
- Precise response-body modelling for every resource. Responses are serialized Mongoose documents with no zod source. This change documents envelopes and coarse resource objects only (see Risks).
- Binding zod validation to the search route. It would turn today's 400 `BAD_REQUEST` into 422 and change the auth-before-allowlist order: a breaking change and 4.0.0 material.
- A committed static `openapi.json` snapshot or a CLI export command (possible follow-up for consumers of a production deployment where `/docs` is off).
- Any other `src/` behavior change, including refactoring routes to share a schema registry with `validate()`.
- SEC-16/17/18, CQ-06, and other open TECH_DEBT items.

## Capabilities

> Contract between proposal and specs phases. Researched `openspec/specs/`: only `testing-hardening` exists. Its "Change Blast-Radius Guard" requirement is scoped to the M7 change (its Purpose names `m7-testing-hardening`), and its route drift-check requirements stay unchanged in intent: M8 adds matrix rows, it does not change the rule. So no existing capability's requirements change.

### New Capabilities
- `openapi-docs`: the generated OpenAPI 3.1 document (source rules, components, operation coverage), the `/docs` and `/docs/openapi.json` endpoints, `DOCS_ENABLED` semantics across `NODE_ENV`, docs-scoped CSP, and the drift guards.
- `developer-documentation`: root README content contract, `.env.example`, error-code catalogue, `.http` collection, and DOC-01 ledger closure.
- `demo-page`: the CQ-07 outcome (removal, or retention as a fixed local dev tool) and its consequences for the static mount and global security headers.

### Modified Capabilities
- None.

## Approach

**Recommended direction.** Every recommendation below is still subject to the owner decisions D1–D6.

1. **Generation (D2, recommended: native).** A new `src/core/openapi/` module, pure and I/O-free, builds the document with zod 4.6.5's built-in `z.toJSONSchema`. It targets JSON Schema draft 2020-12, the OpenAPI 3.1 dialect. It uses `io: 'input'` so request schemas with `.transform` (email lowercasing in auth and users), `.default`, and `z.coerce` (pagination) describe what a client sends. Output mode would throw on transforms. A thin, hand-written operation catalog lists the 21 operations (method, path, auth, tags, status codes) and references each module's exported schemas. Request schemas are never retyped.
2. **Error contract.** An error-code table in the openapi module is typed `satisfies Record<ErrorCode, …>`, so the compiler enforces exactly the 9 codes. It feeds the `ErrorEnvelope` component's `code` enum and the catalogue. A small test asserts that the catalogue document lists every code. `app-error.ts` is untouched.
3. **Drift guard.** A test compares the documented (method, path) set with the live route set using the existing permission-matrix fixture (ADR-044 single source) and fails closed on any difference. A unit test converts every exported DTO.
4. **Config (D5).** A new optional `DOCS_ENABLED` entry in `envSchema` with strict `'true' | 'false'` parsing is resolved in `loadConfig` to `config.docs.enabled`. `z.coerce.boolean()` is deliberately avoided because it reads the string `'false'` as `true`. `createApp` mounts `/docs` only when enabled. When disabled, the routes do not exist and fall through to the standard 404 `NOT_FOUND` envelope.
5. **Serving and CSP (D3).** The document is built once in `createApp` when enabled, with no per-request work. A CSP is applied to `/docs` responses only. The global `HELMET_OPTIONS` are not widened for docs.
6. **Docs artifacts.** README, `.env.example`, catalogue, and `.http` collection follow the repo's root-ledger convention, lead with the quick path, and link to existing documents instead of duplicating them. Cheap doc-drift tests assert that every `envSchema` key appears in README and `.env.example`, and every `package.json` script appears in README. The design phase confirms these.
7. **TDD/coverage.** Every new `src/**` file meets the per-file 90/90/80/90 bar. No `vi.mock` (ADR-023): tests use real zod schemas, plain function calls, and `startTestApp` overrides for flag variants.

**Release mapping (assumption, confirmed at release).** The change is additive (a new route behind a flag and a new optional env var), so it is MINOR (3.1.0) under ADR-024/SemVer. If D1 removes the demo page, this is recorded under CHANGELOG `Removed` as a non-API asset.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/core/openapi/` | New | Document assembly, operation catalog, shared components, error-code table |
| `src/config/env.ts`, `src/config/index.ts` | Modified | `DOCS_ENABLED` entry; `Config.docs.enabled` resolution |
| `src/app.ts` | Modified | Conditional `/docs` mount with docs-scoped CSP; D1 may remove `express.static(PUBLIC_DIR)` and the GIS-only `HELMET_OPTIONS` entries |
| `src/server.ts` | Modified (optional) | Boot log when docs are enabled in production, next to the existing CORS warning (ADR-022 precedent) |
| `src/modules/search/` | Unchanged or New file | D4: either untouched (recommended) or a docs-only `search.schemas.ts` |
| `public/` | Removed or Modified | D1 outcome |
| `tests/helpers/permission-matrix.ts` | Modified | Rows for the public `/docs` routes; otherwise the ADR-044 drift check fails closed as designed |
| `tests/integration/platform/app.test.ts` | Modified (D1-dependent) | Demo-page and GIS CSP/COOP header assertions |
| `tests/unit/`, `tests/integration/` | New | OpenAPI generation, flag matrix, `/docs` endpoints, drift guards, doc-drift checks |
| `README.md`, `.env.example`, catalogue file, `.http` collection | New | Developer documentation deliverables |
| `TECH_DEBT.md`, `API_PROGRESS.md`, `ROADMAP.md`, `CHANGELOG.md`, `ARCHITECTURE.md` | Modified | DOC-01/CQ-07 closure, row 23, M8 outcome, Unreleased entries, ADR-045 onward |

## Owner Decisions (pending approval)

Each item is an **OWNER DECISION, pending approval**. The recommendations are not choices made on the owner's behalf. Only the work listed under "Blocks" waits for the decision. Everything else can proceed.

### D1 — CQ-07: the `public/` demo page
| Option | Summary | Tradeoffs |
|---|---|---|
| A. Keep and fix as a local dev tool | Remove the dead `hookcoffee.zeabur.app` URL (use relative `/api/auth/google`), stop hardcoding the client id, document it as a local aid | Keeps a browser flow for minting a Google `id_token`. The GIS CSP/COOP allowances stay on every production response. A non-hardcoded client id needs templating or a config endpoint, which is extra `src/` surface |
| B. Remove | Delete `public/`, drop `express.static`, drop the GIS-only `HELMET_OPTIONS` entries (gsi/fonts sources, `frameSrc`, COOP `same-origin-allow-popups`) | Smaller attack surface and simpler `app.ts`. Changes security headers on every response, which must be explicitly tested. Loses the browser sign-in aid. The README must explain how to get an `id_token` for manual tests. CORP `cross-origin` is kept unless the design proves it is page-only |

**Recommendation: B.** There is no deployment (owner, 2026-09-23). The page fails everywhere except localhost. It forces a wider global CSP and COOP in production for a demo. `/docs` plus the `.http` collection replace it as the developer tool.
**Blocks:** the CQ-07 slice and the related header test updates.

### D2 — OpenAPI generation
| Option | Summary | Tradeoffs |
|---|---|---|
| A. Native `z.toJSONSchema` (zod 4.6.5) | Zero dependency; hand-written assembly glue | ADR-025-neutral. The glue is about 300 authored lines and needs the 90/90/80/90 bar. Requires `io: 'input'` discipline |
| B. `@asteasolutions/zod-to-openapi` | Purpose-built OpenAPI builder | New dependency (ADR-025: 24 h age, cold frozen install proof). **zod v4 compatibility is unverified**: historically it targeted zod v3 internals, so a compatibility proof is needed before selection |
| C. Hand-written spec | No code | Reintroduces the spec drift ROADMAP M8 explicitly names as the risk to avoid |

**Recommendation: A.** It is generated from code with no supply-chain cost, and the building block is verified present in the installed zod (`target: 'draft-2020-12'` default, `io: 'input' | 'output'`).
**Blocks:** generator and catalog slices.

### D3 — Docs UI at `/docs`
| Option | Summary | Tradeoffs |
|---|---|---|
| A. npm-hosted UI assets served same-origin (Scalar, Swagger UI, or Redoc package) | No runtime external fetch; CSP can stay `'self'` | New dependency under ADR-025. Each candidate's dependency tree and install scripts must be audited (not verified in this proposal). Larger install |
| B. Dependency-free static page loading a pinned UI bundle from a CDN | No npm dependency | External runtime fetch (availability, supply chain). Mitigated by exact-version pinning plus Subresource Integrity, a CSP allowlist scoped to `/docs`, and production-off by default. Same pattern as the existing GIS page |
| C. No UI: `/docs` serves or redirects to the JSON document only | Zero dependency, zero CSP change | Consumers bring their own viewer. Less self-serve for humans; fine for agents |

**Recommendation: B, with C as the fallback** if the owner rejects any external fetch. B gives a human UI with no npm dependency, and its CSP blast radius stays limited to `/docs` on non-production environments by default.
**Blocks:** the `/docs` HTML part only. `GET /docs/openapi.json` is independent.

### D4 — The `search` route has no zod schema
| Option | Summary | Tradeoffs |
|---|---|---|
| A. Add a docs-only `search.schemas.ts` (`collection: z.enum(SEARCH_COLLECTIONS)`, `term`) | Consistent `*.schemas.ts` layout | An unbound schema looks enforced but is not, which can mislead. Binding it is out of scope because it changes 400 → 422 |
| B. Catalog-local parameter schema derived from the exported `SEARCH_COLLECTIONS` | No change in the search module; still zod-generated from the same constant the service checks | One documented exception in the catalog. The 400 (not 422) for an unknown collection must be stated in the operation |

**Recommendation: B.** The enum cannot drift from the service allowlist, nothing in `src/modules/` changes, and no misleading unbound schema is introduced.
**Blocks:** the search operation entry only.

### D5 — `DOCS_ENABLED` semantics
Recommended shape, following the `LOG_LEVEL` (enum) and `TRUST_PROXY` (strict parse, then transform) precedents:

| `DOCS_ENABLED` | `NODE_ENV=development` | `NODE_ENV=test` | `NODE_ENV=production` |
|---|---|---|---|
| unset or empty | enabled | enabled | **disabled** |
| `true` | enabled | enabled | enabled (boot log, ADR-022 precedent) |
| `false` | disabled | disabled | disabled |
| any other value | boot fails with `ConfigError` (fail-fast, ADR-019) | same | same |

When disabled, `/docs` and `/docs/openapi.json` are not mounted and answer the standard 404 `NOT_FOUND` envelope. There is no "disabled" response that reveals the endpoint exists. Alternative considered: ADR-022's "default enabled with a production warning". It is rejected because ROADMAP states "disabled in production unless flagged".
**Recommendation:** the table above. The name `DOCS_ENABLED` is also pending owner confirmation.
**Blocks:** flag slice and `/docs` mount.

### D6 — Error-code catalogue placement
| Option | Tradeoffs |
|---|---|
| A. Root `ERROR_CODES.md` linked from README | Matches the root-ledger convention (`API_PROGRESS.md`, `TECH_DEBT.md`); a stable link target for consumers and agents; keeps README short |
| B. A README section | One fewer file; makes README longer and mixes setup with contract reference |

**Recommendation: A.**
**Blocks:** the catalogue file location only. The content is independent.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Spec drift: a route added without a catalog entry | Med | Fail-closed set-equality test against the permission-matrix fixture; request schemas imported from module exports, never retyped |
| Response-body drift (responses have no zod source) | Med | Document shared envelopes plus coarse resource objects only; precise response modelling is out of scope; the design may add a sampled contract test |
| `z.toJSONSchema` throws on transforms in output mode | High if unaddressed | `io: 'input'`; a unit test converts every exported DTO |
| New dependency slips past the supply-chain gate | Low (recommended options add none) | If D2-B or D3-A is chosen: ADR-025 24 h age plus a cold frozen install proof, and a zod v4 compatibility proof for D2-B, before that task starts |
| CSP widening / external fetch | Med (D3-B) | `/docs`-scoped CSP; global `HELMET_OPTIONS` untouched; exact-version pin plus SRI; production-off by default |
| ADR-044 drift check fails once `/docs` is mounted in `test` | High (certain) | Expected fail-closed behavior: add `/docs` rows (public cells) to the permission matrix, or mount docs outside a Router (design decides) |
| Accidental production exposure | Low | Default off in production, strict flag parsing, boot log when enabled in production |
| D1-B changes headers on every response | Med | Explicit header assertions updated in the same slice; CORP kept unless proven page-only; CHANGELOG `Removed` entry |
| README duplicates ARCHITECTURE/API_PROGRESS and rots | Med | Link, do not copy; doc-drift tests for env keys and scripts |
| Document validity without a validator dependency | Low–Med | Structural invariant tests (all `$ref`s resolve, unique `operationId`s, every path parameter declared, `openapi: 3.1.x`); no validator dependency proposed (ADR-025) |
| Change exceeds the 400-line review budget | High | Chained PRs under the cached `auto-chain` strategy (forecast below) |

## Size Forecast (preliminary; `sdd-tasks` owns the binding forecast)

Estimated authored changed lines (additions plus deletions), assuming the recommended options:

| Work unit | Approx. lines |
|---|---|
| Config flag + OpenAPI core (components, error table) + unit tests | ~300 |
| Operation catalog (21 operations) + drift guards | ~350 |
| `/docs` mount, UI page, scoped CSP, integration tests, matrix rows | ~250 |
| CQ-07 (D1-B: mostly deletions of `public/` + header/test updates) | ~250 |
| README + `.env.example` + `ERROR_CODES.md` + doc-drift tests | ~350 |
| `.http` collection + ledgers (TECH_DEBT, API_PROGRESS, ROADMAP, CHANGELOG, ADR rows) | ~250 |
| **Total** | **~1,500–1,800** |

- Chained PRs recommended: Yes. There are six slices of 400 lines or fewer each, in the order above. Slices 4–6 depend only on decisions D1/D6 and can be reordered.
- 400-line budget risk: High.
- Decision needed before apply: Yes (D1–D6).

## Rollback Plan

- Each slice lands as its own work-unit commit or PR and reverts independently with `git revert`.
- **Runtime kill switch without a revert:** `DOCS_ENABLED=false` removes `/docs` in any environment. Production is already off by default.
- Reverting the generator/catalog/mount slices removes `src/core/openapi/`, the config entry, and the mount. No data, migration, or persisted state is involved.
- Reverting D1-B restores `public/`, the `express.static` mount, the original `HELMET_OPTIONS`, and the original header tests.
- Documentation and ledger slices are text-only reverts.

## Dependencies

- None new under the recommended options (ADR-025 standing gate applies to any dependency the owner selects via D2-B or D3-A).
- Prerequisite: exploration `sdd/m8-api-documentation/explore` (done).
- Owner decisions D1–D6 (pending), each blocking only its listed work.

## Success Criteria

- [ ] `GET /docs/openapi.json` (enabled) returns 200 JSON with `openapi` `3.1.x` and exactly the 21 live API operations; the set-equality test against the permission-matrix fixture fails when a route is added or removed without a catalog change.
- [ ] Every request params/query/body schema in the document comes from `z.toJSONSchema` over a module-exported zod schema (D4 exception derived from `SEARCH_COLLECTIONS`); converting every exported DTO succeeds in a unit test.
- [ ] The `ErrorEnvelope` component's `code` enum equals the 9 `ErrorCode`s, enforced at compile time; every operation declares its error responses via the shared component.
- [ ] Structural invariants hold: all `$ref`s resolve, `operationId`s are unique, every path parameter is declared, and the Bearer scheme applies to authenticated operations only.
- [ ] Flag semantics: all 9 cells (`NODE_ENV` × unset/`true`/`false`) are covered by tests; an invalid value fails boot with `ConfigError`; when disabled, `/docs` and `/docs/openapi.json` return 404 `NOT_FOUND` envelopes.
- [ ] The `/docs` CSP applies only to `/docs` responses; `/api/*` security headers are unchanged except as the approved D1 outcome specifies, with tests asserting both.
- [ ] Root `README.md` covers setup, environment (every `envSchema` key), scripts (every `package.json` script), and an architecture summary linking `ARCHITECTURE.md`, `API_PROGRESS.md`, and the catalogue; doc-drift tests pass; `.env.example` lists every key with placeholders and no secrets.
- [ ] The `.http` collection holds one request per live operation (21) and runs against `pnpm dev`; the README includes a curl quick start.
- [ ] The error catalogue lists all 9 codes with status, meaning, triggers, and `details` semantics; a test asserts every code is present.
- [ ] CQ-07 resolved per D1; TECH_DEBT DOC-01 and CQ-07 closed; API_PROGRESS row 23 updated; ROADMAP M8 outcome, CHANGELOG `[Unreleased]`, and ADR rows recorded.
- [ ] Every new `src/**` file meets 90/90/80/90; no `vi.mock`; full suite, lint, typecheck, build, and `pnpm audit --prod` are green; no `src/` behavior change outside the `/docs` mount, the config flag, and the approved D1 outcome.
