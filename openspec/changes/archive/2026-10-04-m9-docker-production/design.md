# Design: M9 Docker & Production Readiness

## Decisions

### D1 — `/ready` not-ready answers 500 `INTERNAL`, not 503

The `ErrorCode` union (`src/core/errors/app-error.ts`) has no `SERVICE_UNAVAILABLE`, and `ERROR_CATALOG`, `ERROR_CODES.md`, the OpenAPI error components, and the doc-drift tests all bind each code to exactly one status (`INTERNAL` → 500). Minting a 503 would ripple through every one of those artifacts for a single new route. Container and orchestrator healthchecks treat any non-2xx as failure, so 500 carries the same operational signal with zero catalog churn: `next(new InternalError('Database not ready'))` through the standard `errorHandler` envelope. The message leaks nothing sensitive (a DB dependency is public knowledge for a data-backed API).

### D2 — `checkDb` is injected; `createApp` wires mongoose

`healthRouter({ checkDb }: { checkDb: () => Promise<void> })` performs no import of mongoose or models, so the 500 path is testable with a rejecting fake and no `vi.mock` (ADR-023). `createApp` (composition root, may import anything) wires the real check: `readyState === 1` plus `db.admin().ping()`, a real round-trip rather than a possibly stale flag. A failed ping and a missing `db` handle both reject, and the route answers D1. No new lint layer is needed: no existing `layer()` pattern matches `src/platform/**`, so the generic `src/**` rules (no `console`, no `process.env`) apply; the file imports only `express` and the error class.

### D3 — Two platform routers mounted at root

`app.use('/health', healthRouter())` and `app.use('/ready', readyRouter({ checkDb }))` keep the two platform paths explicit while each router owns its local `/` handler. This mirrors `docsModule()`'s factory shape and keeps liveness independent from readiness. No auth, no limiter (limiters are per-route in auth only — there is no global limiter to exempt), helmet + CORS apply as on every route. Response shapes follow the success envelope: `GET /health` → `200 { data: { status: 'ok' } }`; `GET /ready` → `200 { data: { status: 'ok' } }`, else D1.

### D4 — Boot guard is production-only and M001-only

`src/server.ts`, after `connectDatabase` resolves and before `listen`: `if (config.env === 'production')` read `migrationStatus(mongoose.connection.db, MIGRATIONS)` (read-only, already exported) and exit 1 with `M001-normalize-email is not applied; run 'pnpm migrate up' before serving` unless it is recorded. Production-only because dev/test boot against autoIndexed/lived databases where the guard would break every `startTestApp`/`server.test.ts` boot for no benefit. M001-only because it is the sole hard gate (T4.5; the 2.x mixed-case-email lockout), while M005/M006 absence is low-impact by M5 design. The migrations list comes from the same source `src/cli.ts` uses (no duplication).

### D5 — Dockerfile shape

Three stages on `node:24-alpine` (ADR-014): (1) `deps`: `corepack enable` (honors `packageManager` pnpm@12.3.4, no version drift) + `apk add python3 make g++` for the bcrypt native compile + `pnpm install --prod --frozen-lockfile`; (2) `build`: full install + `pnpm build`; (3) `runtime`: fresh alpine, `USER node` (image-provided non-root), `NODE_ENV=production`, copy `package.json`, prod `node_modules`, and `dist/` with root→node ownership fix, `EXPOSE 1500`, `HEALTHCHECK CMD-SHELL wget -qO- http://127.0.0.1:${PORT:-1500}/health || exit 1` (busybox `wget`, `$PORT` honored), `CMD ["node", "dist/server.js"]` — the direct-exec form OPS-04 requires, so PID 1 receives SIGTERM and the existing graceful shutdown runs. No `curl`, no build tools, no dev deps in runtime.

### D6 — Compose is dev-local only

`api` builds `.`, maps `1500:1500`, sets `NODE_ENV=development` and the required vars with placeholder values (M8 placeholder precedent — `cloudinary://key:secret@demo` satisfies the URL regex; connectivity is only needed when media routes run), `depends_on: mongo` with `condition: service_healthy`. `mongo` pins a major (`mongo:8`), carries a named volume, and has its own `mongosh --eval 'db.adminCommand("ping")'` healthcheck. `TRUST_PROXY` stays unset (direct local traffic) with a comment pointing at the README checklist for proxied deploys.

### D7 — Checklist lives in README, additive

A `## Production checklist` section after Environment/Scripts keeps the root-ledger convention and stays clear of the doc-drift assertions (they require every `envSchema` key and every `package.json` script to appear — additions preserve that). Contents: `SECRET_KEY` ≥ 32 chars (never committed), `MONGO_CLOUD` + `pnpm migrate up` before first serve (OPS-05), `CORS_ORIGINS` explicit allowlist, `TRUST_PROXY` = real proxy hop count, `DOCS_ENABLED` unset (stays off), `pnpm seed` only for the first admin, and the data warning for reused 2.x databases (T1.6).

## Alternatives considered

- **503 + new `SERVICE_UNAVAILABLE` code:** rejected per D1 (catalog churn for one route).
- **`/ready` reading `readyState` only:** rejected per D2 (stale-flag risk; a ping is one round-trip on an infrequently hit endpoint).
- **Guard requiring all M001–M006:** rejected per D4 (M005/M006 absence is tolerated by design; gating on them would block deploys that the runbook allows).
- **PM2/tini as PID 1:** rejected — direct `node` exec is what OPS-04 prescribes and needs no new binary.
- **Shared rate-limiter store (Redis):** out of scope (proposal) — no multi-instance target exists.

## Risks

- **No Docker runtime on dev machine:** the Dockerfile/compose are validated by inspection and by the S1 tests proving the served surface; the image build gate lands in M10's pipeline. A reviewer with Docker available should run `docker build` + `docker compose config` before merge.
- **`HEALTHCHECK` start period:** the app boots fast (connect + listen), but a cold Mongo on first compose up can exceed it; `start-period` + `depends_on healthy` cover the ordering, retries cover the tail.
