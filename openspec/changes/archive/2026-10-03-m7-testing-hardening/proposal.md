# Proposal: M7 Testing Hardening

## Intent

ROADMAP M7 goal is "confidence to ship on every merge". The `next` branch (post-M6) already carries 1263 tests in ~60 files at ~99% `src/**` coverage, six unit-tested services with injected fakes, and a route×role permission matrix. Two known test debts remain open for M7 (TECH_DEBT.md TEST-04, TEST-05), the explicit global ≥80% coverage gate is missing, factories have a `VENTAS_ROLE` gap, and CI `cancel-in-progress` is over-scoped. This change closes those pinned gaps with the smallest possible blast radius — no product behavior changes, no harness rebuild, no new dependencies.

## Scope

### In Scope
- TEST-04 fix: stop forcing `Connection: close` for 413-payload tests (or equivalent EPIPE/ECONNRESET elimination) in `tests/helpers/app.ts`; remove the three reset-tolerance workarounds once stable
- TEST-05 fix: order-independent router↔matrix mount pairing in `tests/integration/security/authorize-matrix.test.ts` (e.g. probe-based prefix resolution); drift check stays fail-closed on added/removed routes
- Factory polish: `createVentas` / role-parameterized helper in `tests/helpers/factories.ts` plus centralized shared fakes (logout-all/password-change, Cloudinary-fake builders)
- Explicit global ≥80% coverage gate in `vitest.config.mts` alongside retained per-file thresholds (90 lines/functions/statements, 80 branches); `src/server.ts` exclusion retained
- Security-regression retention checklist: reaffirm `tests/integration/security/*` suite (auth, users, uploads, rate-limit, secrets, normalization, reliability, harness, authz-adversarial) passes unmodified in intent
- CI `cancel-in-progress` PR-scoping decision: scope cancellation to PRs so every `master`/`main` commit runs to completion (M10 T2.7 Q1 carryover, taken as drive-by)
- Service coverage verification: confirm ≥90% lines per service across the 6 services and fill branch gaps (ownership 403/404 fork, self-lockout resend-same-value accept, media allowlist miss) with tests only
- TECH_DEBT.md: close TEST-04/TEST-05 entries on completion

### Out of Scope
- Per-worker isolated `mongod` harness rebuild (Approach 2 rejected: per-file UUID DBs already isolate data; cost exceeds benefit)
- M9 items: OPS-04/05, SEC-17/18
- M10 items: CodeQL, dependency review, Renovate, image push, coverage artifact upload
- Any `src/` product behavior change — all edits are tests, harness, config, CI, docs
- CQ-06, CQ-07 (deferred per TECH_DEBT.md)

## Capabilities

> Contract between proposal and specs phases. Researched `openspec/specs/` — no spec directory exists yet in this workspace, and this change alters no product behavior (tests, harness, config, CI, and docs only). There is therefore no product capability to create or modify.

### New Capabilities
- None — test-harness hardening introduces no user-facing capability.

### Modified Capabilities
- None — no existing product REQUIREMENTS change; service branch-gap fills are tests-only with identical `src/` behavior.

## Approach

Incremental hardening (exploration Approach 1, honored without re-litigation). Keep the current harness architecture (shared `mongod` from `tests/setup/global-setup.ts`, per-file UUID databases, forks pool with `isolate: true`, 127.0.0.1 + per-file server discipline). Each of the six in-scope items is independently verifiable and lands in dependency order:

1. TEST-04 first (harness transport change is the flakiest surface — loop the 413 files, e.g. 60/60, before/after).
2. TEST-05 second (drift-check pairing change, verified by intentionally adding/removing a matrix row in a scratch run to confirm fail-closed).
3. Factory polish + shared fakes (pure additive helpers; migrate hand-rolled `role: 'VENTAS_ROLE'` callers).
4. Global coverage gate (one-line-plus-docs affordance on top of the stricter per-file bar — never a replacement).
5. Security-regression retention pass + CI scoping + TECH_DEBT.md close.

No new dependencies (ADR-025 friendly). No `vi.mock` (ADR-023, lint-enforced).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `tests/helpers/app.ts` | Modified | TEST-04: conditional `Connection: close` handling for 413 tests; remove reset tolerance |
| `tests/integration/security/authorize-matrix.test.ts` | Modified | TEST-05: order-independent mount pairing; fail-closed drift check retained |
| `tests/helpers/permission-matrix.ts` | Modified | Support order-independent pairing if probe metadata needed; rows unchanged in intent |
| `tests/helpers/factories.ts` | Modified | Add `createVentas`/role-param helper; centralize logout-all/password-change + Cloudinary-fake builders |
| `vitest.config.mts` | Modified | Add explicit global ≥80% gate; retain per-file 90/80 thresholds and `src/server.ts` exclusion |
| `.github/workflows/ci.yml` | Modified | Scope `cancel-in-progress` to PRs only |
| `tests/integration/security/*` | Verified (no intent change) | Retention checklist: auth, users, uploads, rate-limit, secrets, normalization, reliability, harness, authz-adversarial |
| `src/modules/*/*.service.ts` (6 services) | Verified (tests-only) | Confirm ≥90% lines per service; fill branch gaps with tests, no behavior change |
| `TECH_DEBT.md` | Modified | Close TEST-04/TEST-05 entries |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Removing `Connection: close` re-exposes TEST-02-style cross-talk | Med | Keep 127.0.0.1 + per-file server discipline; loop 413 files (60/60) before/after; revert to tolerance if cross-talk returns |
| TEST-05 rework silently stops detecting route drift | Low | Scratch-verify fail-closed (add/remove a matrix row, confirm red); per-cell HTTP tests remain as backstop |
| Limiter budgets poison new matrix cells (`POST /api/auth/login` 10/15-min budgets) | Med | Reuse existing avoidance pattern for any new cells; no new login cells expected |
| Global gate weakens per-file bar (coverage gaming) | Low | Keep both: per-file 90% retained as the binding bar, global ≥80% added as floor only |
| Shared-`mongod` contention flakes persist | Med | Accepted residual (Approach 2 rejected); per-file UUID DBs contain data collision; no per-worker `mongod` in this change |

## Rollback Plan

Each item is independently revertible via `git revert` of its commit (land as one commit per item: TEST-04, TEST-05, factories, coverage gate, CI scoping, TECH_DEBT.md close):
- TEST-04 revert: restore `Connection: close` forcing + reset tolerance in the three 413 tests.
- TEST-05 revert: restore order-based pairing; matrix rows are unchanged so old check passes as before.
- Coverage gate revert: delete the global threshold block; per-file thresholds continue to gate CI.
- CI scoping revert: restore `cancel-in-progress: true` on all refs.
- No `src/` behavior changes exist to roll back; no migration or data cleanup is involved.

## Dependencies

- None (no new dependencies per ADR-025; uses existing Vitest 5 + supertest + mongodb-memory-server stack)
- Prerequisite: exploration `sdd/m7-testing-hardening/explore` (done, Engram id 5)

## Success Criteria

- [ ] 413-payload tests pass without EPIPE/ECONNRESET tolerance hacks (tolerance code removed, 60/60 loop green)
- [ ] Drift check pairs routers independent of `app.use()` order and still fails closed on added/removed routes (scratch-verified)
- [ ] `createVentas`/role-param factory exists; hand-rolled `role: 'VENTAS_ROLE'` callers migrated; shared fakes centralized
- [ ] `pnpm test:coverage` enforces explicit global ≥80% gate with per-file 90/80 thresholds retained and green
- [ ] Full security-regression suite (`tests/integration/security/*`) green with no intent changes
- [ ] CI `cancel-in-progress` scoped to PRs; `master`/`main` commits always run to completion
- [ ] TECH_DEBT.md TEST-04/TEST-05 closed; full suite (1263+ tests) green with lint, typecheck, build, and `pnpm audit --prod`
