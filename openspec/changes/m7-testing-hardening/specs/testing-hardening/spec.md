# Testing-Hardening Specification

## Purpose

M7 testing hardening for change `m7-testing-hardening`: close the two pinned test
debts (TEST-04, TEST-05), polish factories and shared fakes, add an explicit
global coverage gate, retain the security-regression suite, scope CI
cancellation to PRs, verify per-service coverage with tests only, and close the
TECH_DEBT entries. This change alters no product behavior — every edit is
confined to tests, harness, config, CI, and docs. There is no product
capability to create or modify (`openspec/specs/` does not exist), so this
FULL spec — not a delta — is the verifiable contract for the change, mapped
one-to-one onto the proposal's success criteria.

## Requirements

### Requirement: Stable 413-Payload Transport (TEST-04)

The test harness MUST run the 413-payload tests without EPIPE/ECONNRESET
failures and MUST NOT retain reset-tolerance workarounds once stability is
proven. The three reset-tolerance workarounds SHALL be removed.

#### Scenario: 413 tests pass without tolerance hacks

- GIVEN the 413-payload test files with tolerance code removed
- WHEN the 413 files are looped (e.g. 60/60 runs) before and after the harness change
- THEN all runs pass with no EPIPE/ECONNRESET errors

#### Scenario: No cross-talk regression from transport change

- GIVEN the per-file server discipline (127.0.0.1, one server per test file) is retained
- WHEN the full integration suite runs with the TEST-04 harness change in place
- THEN no TEST-02-style cross-file interference appears

#### Scenario: Tolerance removal is complete

- GIVEN the TEST-04 fix is landed
- WHEN the three 413 test files are searched for reset-tolerance handling
- THEN no reset-tolerance code remains

### Requirement: Order-Independent Route Drift Check (TEST-05)

The router-to-matrix mount pairing in the authorization drift check MUST be
independent of `app.use()` registration order (e.g. probe-based prefix
resolution), and the drift check MUST remain fail-closed on added or removed
routes.

#### Scenario: Reordered mounts still pair correctly

- GIVEN the Express routers are mounted in a different order than the matrix lists them
- WHEN the drift check runs
- THEN every router pairs with its correct matrix rows and the check passes

#### Scenario: Added route fails closed

- GIVEN a scratch run with one matrix row added (route with no corresponding handler)
- WHEN the drift check runs
- THEN the check fails

#### Scenario: Removed route fails closed

- GIVEN a scratch run with one matrix row removed (handler with no corresponding row)
- WHEN the drift check runs
- THEN the check fails

#### Scenario: Matrix rows unchanged in intent

- GIVEN the TEST-05 pairing rework is landed
- WHEN the permission-matrix rows are compared before and after
- THEN the set of route-by-role expectations is unchanged

### Requirement: Role-Parameterized Factories and Shared Fakes

The test factories MUST provide a `createVentas` helper (or equivalent
role-parameterized helper) so no caller hand-rolls `role: 'VENTAS_ROLE'`, and
shared fakes (logout-all/password-change builders, Cloudinary-fake builders)
MUST be centralized in the helpers for reuse.

#### Scenario: VENTAS_ROLE users come from the factory

- GIVEN a test needs a user with `VENTAS_ROLE`
- WHEN it uses the role-parameterized factory helper
- THEN the created user carries `VENTAS_ROLE` with valid defaults and no hand-rolled role literal

#### Scenario: Hand-rolled VENTAS_ROLE callers migrated

- GIVEN the factory helper exists
- WHEN the test suite is searched for hand-rolled `role: 'VENTAS_ROLE'` literals
- THEN no hand-rolled occurrences remain outside the factory itself, exempting
  data-under-test sites (fixtures whose role literal is the value being asserted)
  and the DB-seed suites (`tests/integration/database/indexes.test.ts`,
  `tests/integration/database/migrations.test.ts`), which stay raw because the
  stored role value is the system under test (see task 1.4); the factory itself
  passes the role as an argument, so the `role: 'VENTAS_ROLE'` key shape at those
  exempt sites is expected and the grep check is read against this allowlist

#### Scenario: Shared fakes are reusable

- GIVEN a test needs logout-all/password-change or Cloudinary-fake behavior
- WHEN it imports the centralized fake builders
- THEN it gets consistent fake behavior without duplicating builder code

### Requirement: Global Coverage Gate with Retained Per-File Bar

The Vitest configuration MUST enforce an explicit global coverage gate of
≥80% AND retain the existing per-file thresholds (90 lines/functions/
statements, 80 branches) with the `src/server.ts` exclusion. The global gate
SHALL be a floor only and MUST NOT weaken the per-file bar. `pnpm
test:coverage` MUST stay green under both gates.

#### Scenario: Global gate enforced

- GIVEN the Vitest config declares the explicit global ≥80% gate
- WHEN `pnpm test:coverage` runs on a codebase below 80% global coverage
- THEN the run fails

#### Scenario: Per-file bar retained and binding

- GIVEN the config retains per-file thresholds of 90 lines/functions/statements and 80 branches
- WHEN `pnpm test:coverage` runs
- THEN any file below its per-file threshold fails the run even if global coverage is above 80%

#### Scenario: Server entry exclusion retained

- GIVEN the `src/server.ts` exclusion is retained
- WHEN `pnpm test:coverage` runs
- THEN `src/server.ts` is excluded from coverage accounting

### Requirement: Security-Regression Retention

The full security-regression suite under `tests/integration/security/` (auth,
users, uploads, rate-limit, secrets, normalization, reliability, harness,
authz-adversarial) MUST pass green with no changes to its tested intent.

#### Scenario: Security suite green

- GIVEN no intent changes to the security suite
- WHEN the full `tests/integration/security/*` suite runs
- THEN all suites pass

#### Scenario: No intent drift in security suites

- GIVEN the change is landed
- WHEN the security suite's asserted behaviors are compared before and after
- THEN every previously asserted allow/deny, limit, and normalization behavior is still asserted

### Requirement: CI Cancel-in-Progress PR Scoping

CI MUST scope `cancel-in-progress` to pull-request runs so that every
`master`/`main` commit runs to completion.

#### Scenario: PR supersede cancels older PR runs

- GIVEN two rapid pushes to the same pull request
- WHEN the second push starts CI
- THEN the older in-progress PR run is cancelled

#### Scenario: Default-branch commits always run to completion

- GIVEN two rapid commits to `master`/`main`
- WHEN the second commit starts CI
- THEN the first commit's run is NOT cancelled and runs to completion

### Requirement: Per-Service Coverage Verification (Tests-Only)

Each of the six services (auth, users, categories, products, search, media)
MUST hold ≥90% line coverage, and any branch gaps (ownership 403/404 fork,
self-lockout resend-same-value accept, media allowlist miss) SHALL be filled
with tests only. No `src/` product behavior change is permitted.

#### Scenario: Every service meets the line bar

- GIVEN the coverage report for the six service files
- WHEN line coverage per service file is read
- THEN each service file shows ≥90% lines

#### Scenario: Branch gaps covered by tests

- GIVEN the known branch gaps (ownership 403/404 fork, self-lockout resend-same-value accept, media allowlist miss)
- WHEN the service unit tests run
- THEN each gap fork is exercised by at least one test

#### Scenario: No product behavior change from gap fills

- GIVEN the branch-gap fills are landed
- WHEN `src/` is diffed before and after
- THEN no `src/` file is modified

### Requirement: Milestone Close

TECH_DEBT.md MUST mark TEST-04 and TEST-05 closed on completion, and the full
pipeline (full suite of 1263+ tests, lint, typecheck, build, `pnpm audit
--prod`) MUST be green.

#### Scenario: Debt entries closed

- GIVEN all in-scope items are landed and verified
- WHEN TECH_DEBT.md is read
- THEN TEST-04 and TEST-05 are marked closed

#### Scenario: Full pipeline green

- GIVEN the change is complete
- WHEN the full test suite, lint, typecheck, build, and `pnpm audit --prod` run
- THEN all of them pass

### Requirement: Change Blast-Radius Guard

The change MUST NOT modify product behavior, MUST NOT introduce new
dependencies, MUST NOT use `vi.mock`, and MUST keep M9 items (OPS-04/05,
SEC-17/18) and M10 items (CodeQL, dependency review, Renovate, image push,
coverage artifact upload) out of scope.

#### Scenario: Tests, harness, config, CI, docs only

- GIVEN the change is landed
- WHEN the diff is listed by path
- THEN every changed file is under `tests/`, `vitest.config.mts`, `.github/workflows/ci.yml`, `TECH_DEBT.md`, `openspec/`, or a docs path — no `src/` product file is touched

#### Scenario: No new dependencies and no vi.mock

- GIVEN the change is landed
- WHEN `package.json` dependencies and the test suite are inspected
- THEN no new dependency is added and no `vi.mock` call exists
