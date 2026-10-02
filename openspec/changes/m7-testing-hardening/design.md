# Design: M7 Testing Hardening

## Technical Approach

Incremental hardening of the test harness, config, CI, and docs — zero `src/` behavior change, no new
dependencies (ADR-025), no `vi.mock` (ADR-023, lint-enforced). This design maps one-to-one onto the
proposal's five-step landing order and the `testing-hardening` spec's eight requirements:

1. **TEST-04 first** — remove the forced `Connection: close` in `tests/helpers/app.ts` (`serve()`),
   loop the 413 files (60/60) before/after, then remove reset-tolerance sites.
2. **TEST-05 second** — replace index-order router↔prefix pairing in `authorize-matrix.test.ts` with a
   pure path-set bijection function; scratch-verify fail-closed (add/remove a row → red).
3. **Factory polish + shared fakes** — additive helpers only (`createVentas`, role-param creator, pure
   unit actor builders, centralized logout-all/password-change request builders); migrate callers.
4. **Global coverage gate** — add an explicit global ≥80% floor in `vitest.config.mts` alongside the
   retained, still-binding per-file 90/80 thresholds; liveness-check the gate.
5. **Retention + CI + close** — full security-regression suite green with no intent change, PR-scoped
   `cancel-in-progress`, per-service ≥90% line verification with tests-only branch-gap fills,
   TECH_DEBT.md close.

Each item lands as its own commit and is independently revertible (see Rollout).

## Architecture Decisions

### Decision: TEST-04 transport — remove forced `Connection: close` globally in the test harness

**Choice**: Delete the unconditional `res.setHeader('Connection', 'close')` in `serve()`
(`tests/helpers/app.ts:36-48`) so the per-file test servers use HTTP/1.1 keep-alive (Node default).
Keep the 127.0.0.1 + one-server-per-test-file discipline untouched.

**Alternatives considered**:
- *Conditional close (close for everything except early-413 responses)* — rejected as first attempt:
  more machinery (must inspect status before headers flush) for no proven benefit. Retained as the
  fallback if the global removal regresses.
- *Keep-alive agent tuning in supertest call sites* — rejected: scatters transport config across
  dozens of files instead of fixing the one harness choke point.
- *Leave `Connection: close` and keep tolerance* — rejected: leaves TEST-04 open, against the spec.

**Rationale**: The reset mechanism is transport-level, not product behavior: `fileParser`
(`src/modules/media/media.upload.ts`, read-only for this change) already answers oversize uploads with
a clean 413 JSON via `abortOnLimit` + `limitHandler → PayloadTooLargeError → errorHandler`. The RST
comes from the harness forcing `Connection: close` while ~5 MB of request bytes are still unread —
exactly the T3.7R finding (38/60 resets with a 2 MB tail under forced-close, 60/60 clean with
keep-alive). TEST-02's root cause (bare app bound to `::` answered by a foreign process) is unrelated
to the `Connection` header, so removing the header does not reopen TEST-02 while 127.0.0.1 +
per-file-server discipline stays. Supertest opens a fresh connection per request against the
ephemeral per-file port, so keep-alive introduces no cross-test socket reuse.

**Fallback**: if the post-change loops show cross-talk or resets, restore conditional close
(set `Connection: close` unless the response is an early 413) and re-loop; if still red, restore the
header + tolerance (proposal rollback) and record TEST-04 as residual.

### Decision: TEST-05 pairing — pure path-set bijection, no live traffic

**Choice**: Extract the pairing into a pure function in `authorize-matrix.test.ts`
(e.g. `pairRouters(routers, prefixes, fixturePairs)`): for each mounted router, compute its
`(METHOD, suffix)` set from `layer.handle.stack`; a prefix P is a candidate iff every
`METHOD + P + suffix` is in the fixture pair set; require an exact bijection (each of the 6
prefixes matched exactly once, every router matched, per-prefix sets equal). Any 0- or N-candidate
ambiguity throws with a diff. The existing sorted-set equality assertion
(fixture pairs vs live pairs) is already order-independent and stays as the backstop; the
router-count assertion stays.

**Alternatives considered**:
- *Probe requests (fire synthetic in-process requests per router to learn its prefix)* — rejected:
  needs request plumbing, limiter-budget awareness (`POST /api/auth/login` shares 10/15-min budgets),
  and DB state; far heavier than static set matching for identical assurance.
- *Keep index pairing + a comment* — rejected: leaves TEST-05 open, against the spec.
- *Read mount paths off Express layers* — impossible: Express 5 + path-to-regexp v8 exposes a matcher
  closure, not a path string (verified in the test file's own comment); must not be re-attempted.

**Rationale**: Prefixes are disjoint across the fixture (`/api/category`, `/api/product`,
`/api/search`, `/api/user`, `/api/auth`, `/api/uploads` — same universe as `MOUNT_PREFIXES`), so
suffix-set matching is deterministic and total. Pure function ⇒ unit-testable with shuffled router
arrays (reversed + sampled permutations), proving order-independence without touching `src/app.ts`
mount order (which the blast-radius guard forbids changing). `permission-matrix.ts` rows stay
byte-identical; only its stale "pairs by mount order" comment is updated.

### Decision: Factories — `createVentas` + role-param creator (DB seam) and pure actor builders (unit seam)

**Choice**:
- `tests/helpers/factories.ts`: add `createVentas(overrides)` mirroring `createAdmin`, plus
  `createUserWithRole(role, overrides)` as the general role-parameterized helper. `createVentas`
  delegates to it (single role-literal site).
- New tiny pure module `tests/helpers/actors.ts`: `userActor / salesActor / adminActor(id?)` and
  `actorWithRole(role, id?)` returning `{ id, role }` literals for service-unit tests (no DB, no
  mongoose import weight).
- Migrate DB-backed `createUser({ role: 'VENTAS_ROLE' })` call sites
  (`tests/integration/modules/users.test.ts`, `tests/integration/security/authz-adversarial.test.ts`
  ×4) and unit `Actor` literals (`tests/unit/modules/product.service.test.ts`,
  `tests/unit/modules/user.service.test.ts`) to the new helpers.

**Alternatives considered**:
- *`createVentas` only, leave unit literals* — rejected: the spec scenario requires no hand-rolled
  role literals remain outside the factory; unit literals would fail the grep check.
- *One generic helper, no `createVentas`* — rejected: `createAdmin` precedent shows named-role
  helpers read better at call sites; `createVentas` + delegating generic gives both.
- *Put pure builders in `factories.ts`* — rejected: pulls bcrypt/mongoose models into service-unit
  test processes; a dependency-free module keeps the unit seam fast and pure.

**Rationale**: Follows the existing `createAdmin` pattern (convention over invention). Two seams
because the two seams have different constraints (DB-backed integration vs pure unit). Out of scope
for migration: raw role strings in non-factory contexts that are the system under test itself —
`tests/integration/database/{indexes,migrations}.test.ts` seed raw role values to test the schema /
migration behavior (replacing them with the factory would test the factory, not the DB); documented,
not migrated.

### Decision: Shared fakes — centralize auth request builders; Cloudinary seam is verify-only

**Choice**: Extend `tests/helpers/auth.ts` with `logoutAll(appOrRequest, header)` and
`changePassword(...)` request builders (supertest-based, same shape as the local closures in
`tests/integration/modules/auth.test.ts:321,385`); migrate the matrix `fire()` `#24`/`#25` cases and
`auth.test.ts` closures to them. For Cloudinary: `stubMediaClient` in `tests/helpers/uploads.ts` is
already the single seam (verified: the only `CloudinaryClient` reference in `tests/`); no new builder
needed — just assert no direct `vi.spyOn(CloudinaryClient…)` exists elsewhere.

**Alternatives considered**:
- *Leave the closures local* — rejected: three copies of the same request shape is the duplication
  the proposal targets.
- *New `tests/helpers/auth-requests.ts` module* — rejected: `auth.ts` already owns the auth-test seam
  (Google stub); one module per seam.

**Rationale**: Smallest consolidation that satisfies "centralized … builders … for reuse" while
respecting ADR-023 (spy-on-injected-client, no `vi.mock`).

### Decision: Coverage gate — global 80% floor added, per-file 90/80 retained and binding

**Choice**: Add a global threshold block (`lines/functions/statements ≥ 80, branches ≥ 80`) to
`vitest.config.mts` next to the existing `'src/**/*.ts': { lines/functions/statements: 90,
branches: 80 }` block; keep the `src/server.ts` exclusion. Liveness-check the gate (temporarily raise
global to 100 → `pnpm test:coverage` must go red → restore).

**Alternatives considered**:
- *Global only, drop per-file* — rejected: weakens the bar (coverage gaming risk in the proposal).
- *Per-file only (status quo)* — rejected: the explicit global gate is a proposal success criterion.

**Rationale**: Per-file 90% strictly dominates global 80% on the current ~99% codebase, so the global
block is a floor-only affordance against future large low-coverage additions — it can never mask a
per-file failure. The liveness check proves the gate is wired, not decorative.

### Decision: CI — `cancel-in-progress` scoped to pull-request events

**Choice**:
```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```
Superseded PR pushes still cancel; every `push` to `master` (and `main`, rename-safe) runs to
completion. Validate YAML parses and the expression is static-review correct (no runtime CI to
observe from here; behavior confirms on the next PR + push).

**Alternatives considered**:
- *Branch-scoped groups (`ci-pr-…` vs `ci-master-…`)* — rejected: more YAML for identical semantics.
- *Leave `cancel-in-progress: true`* — rejected: keeps the M10-carryover gap open.

**Rationale**: One-expression change, branch-name agnostic, matches the spec scenarios exactly
(PR supersede cancels; default-branch commits never cancel).

### Decision: Reaffirm — no per-worker `mongod` (exploration Approach 2 stays rejected)

**Choice**: Keep shared `mongod` from `tests/setup/global-setup.ts` + per-file UUID databases +
forks `isolate: true`. No change to `tests/setup/global-setup.ts`.

**Alternatives considered**: Per-worker `MongoMemoryServer` — rejected per exploration (high
memory/CPU, slower cold start, touches every integration file's lifecycle; per-file UUID DBs already
isolate data). Accepted residual: binary-level contention flakes, contained by per-file DB names.

## Data Flow

Harness request lifecycle for the 413 path (TEST-04 surface):

```
supertest ──PUT 5MB+──→ per-file Server (127.0.0.1, ephemeral port) [tests/helpers/app.ts serve()]
                              │  BEFORE: res.setHeader('Connection','close') ──→ RST while body unread ──→ EPIPE/ECONNRESET
                              │  AFTER:  keep-alive default ──→ unread bytes drained ──→ clean 413
                              ▼
                         createApp → authenticate → fileParser (abortOnLimit → limitHandler
                                     → next(PayloadTooLargeError)) → errorHandler → 413 JSON envelope
                                     res 'close' → req.unpipe()+resume, rmSync tempFileDir (C10)
```

Drift-check pairing (TEST-05 surface):

```
app.router.stack ──filter(name==='router')──→ 6 RouteLayers (order = app.use() order, MUST NOT matter)
         │                                              │
         │ pairRouters(): suffix-set × MOUNT_PREFIXES ──┘──→ exact bijection or throw-with-diff
         ▼
sorted-set equality: fixture (METHOD,path) == live (METHOD, prefix+suffix)   [order-independent backstop]
         ▼
per-cell HTTP: one request per MATRIX case via fire()  [behavioral backstop]
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `tests/helpers/app.ts` | Modify | TEST-04: remove forced `Connection: close` in `serve()`; keep 127.0.0.1 + per-file server |
| `tests/unit/modules/media.temp-folder.test.ts` | Modify | TEST-04: remove reset tolerance (`req.on('error')` swallow :109, tolerant assertion :154); assert strict 413 |
| `tests/integration/security/authorize-matrix.test.ts` | Modify | TEST-05: pure `pairRouters` bijection replaces index pairing; permutation unit coverage; `#24`/`#25` use centralized builders |
| `tests/helpers/permission-matrix.ts` | Modify (comment only) | Update stale mount-order comment; MATRIX rows byte-identical |
| `tests/helpers/factories.ts` | Modify | Add `createVentas` + `createUserWithRole`; single role-literal site |
| `tests/helpers/actors.ts` | Create | Pure `{ id, role }` builders for service-unit tests (no DB imports) |
| `tests/helpers/auth.ts` | Modify | Add centralized `logoutAll` / `changePassword` supertest builders |
| `tests/helpers/uploads.ts` | Verify only | `stubMediaClient` already the single Cloudinary seam; no change unless a direct spy is found |
| `tests/integration/modules/users.test.ts` | Modify | Migrate `createUser({ role: 'VENTAS_ROLE' })` → `createVentas()` |
| `tests/integration/security/authz-adversarial.test.ts` | Modify | Migrate 4× `createUser({ role: 'VENTAS_ROLE' })` → `createVentas()` |
| `tests/integration/modules/auth.test.ts` | Modify | Use centralized auth builders (mechanical) |
| `tests/unit/modules/product.service.test.ts`, `tests/unit/modules/user.service.test.ts` | Modify | Unit `Actor` literals → pure actor builders |
| `tests/unit/modules/*.test.ts` (auth/users/categories/products/search/media) | Modify | Tests-only branch-gap fills (ownership 403/404 fork, self-lockout resend-same-value, media allowlist miss) |
| `vitest.config.mts` | Modify | Add global ≥80% threshold block; retain per-file 90/80 + `server.ts` exclusion |
| `.github/workflows/ci.yml` | Modify | `cancel-in-progress` PR-scoped expression |
| `TECH_DEBT.md` | Modify | Mark TEST-04/TEST-05 closed with fix commits |
| `src/**` | Untouched (verified) | `git diff --stat src/` MUST be empty at the end |

## Interfaces / Contracts

```ts
// tests/helpers/factories.ts — additions (DB-backed, mirrors createAdmin)
export const createUserWithRole = async (
  role: 'USER_ROLE' | 'VENTAS_ROLE' | 'ADMIN_ROLE',
  overrides: Record<string, unknown> = {},
): Promise<UserDocument> =>
  createUser({ name: `${role} User`, role, ...overrides });

export const createVentas = async (
  overrides: Record<string, unknown> = {},
): Promise<UserDocument> => createUserWithRole('VENTAS_ROLE', { name: 'Ventas User', ...overrides });
```

```ts
// tests/helpers/actors.ts — NEW, dependency-free (no mongoose/bcrypt imports)
export interface TestActor { id: string; role: 'USER_ROLE' | 'VENTAS_ROLE' | 'ADMIN_ROLE' }
export const actorWithRole = (
  role: TestActor['role'], id = `${role.toLowerCase()}-id`,
): TestActor => ({ id, role });
export const salesActor = (id?: string): TestActor => actorWithRole('VENTAS_ROLE', id);
export const adminActor = (id?: string): TestActor => actorWithRole('ADMIN_ROLE', id);
export const userActor = (id?: string): TestActor => actorWithRole('USER_ROLE', id);
```

```ts
// tests/helpers/auth.ts — additions (supertest-based, mirrors auth.test.ts closures)
import type { Server } from 'node:http';
import request from 'supertest';
export const logoutAll = (app: Server, header: Record<string, string>) =>
  request(app).post('/api/auth/logout-all').set(header);
export const changePassword = (app: Server, header: Record<string, string>, body: object) =>
  request(app).put('/api/auth/password').set(header).send(body);
```

```ts
// authorize-matrix.test.ts — pairing contract (pure, unit-testable)
import type { MOUNT_PREFIXES } from '../../helpers/permission-matrix';
type Prefix = (typeof MOUNT_PREFIXES)[number];
/** Exact bijection router ⇄ prefix by suffix-set matching; throws with a diff on 0/N candidates,
 *  unmatched routers, or unmatched prefixes (fail-closed). Order-independent by construction. */
declare function pairRouters(
  routers: RouteLayer[], prefixes: readonly Prefix[], fixturePairs: Set<string>,
): Map<RouteLayer, Prefix>;
```

```yaml
# .github/workflows/ci.yml — concurrency contract
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Harness loop (TEST-04) | 413 files 60/60 before AND after transport change; zero EPIPE/ECONNRESET | Shell loop over the five 413 files (`platform/app.test.ts`, `modules/media.test.ts`, `security/uploads.test.ts`, `security/multipart-scope.test.ts`, `unit/modules/media.temp-folder.test.ts`); record before/after tallies |
| Cross-talk guard (TEST-04) | No TEST-02-style interference after keep-alive | Full integration suite green; per-file servers on 127.0.0.1 retained |
| Tolerance removal (TEST-04) | Grep-empty: no `EPIPE`/`ECONNRESET`/reset-tolerance in `tests/` | `grep -rn EPIPE\|ECONNRESET tests/` must return nothing (document any single sanctioned exception, see Open Questions) |
| Pairing unit (TEST-05) | `pairRouters` correct under reorder | Reversed + sampled permutation inputs over synthetic `RouteLayer`s; each prefix matched exactly once |
| Drift fail-closed (TEST-05) | Added row → red; removed row → red | Scratch (uncommitted, reverted): add bogus MATRIX row; delete one row; both runs must fail on the pairing/set assertions |
| Matrix intent (TEST-05) | Route×role expectations unchanged | `git diff tests/helpers/permission-matrix.ts` shows comment-only change |
| Factory migration | No hand-rolled `role: 'VENTAS_ROLE'` outside factory + actors | Grep `role: 'VENTAS_ROLE'` → only `factories.ts` (impl) + `actors.ts` (impl) remain; DB-seed files (`indexes`/`migrations` tests) explicitly exempt with rationale |
| Coverage gate | Global ≥80% enforced; per-file still binding | `pnpm test:coverage` green; liveness: temp global→100 must go red, then restore |
| Per-service lines | Each of the 6 `*.service.ts` ≥90% lines | Read coverage report per file; fill branch gaps with unit tests only |
| Security retention | 14 `tests/integration/security/*` suites green, intent unchanged | Full run; `git diff --stat tests/integration/security/` limited to `authorize-matrix.test.ts` (+413 tolerance removal if sited there) |
| CI scoping | YAML valid; PR cancels, push completes | YAML parse check + static review of the expression (live behavior confirms on next PR/push) |
| Blast-radius guard | Tests/harness/config/CI/docs only; no `vi.mock`; no new deps | `git diff --name-only` against path allowlist; `git diff src/` empty; grep `vi.mock` in `tests/` empty; `package.json` deps diff empty |
| Full pipeline | 1263+ tests, lint, typecheck, build, `pnpm audit --prod` | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test:coverage && pnpm audit --prod` |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR command composition, executable-file classification,
or process-integration boundary. The CI edit is a declarative `concurrency` flag (no composed git/PR
commands); the threat-matrix rows (doc-path execution, `git -C` selectors, commit/push/PR command
states) have no applicable surface, so no RED tests are manufactured for them.

## Migration / Rollout

No migration, no feature flags, no data cleanup — tests/harness/config/CI/docs only. Land as one
commit per item in dependency order (each independently revertible per the proposal rollback plan):

1. TEST-04 harness transport + tolerance removal (loop-verified 60/60 before/after).
2. TEST-05 pairing rework (scratch fail-closed verified, then reverted scratch).
3. Factories + actors + shared fakes + caller migration.
4. Global coverage gate (liveness-checked).
5. Service branch-gap fills (tests only; `git diff src/` empty) + security-retention pass.
6. CI scoping + TECH_DEBT.md close.

Revert per item: `git revert <item-commit>` (TEST-04 revert restores the header + tolerance;
TEST-05 revert restores index pairing against unchanged rows; gate revert deletes the global block;
CI revert restores `cancel-in-progress: true`).

## Open Questions

- [ ] `media.temp-folder.test.ts` uses a bespoke raw-`http.request` server (not `tests/helpers/app.ts`):
  if its 413 case still resets at a low rate over 60/60 loops after the harness change (server-side
  `abortOnLimit` destroy racing the 5 MB client write), do we (a) keep going until a clean mechanism
  is found, or (b) retain a minimal, commented tolerance in that one raw-socket unit test and record
  it as accepted residual with orchestrator sign-off? Primary path is (a); (b) needs sign-off because
  it amends a spec scenario.
- [ ] The proposal counts "three reset-tolerance workarounds": confirmed two markers in
  `media.temp-folder.test.ts` (:109 error-swallow, :154 tolerant assertion) plus the harness header
  itself. If the pre-work grep inventory finds a different count, the implementer records the true
  inventory in tasks and proceeds (intent: grep-empty at the end, modulo the question above).
