# Tasks: M9 Docker & Production Readiness

Slices land as chained PRs (M8 pattern). Each slice ends with `pnpm format:check && pnpm lint && pnpm typecheck` plus its stated tests; S4 runs the full pipeline.

## S0 — Change scaffolding (this slice)

- [x] 0.1 Branch `feat/m9-docker-production` from `eb6c1a1` (`next` = `master`, tree clean).
- [x] 0.2 `openspec/changes/m9-docker-production/{proposal,design,tasks}.md` (no new capability specs — rationale in proposal).
- [x] 0.3 Owner decision recorded: `/health` + `/ready` as anonymous matrix rows #28/#29.
- [x] 0.4 Catalog boundary verified: `src/docs/operations.ts` covers `/api/*` only, so platform routes stay out like #26/#27.

## S1 — Platform routes (`GET /health`, `GET /ready`)

- [x] 1.1 Create `src/platform/health.ts`: `healthRouter({ checkDb })` with `GET /health` → `200 { data: { status: 'ok' } }` (no DB touch) and `GET /ready` → real `checkDb()` → `200 { data: { status: 'ok' } }`, rejection → `next(new InternalError('Database not ready'))` (D1). No auth, no limiter, no `process.env`, no `console`.
- [x] 1.2 Edit `src/app.ts`: wire `checkDb` (`readyState === 1` + `db.admin().ping()`, D2) and mount the two platform routers before `notFound` (D3).
- [x] 1.3 Matrix rows #28/#29 (anonymous `GET`) in `tests/helpers/permission-matrix.ts` + `API_PROGRESS.md` route inventory (#28, #29, totals).
- [x] 1.4 `tests/integration/platform/health.test.ts` via `startTestApp`: `/health` 200 envelope; `/ready` 200 envelope; both carry `x-request-id`; unknown `/ready` sub-path still 404 envelope.
- [x] 1.5 Router-level test with injected fakes: resolving `checkDb` → `/ready` 200; rejecting `checkDb` → 500 `{ error: { code: 'INTERNAL', message: 'Database not ready' } }` (no `vi.mock`).
- [x] 1.6 TEST-05 green with 9 routers paired; new file meets per-file 90/90/80/90.
- [x] 1.7 PR1: `pnpm vitest run tests/integration/platform tests/integration/security` + typecheck/lint/format.

## S2 — Container + compose

- [x] 2.1 `Dockerfile` per D5 (three stages, `USER node`, direct `node dist/server.js`, `HEALTHCHECK` with `${PORT:-1500}`); `.dockerignore` (node_modules, dist, coverage, .git, `.env*`, editor dirs). F2: `pnpm-workspace.yaml` is copied into both dependency-install stages; the build stage also installs `python3`, `make` and `g++` because it performs a full install that may compile bcrypt.
- [x] 2.2 `docker-compose.yml` per D6 (api + mongo:8, named volume, mongo healthcheck, `service_healthy` gate, placeholder-only values, `TRUST_PROXY` comment). F1: api targets the `build` stage so `pnpm dev` and its dev dependencies exist.
- [x] 2.3 Inspection review of both files against D5/D6 (no build tools or dev deps in runtime; no secrets; compose boots `NODE_ENV=development`).
- [x] 2.4 PR2: full `pnpm test` green (no `src/` change expected — files only).

## S3 — OPS-05 boot guard

- [x] 3.1 Edit `src/server.ts`: production-only, post-connect, pre-listen `migrationStatus` check for `M001-normalize-email`; missing → `logger.fatal` + exit 1 naming `pnpm migrate up` (D4). Reuse `src/cli.ts`'s migrations list source.
- [x] 3.2 `server.test.ts` spawn tests: `NODE_ENV=production` on a fresh DB exits 1 naming M001; after `migrate up` (via CLI) the same env boots and serves `/health`.
- [x] 3.3 Dev/test boots unchanged (no guard outside production); existing spawn tests green.
- [x] 3.4 PR3: full `pnpm test` + typecheck/lint/format.

## S4 — Checklist, ledgers, final validation

- [x] 4.1 README `## Production checklist` per D7 (additive; drift tests stay green).
- [x] 4.2 Close TECH_DEBT OPS-03 (remainder), OPS-04, OPS-05 with commit hashes; API_PROGRESS totals; ROADMAP M9 outcome; CHANGELOG `[Unreleased]` M9 section; ARCHITECTURE ADR-051 (Dockerfile/compose), ADR-052 (`/health`+`/ready`, D1–D3), ADR-053 (boot guard, D4).
- [x] 4.3 Final pipeline `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test:coverage && pnpm audit --prod` — all exit 0.
- [x] 4.4 PR4 + milestone validation. No release ships here (rule 13; version mapping confirmed at release, assumed MINOR 3.2.0). F4: CI validates compose config, builds the `build` target, starts the stack, checks `/health`, and always tears it down; it does not push or use secrets.

## Residuals (documented, not implemented)

- Multi-instance rate-limiter store (no target; Redis would violate YAGNI) → deploy/M10.
- Image build/push pipeline → M10 (`docker build`, `compose config` run by a reviewer with a runtime before S2 merge).
