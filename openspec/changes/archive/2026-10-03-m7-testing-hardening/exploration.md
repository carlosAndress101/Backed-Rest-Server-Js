## Exploration: M7 Testing Hardening (m7-testing-hardening)

### Current State
The 3.0 line on `next` (post-M6, commit `a0ea927`) carries 1263 tests in ~60 files with ~99% `src/**` coverage: Vitest 5 + supertest + mongodb-memory-server. All six services (`auth`, `users`, `categories`, `products`, `search`, `media`) already have unit tests with injected fakes (no `vi.mock`, ADR-023, lint-enforced). Route x role coverage exists via `tests/helpers/permission-matrix.ts` (single source, ~22 rows) plus `authorize-matrix.test.ts` (drift check + one HTTP request per cell) and the `authz-adversarial` suite. Data factories exist (`tests/helpers/factories.ts`: `createUser`/`createAdmin`/`createCategory`/`createProduct`/`tokenFor`/`authHeader`). Coverage thresholds exist in `vitest.config.mts` (per-`src/**/*.ts`: 90 lines/functions/statements, 80 branches; `src/server.ts` excluded) and CI runs `pnpm test:coverage` (fail-closed on thresholds) plus lint, typecheck, build, `pnpm audit --prod`. Test isolation today: one shared `mongod` from `tests/setup/global-setup.ts`, one database per test file (`mongoUri + test-<uuid>` in `tests/helpers/app.ts`), forks pool with `isolate: true`. The harness forces `Connection: close` per request (TEST-02 fix). No `openspec/` directory exists yet in this workspace.

### Affected Areas
- `vitest.config.mts` — per-file thresholds exist; M7 asks for an explicit global >=80% gate (decide: add global thresholds vs keep per-file, which is stricter).
- `.github/workflows/ci.yml` — runs `test:coverage` but has `cancel-in-progress: true` on all refs (M10 carryover: scope to PRs so every `master` commit finishes); no coverage artifact upload / CodeQL yet (M10).
- `tests/setup/global-setup.ts` — single shared `mongod`; M7 risk item wants isolated in-memory DB per worker (today: shared binary + per-file DB name, not per-worker `mongod`).
- `tests/helpers/app.ts` — `Connection: close` causes TEST-04 EPIPE/ECONNRESET on 413 tests; three 413 tests tolerate resets today.
- `tests/helpers/factories.ts` — no `createVentas` / role-parameterized helper; callers hand-roll `role: 'VENTAS_ROLE'`; no logout-all/password-change or Cloudinary-fake builders centralized.
- `tests/helpers/permission-matrix.ts` + `tests/integration/security/authorize-matrix.test.ts` — TEST-05: drift check pairs routers by `app.use()` order (Express 5 exposes no mount path); reorder could mispair.
- `tests/integration/security/*` (auth, users, uploads, rate-limit, secrets, normalization, reliability, harness) — the regression suite to retain and reaffirm.
- `src/modules/*/ *.service.ts` (6 services) — already unit-tested; M7 verifies >=90% lines per service and fills any branch gaps (e.g. ownership 403/404 fork, self-lockout resend-same-value accept, media allowlist miss).
- `TECH_DEBT.md` (TEST-04, TEST-05 open for M7; CQ-06, CQ-07, SEC-17/18, OPS-04/05 deferred to M8/M9) — scope boundary.

### Approaches
1. **Incremental hardening (close the two TEST items + gates)** — Keep the current harness; fix TEST-04 (stop forcing `Connection: close` for 413s / keep tolerance), fix TEST-05 (order-independent mount pairing, e.g. probe-based prefix resolution), add `createVentas`/role-param factory + central fakes, add an explicit global coverage gate (>=80%) alongside per-file thresholds, retain + document the security regression suite, fix CI `cancel-in-progress` scoping as a drive-by.
   - Pros: Smallest blast radius; builds on the 1263-test base; each item is independently verifiable; no new dependencies (ADR-025 friendly).
   - Cons: Leaves shared-`mongod` architecture in place (per-file DB, not per-worker `mongod`); does not fundamentally change flake surface.
   - Effort: Medium

2. **Harness rebuild (per-worker isolated mongod)** — Give each Vitest worker its own `MongoMemoryServer` (or replica-set) instance, remove the global-setup shared binary, revisit `Connection: close` vs keep-alive globally, parallelize with `--poolOptions.forks` tuning.
   - Pros: Strongest flake isolation; matches the ROADMAP risk-mitigation wording literally ("isolated in-memory DB per worker").
   - Cons: Higher memory/CPU per run, slower CI cold start (binary download/cache per worker), touches every integration file's lifecycle; risk of new flakes during migration; overkill given per-file UUID DBs already isolate data.
   - Effort: High

3. **Declare-nearly-done (gates + docs only)** — Assert M7 deliverables are substantially met; only add the global >=80% CI gate, a factories polish, and a test-inventory doc; defer TEST-04/TEST-05 to test-maintenance.
   - Pros: Fastest; acknowledges ~99% coverage and full matrix reality.
   - Cons: Leaves the two known M7-scoped test debts open; does not address the `Connection: close` flake or drift-check fragility; weak "confidence on every merge" story.
   - Effort: Low

### Recommendation
Approach 1 (incremental hardening). The codebase already satisfies the spirit of four of five M7 deliverables; what is missing is small and well-pinned: TEST-04, TEST-05, a `VENTAS_ROLE` factory gap, and an explicit global coverage gate. Per-file 90% thresholds already exceed the asked global 80%, so the gate change is a one-line-plus-docs affordance, not a coverage campaign. Approach 2 buys little (data isolation already holds via per-file DB names) at high cost. Scope discipline: keep M10 items (CodeQL, dependency review, Renovate, image push) and M9 items (OPS-04/05, SEC-17/18) out; note the CI `cancel-in-progress` scoping carryover (M10 T2.7 Q1) as either a drive-by or an explicit out-of-scope.

### Risks
- Flaky DB tests: shared `mongod` + parallel forks; per-file UUID DBs mitigate data collision but not binary-level contention or port/socket resets (TEST-04 EPIPE).
- 413-test resets: removing `Connection: close` may re-expose TEST-02-style cross-talk; change must keep the 127.0.0.1 + per-file server discipline and run the 413 files in a loop (e.g. 60/60) before/after.
- Drift-check fragility (TEST-05): any pairing change must keep failing closed on added/removed routes; per-cell HTTP tests are the backstop.
- Limiter budgets in matrix tests: `POST /api/auth/login` cells share per-IP/per-account budgets (10/15 min); new cells must reuse the existing avoidance pattern or they will poison each other.
- Coverage gaming: adding a global gate on top of per-file thresholds must not weaken the per-file bar; keep both, add global as a floor.

### Ready for Proposal
Yes — propose M7 as incremental hardening: (a) TEST-04 fix, (b) TEST-05 order-independent drift check, (c) factory polish (`createVentas`/role param + shared fakes), (d) explicit global >=80% coverage gate with per-file 90% retained, (e) security-regression retention checklist, (f) CI `cancel-in-progress` PR-scoping decision. Tell the user M7 is a short, bounded milestone on top of the 1263-test base, not a re-test campaign, with M9/M10 residuals explicitly out of scope.
