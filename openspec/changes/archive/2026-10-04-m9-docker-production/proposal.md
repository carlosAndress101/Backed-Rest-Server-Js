# Proposal: M9 Docker & Production Readiness

## Intent

ROADMAP M9's goal is "a deployable, operable, stateless service". After 3.1.0 (M3–M8), the service is stateless (ADR-008, `tokenVersion` revocation instead of sessions), shuts down gracefully on SIGTERM/SIGINT with a 10 s drain (`src/server.ts`), trusts proxy hops through a strict `TRUST_PROXY` (`app.ts:36`), logs structured JSON to stdout with redaction (ADR-011), and refuses to serve before the database is connected. What is missing is all deployment surface: there is no Dockerfile, no compose setup for local dev, no liveness/readiness endpoints, and two open TECH_DEBT items with an M9 milestone — OPS-04 (the container command must run `node dist/server.js` directly, because `pnpm start` does not forward SIGTERM as PID 1) and OPS-05 (a production boot guard refusing to serve until `M001-normalize-email` is in the `migrations` ledger). OPS-03 closes its remainder here (Dockerfile, `/health`, `/ready`); its CI half already landed in M2.

This is the right time because M8 gave M9 the surface it builds on (documented contract, production config story, `DOCS_ENABLED` off by default in production) and there is still no deployment target (Zeabur retired, owner 2026-09-23), so M9 ships a platform-agnostic container plus a production checklist, and the target is chosen then.

## Scope

### In Scope
1. **Platform routes.** `GET /health` (liveness, no DB touch, always 200 when the process serves) and `GET /ready` (readiness: a real DB ping; 200 when ready, 500 `INTERNAL` otherwise — D1). Both anonymous, recorded as permission-matrix rows #28/#29 (owner decision, M9 S0) following the `/docs` #26/#27 precedent, so TEST-05 stays fail-closed. Excluded from the 21-operation OpenAPI catalog, which covers `/api/*` only (#26/#27 are likewise excluded — verified in `src/docs/operations.ts`).
2. **Container.** A multi-stage `Dockerfile` (Node 24 alpine, non-root `USER node`, prod deps only, `CMD ["node", "dist/server.js"]` directly per OPS-04, `HEALTHCHECK` against `/health` honoring `$PORT`) plus `.dockerignore`. No new runtime dependency.
3. **Local dev compose.** `docker-compose.yml` with `api` (build, `depends_on` mongo healthy) and `mongo` (pinned major, named volume, own healthcheck). Dev-only placeholder values; no secrets committed (M8 placeholder precedent).
4. **OPS-05 boot guard.** In production only, after the database connects and before `listen`, the boot refuses (exit 1, actionable message) unless `M001-normalize-email` is recorded in the `migrations` ledger — the one hard gate (T4.5 recommendation; M005/M006 absence is low-impact per M5 design, so they are not gated). Dev/test boots are untouched.
5. **Production config checklist.** A README section: `SECRET_KEY` ≥ 32 chars, `MONGO_CLOUD`, `CORS_ORIGINS` allowlist (no `*`), `TRUST_PROXY` hop count, `pnpm migrate up` before serving, `DOCS_ENABLED` off, seed only for first admin. `TRUST_PROXY` guidance per the M9 risk note.
6. **Ledger closure.** TECH_DEBT OPS-03 (remainder), OPS-04, OPS-05 closed; API_PROGRESS rows #28/#29; ROADMAP M9 outcome; CHANGELOG `[Unreleased]` M9 section; ARCHITECTURE ADR rows (ADR-051 onward).

### Out of Scope
- A deployment target, managed Mongo, TLS termination, or secrets manager: there is none, so M9 stays platform-agnostic (ROADMAP risk note).
- Multi-instance rate-limiter store (named "M9" in M5-auth design §10, but absent from the ROADMAP M9 deliverables): deferred as a documented residual — no multi-instance target exists, and adding Redis would violate YAGNI.
- CI image build/push, CodeQL, Renovate (M10). The Dockerfile is validated by inspection + tests of what it serves; the image build gate belongs to M10's pipeline.
- New env vars, new dependencies, any existing-contract change. `/health` and `/ready` are additive only.
- SEC-16/17/18, CQ-06, and other open TECH_DEBT items.

## Capabilities

> Contract between proposal and specs phases. Researched `openspec/specs/`: `demo-page`, `developer-documentation`, `openapi-docs`, `testing-hardening`. None covers deployment or platform routes, and none of their requirements change: the OpenAPI catalog boundary (21 API operations) is unchanged in intent, the README gains an additive section (the drift tests assert key/script coverage, which additions preserve), and the testing-hardening blast-radius guard is scoped to its change.

### New Capabilities
- None. The two platform routes are pinned by integration + unit tests and recorded in the permission-matrix fixture and API_PROGRESS, following the established `/docs` precedent without a spec ceremony.

### Modified Capabilities
- None.

> Note (2026-10-04, owner decision, retroactive): a `platform-readiness` spec was added at close-out so this change can be archived with a recorded capability for M10 to build on. History above is unchanged; see `specs/platform-readiness/spec.md`.

## Approach

**Recommended direction.** Four implementation slices on `feat/m9-docker-production` as chained PRs (M8 pattern), small traceable commits, no squash, no AI attribution:

1. **S1 — platform routes.** `src/platform/health.ts` exporting a `healthRouter({ checkDb })` factory (DI precedent: `docsModule({ buildDocument })`, so the 500 path is testable without `vi.mock`); `createApp` wires the real check (mongoose readyState + `db.admin().ping()`) and mounts the router; matrix fixture + API_PROGRESS rows #28/#29; `tests/integration/platform/health.test.ts` (live 200s via `startTestApp`) + router-level test for the 500 envelope with a rejecting fake. Per-file coverage bar applies.
2. **S2 — container.** Multi-stage Dockerfile (deps with build tools for bcrypt native compile → build (`pnpm build`) → runtime with prod-only `node_modules` + `dist/`), `.dockerignore`, compose with mongo healthcheck and `depends_on: condition: service_healthy`. Validation by inspection + the S1 tests proving what the image serves; `docker build` runs wherever a runtime exists (not on the dev machine — ROADMAP risk).
3. **S3 — boot guard.** Production-only ledger check in `src/server.ts` via the existing read-only `migrationStatus`; spawn-pattern tests in `server.test.ts` (guard fires with exit 1 on a fresh prod DB; passes after `migrate up`).
4. **S4 — checklist + closure.** README production checklist, TECH_DEBT closures, ADR-051…, CHANGELOG, API_PROGRESS/ROADMAP updates, final pipeline `format:check && lint && typecheck && build && test:coverage && audit --prod`.

**Release mapping (assumption, confirmed at release).** Additive only (two new anonymous routes, container files, a production-only boot refusal on an undeployed hazard), so MINOR (3.2.0) under ADR-024/SemVer. No release ships until the milestone validates (rule 13).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/platform/health.ts` | New | `healthRouter({ checkDb })`: `GET /health`, `GET /ready` |
| `src/app.ts` | Modified | Wire real `checkDb`, mount router |
| `src/server.ts` | Modified | OPS-05 production boot guard |
| `Dockerfile`, `.dockerignore`, `docker-compose.yml` | New | Container + local dev |
| `README.md` | Modified | Production checklist section (additive) |
| `tests/helpers/permission-matrix.ts` | Modified | Rows #28/#29 |
| `tests/integration/platform/health.test.ts` + router test | New | 200s live, 500 envelope via fake |
| `tests/integration/platform/server.test.ts` | Modified | Boot-guard spawn tests |
| `TECH_DEBT.md`, `API_PROGRESS.md`, `ROADMAP.md`, `CHANGELOG.md`, `ARCHITECTURE.md` | Modified | Closures, rows, ADR-051… |
