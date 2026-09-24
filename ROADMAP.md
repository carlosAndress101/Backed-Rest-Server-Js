# Roadmap

> Owner: CarlosH / SH1FT3R · Orchestrated multi-agent delivery (Claude Code · OpenCode · Nodeterm · RTK)
> Updated 2026-09-24 · Current milestone: **M3 next** (M2 accepted 2026-09-24, release 2.1.0)

Complexity scale: **S** (≤1 agent-day) · **M** (2–3) · **L** (4–6) · **XL** (>6). Tests are a quality gate in **every** milestone (ADR-013); M7 closes the remaining gaps.

| # | Milestone | Complexity | Depends on | Status |
|---|---|---|---|---|
| M0 | Audit & Baseline | S | — | ✅ Accepted 2026-09-23 |
| M1 | Stabilization & Security Hotfix | M | M0 | ✅ Accepted 2026-09-24 (T1.5 review: ACCEPT after T1.2R), release **2.0.0** ([briefs](docs/tasks/M1-stabilization.md)) |
| M2 | Foundation: tooling, TypeScript, config, logging, errors, Express 5 | L | M1 | ✅ Accepted 2026-09-24 (T2.8 review: ACCEPT), release **2.1.0** ([design](docs/design/M2-foundation.md)) |
| M3 | Feature-First Refactor + Validation/DTOs | L | M2 | 🔄 In progress: design accepted ([M3-modules](docs/design/M3-modules.md)); T3.1 core running on `m3/modules` |
| M4 | Database Improvements | M | M3 | 📝 Design accepted ([M4-database](docs/design/M4-database.md)) |
| M5 | Authentication Hardening | M | M4 | Planned |
| M6 | Authorization (RBAC + ownership) | M | M5 | Planned |
| M7 | Testing Hardening | M | M6 | Planned |
| M8 | API Documentation | S–M | M3, M6 | Planned |
| M9 | Docker & Production Readiness | M | M2, M4 | Planned |
| M10 | CI/CD | M | M9 (basic CI lands in M2) | Planned |

Why this order differs from the default template: **security first** (ADR-001) because Critical, unauthenticated exploits exist in a public repo. The deployment it referenced (Zeabur) is gone (owner, 2026-09-23), but anyone can still run the public code. **Foundation before refactor**, so the refactor lands on typed config, errors, and tests. **Database before auth**, because auth hardening needs `tokenVersion` and normalised emails. **Validation is folded into the refactor**, because every validation chain moves anyway, and doing it twice would violate DRY.

---

## M0: Audit & Baseline ✅ (accepted 2026-09-23)
- **Goal:** Complete understanding of the codebase and a prioritised plan.
- **Deliverables:** ARCHITECTURE.md (inventory, target, ADRs), TECH_DEBT.md (44 items), API_PROGRESS.md (23 entry points), ROADMAP.md, CHANGELOG.md, M1 delegation briefs.
- **Risks:** Findings are from static analysis plus a dependency audit. The runtime could not be exercised because the lockfile is unreadable (OPS-01).
- **Complexity:** S · **Dependencies:** none.

## M1: Stabilization & Security Hotfix ✅ (accepted 2026-09-24, release 2.0.0)
- **Outcome:** tasks T1.1–T1.4 and T1.7, plus the T1.2R fix from the T1.5 review. 101 regression tests. All 5 Criticals and SEC-06…SEC-10, SEC-15 and REL-04 fixed. 0 audit advisories. One follow-up, TEST-02 (flaky test, T1.8), lands before the M2 suite port.
- **Goal:** Close every Critical and the cheap Highs **without restructuring**, so the current code is safe to run while the rewrite happens.
- **Deliverables:**
  - Reproducible install (pnpm pinned, lockfile regenerated). `google-auth-library` moved to runtime deps. Vulnerable deps upgraded (cloudinary 2, bcrypt 6, uuid replaced by `crypto.randomUUID`). `engines`/`.nvmrc` on Node 24.
  - Access control: authenticated self-or-admin `PUT /api/user/:id` with a field whitelist; sign-up ignores `role`; admin-only user listing and user search; authenticated media writes; path containment on image serving.
  - Auth surface: login/google rate limit, one generic credential error, 403 for insufficient role.
  - Crash safety: every async handler error-safe; global JSON 404 and 500 handlers; duplicate key → 409; regex input escaped and results capped; DB connection awaited before `listen`, fail fast on error.
  - Hardening: `helmet`, `x-powered-by` off, multipart size limits, temp file cleanup.
  - A security regression suite (Jest + supertest + mongodb-memory-server) proving each fix.
- **Risks:** The fixes are breaking for any client that relies on the open endpoints (see API_PROGRESS ledger). There is no live deployment (owner, 2026-09-23). If the old production database is reused, it may hold rogue admin accounts or tampered `image` values and needs the T1.6 data check first. The first `mongodb-memory-server` run downloads a `mongod` binary, which requires network.
- **Complexity:** M · **Dependencies:** M0 sign-off. Owner answers: no live deployment; consumers unknown, so every change is logged as breaking (ADR-015).

## M2: Foundation ✅ (accepted 2026-09-24, release 2.1.0)
- **Outcome:** tasks T2.1–T2.7, plus follow-ups T2.3b (Mongoose 9 on Vitest, AM-6), T2.4R and T2.5R (TEST-03). The app boots from TypeScript (`src/server.ts` → `createApp`) with the legacy routers behind `src/legacy.ts`. Express 5.2.1, Mongoose 9.10.2, zod config, pino logging, one `AppError` model, 248 Vitest tests, CI. ARC-02, ARC-03, SEC-14, LOG-01, REL-02, REL-03, SEC-10, TEST-02 and TEST-03 fixed.
- **Goal:** A typed, testable, observable platform for the refactor to land on.
- **Deliverables:** TypeScript strict (`tsc` build, `tsx` dev), pending ADR-002. ESLint (flat) + Prettier, including a layer-boundary lint rule. Vitest + supertest + mongodb-memory-server harness, with the M1 suite ported. `src/config` validated with zod (fail fast), typed config object, documented `.example.env`. pino + pino-http with request id and redaction. `AppError` hierarchy, error middleware, 404, response envelope helpers. `createApp(deps)` separated from `server.ts` boot. Express 5 (ADR-003). Mongoose 9 with `sanitizeFilter` on and `strictQuery` true. CORS allowlist from config. Basic GitHub Actions CI: install, lint, typecheck, test.
- **Risks:** Big-bang conversion; behaviour changes in Express 5 (`req.body` undefined without a parser, path syntax) and Mongoose 9. **Mitigation:** the M1 regression suite must be green before and after, and the upgrades land as separate commits.
- **Complexity:** L · **Dependencies:** M1 accepted (ADR-002 accepted 2026-09-23; strangler approach per ADR-016).

## M3: Feature-First Refactor + Validation/DTOs
- **Goal:** Clean feature modules: thin controllers, services owning the rules, zod DTOs everywhere.
- **Deliverables:** `src/modules/{auth,users,categories,products,search,media}` with the anatomy in ARCHITECTURE §2.2. `categories` is built first as the **reference module**; the others fan out in parallel once it passes review. Duplications removed (DUP-01) with shared helpers only where duplication is proven (pagination, find-active-or-404, soft delete). Correct status codes and envelope. Dead code removed (CQ-02). English naming (CQ-01). Cloudinary-only media (ADR-008): `GET` redirects to the asset URL, MIME sniffing, uploads restricted to the media router. Soft-deleted resources return 404.
- **Risks:** API contract drift across parallel agents, mitigated by the reference module plus a contract table in API_PROGRESS. Client breakage, mitigated by the breaking-change ledger and CHANGELOG.
- **Complexity:** L · **Dependencies:** M2.

## M4: Database Improvements
- **Goal:** Schema integrity and query performance.
- **Deliverables:** timestamps on all schemas. Email lowercase/trim plus a unique index, with a duplicate report and migration. Role enum (ADR-007) with the `Role` collection dependency removed. `price ≥ 0`. Partial unique indexes on `name` where `state: true`. Indexes on `state`, `category`, `user`. Text index (or anchored prefix search) replacing unanchored regex. A shared `toJSON` plugin (`id`, no `__v`, no secrets). A migration runner with up/down and an idempotent seed that bootstraps the first admin from env. A `tokenVersion` field for M5.
- **Risks:** Index builds fail on existing duplicates in any reused database. **Mitigation:** dry-run report, backup, and owner approval before running against a real database.
- **Complexity:** M · **Dependencies:** M3.

## M5: Authentication Hardening
- **Goal:** Standards-compliant, revocable, abuse-resistant authentication.
- **Deliverables:** `Authorization: Bearer`, with `x-token` deprecated (ADR-010). JWT pinned to HS256 with `iss`/`aud` and configurable TTL; a minimum secret length validated at boot. `tokenVersion` revocation, with `POST /auth/logout-all` and `PUT /auth/password` (current password required). Async bcrypt compare with cost from config. A password policy. Google: `email_verified` required, no placeholder password, explicit account-linking rule. Rate limits per IP and per account. **Refresh tokens are out of scope** (YAGNI) until a client needs them.
- **Risks:** Existing tokens are invalidated on deploy; client migration to Bearer.
- **Complexity:** M · **Dependencies:** M4.

## M6: Authorization
- **Goal:** Explicit, testable RBAC plus ownership rules.
- **Deliverables:** one `authorize(policy)` middleware replacing `esAdminRole`/`hasRole`. A permission matrix per route published in API_PROGRESS. Ownership rules (users edit themselves; the product/category creator vs admin rules are confirmed by the owner). Consistent 401 vs 403. A decision on `VENTAS_ROLE`. A test for every cell of the matrix.
- **Risks:** Business rules for roles are unspecified today, so owner input is needed.
- **Complexity:** M · **Dependencies:** M5.

## M7: Testing Hardening
- **Goal:** Confidence to ship on every merge.
- **Deliverables:** unit tests for every service (≥90% lines on services); integration tests for every route × role; security regression suite retained; data factories; coverage threshold enforced in CI (≥80% global).
- **Risks:** Flaky DB tests, mitigated by an isolated in-memory DB per worker.
- **Complexity:** M · **Dependencies:** M6.

## M8: API Documentation
- **Goal:** A self-serve API for consumers and future agents.
- **Deliverables:** OpenAPI 3.1 generated from the zod DTOs and served at `/docs` (disabled in production unless flagged); a README covering setup, env, scripts, and architecture summary; an `.http`/curl example collection; an error-code catalogue; a decision on the `public/` demo page (CQ-07).
- **Risks:** Spec drift, mitigated by generating from code rather than writing by hand.
- **Complexity:** S–M · **Dependencies:** M3, M6.

## M9: Docker & Production Readiness
- **Goal:** A deployable, operable, stateless service.
- **Deliverables:** a multi-stage Dockerfile (Node 24 alpine, non-root, prod deps only); docker-compose with API and Mongo for local dev; `/health` (liveness) and `/ready` (DB ping); graceful shutdown on SIGTERM; `trust proxy` config; stdout JSON logs; a production config checklist.
- **Risks:** Docker isn't installed on the dev machine, so Docker Desktop, OrbStack, or Colima is needed. There is no deployment target: the Zeabur deployment is retired (owner, 2026-09-23). M9 ships a platform-agnostic container plus `TRUST_PROXY` guidance, and the target is chosen then.
- **Complexity:** M · **Dependencies:** M2, M4.

## M10: CI/CD
- **Goal:** Automated gates and delivery.
- **Carried from M2 (T2.7 Q1):** `cancel-in-progress` only for pull requests (`${{ github.event_name == 'pull_request' }}`), so every `master` commit gets a finished run.
- **Deliverables:** PR pipeline (lint, typecheck, test, coverage, `pnpm audit`); CodeQL and dependency review; Renovate or Dependabot; image build and push to GHCR; deploy on tag; conventional commits driving CHANGELOG; branch protection.
- **Risks:** Deploy secrets management; platform integration unknown.
- **Complexity:** M · **Dependencies:** M9 (basic CI already exists from M2).
