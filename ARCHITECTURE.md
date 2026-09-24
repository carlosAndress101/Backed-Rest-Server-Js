# Architecture

> Owner: Carlos Andrés Hinestroza Pérez (CarlosH / SH1FT3R) · Maintained by the Orchestrator
> Audit baseline: commit `2f18dce` (master) · Audited 2026-09-23 · Milestone 0

This document has three parts: the **as-is** inventory (what the code is today), the **to-be** target (what every milestone converges on), and the **ADR log** (why). Route-level detail lives in [API_PROGRESS.md](API_PROGRESS.md); every defect lives in [TECH_DEBT.md](TECH_DEBT.md).

---

## 1. As-is (audited)

### 1.1 Stack and runtime

| Item | Value |
|---|---|
| Runtime | Node.js (no `engines` pin; local machine: v24.16.0) |
| Module system | CommonJS |
| Language | JavaScript, no type checking |
| Framework | Express 4 (`^4.18.2`, resolves 4.22.x) |
| Database | MongoDB via Mongoose 7 (`^7.5.0`) |
| Auth | JWT (`jsonwebtoken`), bcrypt, Google Identity (`google-auth-library`) |
| Media | Cloudinary SDK v1 + `express-fileupload` (local disk and Cloudinary both used) |
| Validation | `express-validator` 7, inline chains in route files |
| Tests | Jest 29 + supertest (non-functional, see TEST-01) |
| Package manager | pnpm (lockfile v6, **unreadable by the installed pnpm 12**, see OPS-01) |
| Size | ~1,550 LOC JavaScript across 34 files |

### 1.2 Folder structure

```
Backed-Rest-Server-Js/
├── app.js                  # entrypoint: dotenv + new Server().listen()
├── models/
│   ├── server.js           # Express app + DB connect + listen (misplaced: not a model)
│   ├── index.js            # barrel (re-exports Server as if it were a model)
│   ├── user.js  role.js  category.js  product.js
├── routes/                 # 6 routers, validation chains inline
│   ├── auth.js  usuarios.js  category.js  products.js  search.js  uploads.js
├── controllers/            # 6 controllers: HTTP + business rules + persistence + Cloudinary
│   ├── auth.js  usuarios.js  category.js  product.js  search.js  uploads.js
├── middlewares/            # validar-campos, validar-jwt, validar-roles, file-valid (+ barrel)
├── helpers/                # db-validators, generar-jwt, google-verify, upload-file (+ barrel)
├── database/config.js      # mongoose.connect(MONGO_CLOUD)
├── public/                 # static Google Sign-In demo page (index.html, js/auth.js, css, svg)
├── assets/notFound.jpg     # placeholder image served by GET /api/uploads
├── uploads/                # local disk image storage (gitignored contents)
├── e2e/                    # prueba.e2e.js (placeholder), user.e2e.js (broken)
├── jest-e2e.json  package.json  pnpm-lock.yaml  .example.env  .gitignore
```

Organisation is **layer-by-type**. There is **no service layer, no repository layer, no config module, no error module, no logger**.

### 1.3 Request pipeline (global middleware order, `models/server.js`)

```
cors() [all origins] → express.json() → express.static(public/) → fileUpload({useTempFiles, /tmp/}) [every route]
  → router → [route validators (express-validator) → validarCampos] → [validarJWT] → [esAdminRole|hasRole] → controller
  (no 404 handler, no error-handling middleware)
```

### 1.4 Layer inventory

| Layer | Present | Files | Notes |
|---|---|---|---|
| Routes | ✅ | 6 | Mounted at `/api/{auth,user,category,product,search,uploads}` plus a debug `GET /hello` |
| Controllers | ✅ | 6 (22 handlers) | Talk to Mongoose and Cloudinary directly; several async handlers have no error handling |
| Services | ❌ | — | Business rules live in controllers |
| Repositories | ❌ | — | Mongoose models used directly (see ADR-004: stays that way, deliberately) |
| Models | ✅ | 4 (+`Server`) | User, Role, Category, Product |
| Middlewares | ✅ | 4 | `validarCampos`, `validarJWT`, `esAdminRole` / `hasRole`, `fileValid` |
| Helpers | ✅ | 4 | DB existence validators, JWT signing, Google token verify, local file upload |
| Config | ⚠️ | 2 | `database/config.js`, `.example.env` (names only). `process.env` read ad hoc in 5 files |
| DTOs | ❌ | — | `req.body` spread straight into models |
| Error handling | ❌ | — | Per-handler try/catch where present; shapes differ per handler |
| Logging | ❌ | — | `console.log` only |
| Tests | ❌ | 2 | Both non-functional |
| API docs | ❌ | — | No README, no OpenAPI |

### 1.5 Data model and relationships

```mermaid
erDiagram
    USER ||--o{ CATEGORY : "creates (category.user)"
    USER ||--o{ PRODUCT  : "creates (product.user)"
    CATEGORY ||--o{ PRODUCT : "classifies (product.category)"
    ROLE }o..o{ USER : "lookup only: user.role (string) must equal a role.role"

    USER {
        string   name      "required"
        string   email     "required, unique (case-sensitive)"
        string   password  "required, bcrypt hash (':D' placeholder for Google users)"
        string   image     "local filename or Cloudinary URL"
        string   role      "required, default USER_ROLE, free string"
        boolean  state     "default true, soft delete flag"
        boolean  google    "default false"
    }
    ROLE {
        string role "required; no seed script exists"
    }
    CATEGORY {
        string   name   "required, unique, stored UPPERCASE"
        boolean  state  "default true"
        ObjectId user   "ref User, required"
    }
    PRODUCT {
        string   name        "required, unique, stored UPPERCASE"
        boolean  state       "default true"
        ObjectId user        "ref User, required"
        number   price       "default 0, no min"
        ObjectId category    "ref Category, required, existence not validated"
        string   description
        boolean  available   "default true"
        string   image
    }
```

- No timestamps on any schema. No indexes beyond the implicit `unique` ones.
- Soft delete (`state: false`) on User, Category, Product, but unique `name` indexes ignore state, so a deleted name can never be reused.
- JSON shape is inconsistent: User maps `_id → uid` and hides `password`/`__v`; Product hides `state`/`__v`; Category only disables `versionKey`.

### 1.6 Environment variables

| Variable | Read in | Required | Notes |
|---|---|---|---|
| `PORT` | `models/server.js` | no | Fallback `1500`; code comments and `public/js/auth.js` assume `4321` |
| `MONGO_CLOUD` | `database/config.js` | yes | Missing value causes an unhandled rejection at boot |
| `SECRET_KEY` | `helpers/generar-jwt.js`, `middlewares/validar-jwt.js` | yes | Not validated; missing value only surfaces at first login |
| `GOOGLE_CLIENT_ID` | `helpers/google-verify.js` | yes (Google login) | Also **hardcoded** in `public/index.html` |
| `GOOGLE_SECRET_ID` | — | no | Declared in `.example.env`, never used |
| `CLOUDINARY_URL` | `controllers/uploads.js` (implicitly by the SDK) | yes (media) | `cloudinary.config(process.env.CLOUDINARY_URL)` is a no-op getter call |

### 1.7 Dependencies

Resolved versions come from a fresh resolution of `package.json` ranges; the committed lockfile could not be read (OPS-01).

| Package | Declared | Resolved | Latest (2026-09-23) | Role | Audit |
|---|---|---|---|---|---|
| express | ^4.18.2 | 4.22.3 | 5.2.1 | HTTP framework | — |
| mongoose | ^7.5.0 | 7.8.12 | 9.10.2 | ODM | — |
| jsonwebtoken | ^9.0.2 | 9.0.3 | 9.0.3 | JWT | — |
| bcrypt | ^5.1.1 | 5.1.1 | 6.0.0 | Password hashing | pulls `@mapbox/node-pre-gyp` → `tar` (**critical**, install-time) |
| cloudinary | ^1.41.0 | 1.41.3 | 2.11.0 | Media storage | **high**: argument injection (GHSA-g4mf-96x5-5m2c) |
| express-fileupload | ^1.4.1 | 1.5.2 | 1.5.2 | Multipart parsing | — (misconfigured, see SEC-08) |
| express-validator | ^7.0.1 | 7.3.2 | — | Validation | — |
| cors | ^2.8.5 | 2.8.6 | — | CORS | — (open to all origins) |
| dotenv | ^16.3.1 | 16.6.1 | — | Env loading | — |
| uuid | ^9.0.1 | 9.0.1 | — | Upload filenames | **moderate** (GHSA-w5hq-g745-h8pq); replaceable by `crypto.randomUUID()` |
| google-auth-library | ^9.0.0 (**devDependency**) | 9.15.1 | 11.1.0 | Google ID token verification | Required at runtime but declared dev-only (OPS-02) |
| jest / supertest / nodemon | dev | 29.7 / 6.3 / 3.1 | — | Tooling | — |

**Security-related packages present:** `bcrypt`, `jsonwebtoken`, `google-auth-library`, `cors`, `express-validator`.
**Absent:** `helmet`, rate limiting, request size/file limits, NoSQL filter sanitisation (`mongoose.set('sanitizeFilter')`), structured logging with redaction.


### 1.8 State after M1 (release 2.0.0, 2026-09-24)

M1 changed the as-is state above in place. There was no restructuring (ADR-001); the layout of §1.2 is unchanged.

**Request pipeline** (`models/server.js`):
```
[trust proxy ← TRUST_PROXY] → helmet(CSP for GIS + Fonts, COOP same-origin-allow-popups, CORP cross-origin) → cors() → express.json()
  → express.static(public/) → router
      /api/auth/{login,google}: authLimiter (10 / 15 min / IP, shared) → validators → controller
      /api/uploads writes:      validarJWT → esAdminRole | esAdminOrOwner → param validators → fileParser (1 file, 5 MB,
                                per-request temp folder removed on close) → fileValid → controller
      other routes:             [validarJWT] → [esAdminRole | esAdminOrOwner | hasRole] → validators → controller
  → 404 {msg:'Route not found'} → error middleware (C1 + A1: 409 / 400 / client 4xx / 500, no internals)
```
Boot: `app.js` awaits the DB connection, then `listen`, and exits 1 on failure. `new Server()` has no side effects.

**Environment:** adds the optional `TRUST_PROXY` (a non-negative integer hop count; an invalid value stops the boot). `GOOGLE_SECRET_ID` is still unused and is removed in M2.

**Dependencies:** pnpm 12.3.4 (lockfile v9), `engines.node >=24`, bcrypt 6, cloudinary 2, google-auth-library 11 (runtime), `uuid` removed; new: `helmet` 8 and `express-rate-limit` 8, plus `mongodb-memory-server` 11 and supertest 7 in dev. `pnpm audit --prod`: **0 advisories** (was 48).

**Security packages present:** `bcrypt`, `jsonwebtoken`, `google-auth-library`, `cors` (still any origin, allowlist in M2), `express-validator`, **`helmet`**, **`express-rate-limit`**. Still absent until M2: `sanitizeFilter`/`strictQuery`, structured logging with redaction.

**Tests:** 101 Jest + supertest + mongodb-memory-server e2e tests across 9 files (the security regression suite), with one known flake (TEST-02, T1.8).

**Still open from the audit:** ARC-02 and ARC-03 (M2), and every M2+ item in TECH_DEBT.md.



### 1.9 State after M2 (release 2.1.0, 2026-09-24)

**Stack:** Node 24 · **TypeScript 6** (strict, CommonJS output; `src/` → `dist/`, ADR-017/018) for the platform, with the legacy JS unchanged behind one seam · **Express 5.2.1** · **Mongoose 9.10.2** (driver 7.6, MongoDB ≥ 4.4) · zod 4 (config) · pino + pino-http · Vitest 5 + supertest + mongodb-memory-server · ESLint 10 (layer rules) + Prettier · GitHub Actions CI.

**Boot:** `src/server.ts`: `loadConfig()` (fail fast, exit 1 listing every bad variable) → `createLogger` → `connectDatabase` (`strictQuery`, `sanitizeFilter`) → `createApp` → `listen`, with graceful SIGTERM/SIGINT shutdown (10 s drain).

**Pipeline** (`src/app.ts`): `[trust proxy]` → pino-http (request id) → helmet → cors (allowlist) → `express.json` → static `public/` → `src/legacy.ts` (`/hello` + 6 legacy routers, each behind `legacyBodyCompat`) → `notFound` → `errorHandler` (`toAppError`, `{ msg }` bodies until 3.0.0).

**Layout:** `src/{server,app,legacy}.ts`, `src/config/`, `src/core/{errors,http,logger}`, `src/middlewares/`, `src/database/`; `tests/{setup,helpers,unit,integration/{platform,security}}`. Legacy `routes/ controllers/ middlewares/ helpers/ models/` are unchanged except the §4.8 ledger lines of the M2 design. `app.js`, `models/server.js`, `database/` and `e2e/` are gone.

**Environment:** see `.example.env`. Required: `MONGO_CLOUD`, `SECRET_KEY`, `GOOGLE_CLIENT_ID`, `CLOUDINARY_URL`. Optional: `NODE_ENV`, `PORT`, `LOG_LEVEL`, `CORS_ORIGINS`, `TRUST_PROXY`.

**Next (M3):** replace each legacy area with a TS feature module under `src/modules/` (ADR-016), removing its `src/legacy.ts` entry, with zod DTOs and the 3.0.0 envelope.

---

## 2. To-be (target)

### 2.1 Principles

Clean Architecture boundaries, feature-first, SOLID/DRY/KISS/YAGNI. **An abstraction is added only when it removes existing duplication or enables a test that is otherwise impossible.** Everything else is YAGNI.

### 2.2 Target layout

```
src/
├── server.ts               # boot: load config → connect DB → createApp() → listen → graceful shutdown
├── app.ts                  # createApp(deps): composition root, wires modules, no side effects
├── config/                 # env schema (zod), typed config object, fail-fast on boot
├── core/                   # cross-cutting, framework-agnostic where possible
│   ├── errors/             # AppError hierarchy (NotFound, Conflict, Forbidden, Unauthorized, Validation)
│   ├── http/               # response envelope, pagination query schema + helper
│   ├── logger.ts           # pino instance (redacts authorization, password)
│   └── security/           # password hashing, JWT sign/verify, roles enum
├── middlewares/            # authenticate, authorize(policy), validate(schema), error-handler, not-found
├── database/               # connection, migrations, seed
└── modules/
    ├── auth/               # auth.routes · auth.controller · auth.service · auth.schemas · google.client
    ├── users/              # users.routes · users.controller · users.service · users.schemas · user.model
    ├── categories/         # …same anatomy
    ├── products/
    ├── search/             # search.routes · search.controller · search.service (no model of its own)
    └── media/              # media.routes · media.controller · media.service · cloudinary.client
tests/
├── integration/            # supertest against createApp() + mongodb-memory-server
├── unit/                   # services with injected fakes
└── helpers/                # factories, auth helpers, db lifecycle
```

### 2.3 Layer rules (enforced in review; lint rule in M2)

```
routes ──► controller ──► service ──► model (Mongoose) / external client
   │            │             │
   └─ validate(schema)        └─ throws AppError; never touches req/res
```

1. **Routes** declare path, middleware (`authenticate`, `authorize`, `validate`), and the controller. Nothing else.
2. **Controllers** translate HTTP ↔ service calls: read the validated DTO, call one service method, shape the response. No Mongoose, no business rules.
3. **Services** own business rules and persistence calls. They receive dependencies (models, clients, config) through a factory: `createUsersService({ User, passwordHasher, config })`. They throw `AppError`s and never import Express.
4. **Modules** never import another module's internals, only its service (via the composition root).
5. **Cross-cutting code** lives in `core/` and must not import from `modules/`.

---

## 3. ADR log

Status: **Accepted** = Orchestrator decision, binding on agents. **Proposed** = needs owner confirmation before its milestone starts.

| ID | Decision | Status | Rationale |
|---|---|---|---|
| ADR-001 | **Security hotfix (M1) ships before any refactor**, as minimal in-pattern changes to the current JS code | Accepted | The repo is public and a deployment URL is referenced in `public/js/auth.js`. Critical auth bypass and crash vectors can't wait for a restructure. |
| ADR-002 | **Migrate to TypeScript (strict)**, incrementally: `tsc` for typecheck/build, `tsx` for dev, `allowJs` during the transition (see ADR-016) | Accepted (owner delegated the decision 2026-09-23) | The mandate asks for type-safe interfaces. At ~1.5k LOC the migration is cheapest now; zod-inferred DTOs (ADR-006) and compile-checked contracts between parallel agents pay for it. |
| ADR-003 | **Upgrade to Express 5** in M2 | Accepted | Native promise-rejection forwarding removes a whole class of crash bugs (REL-01) with no `asyncHandler` wrapper. Deferred from M1 to keep the hotfix minimal. |
| ADR-004 | **No repository layer.** Services use Mongoose models directly, injected via factories | Accepted | Mongoose already is the data mapper; wrapping it adds a layer with no second implementation. Testability comes from `mongodb-memory-server` + DI. Revisit only if a second datastore appears. |
| ADR-005 | **DI by factory functions + one composition root** (`createApp`), no DI container library | Accepted | Explicit, zero-dependency, trivially testable. |
| ADR-006 | **zod schemas are the DTOs** (validation + inferred types + OpenAPI source); `express-validator` is removed in M3 | Accepted | One source of truth for shape, type, and docs (DRY). |
| ADR-007 | **Roles are a code-level enum**; the `Role` collection lookup is removed | Accepted | Roles are static. The DB lookup costs a query per validation and blocks onboarding on an unseeded DB (DB-01). |
| ADR-008 | **Cloudinary is the only media store**; local-disk upload/serve is removed in M3 | Accepted | Two strategies coexist and conflict (FUNC-01). Local disk breaks stateless containers (M9). |
| ADR-009 | **Single error model:** `AppError` hierarchy + one error middleware + one response envelope | Accepted | Replaces five different error shapes (REL-02, HTTP-01). |
| ADR-010 | **Auth transport `Authorization: Bearer`**; `x-token` accepted with a deprecation header for one major. Revocation via a `tokenVersion` claim. **No refresh tokens** (YAGNI) until a client needs long sessions | Accepted | Standard transport. Revocation without a new collection, since `validarJWT` already loads the user per request. |
| ADR-011 | **Logging:** pino + pino-http, request id, redaction of `authorization`/`x-token`/`password` | Accepted | Structured, fast, stdout-friendly for containers. |
| ADR-012 | **Package manager: pnpm**, pinned through `packageManager` + corepack; lockfile regenerated | Accepted | Keeps the existing choice and makes installs reproducible (OPS-01). |
| ADR-013 | **Tests are a gate in every milestone**, not a phase. Stack: Jest in M1 (existing), Vitest + supertest + mongodb-memory-server from M2 | Accepted | The refactor needs a safety net before it starts. |
| ADR-014 | **Node 24 LTS** is the runtime baseline (`engines`, `.nvmrc`, Docker base image) | Accepted | Current LTS, already installed locally. |
| ADR-015 | **API versioning by SemVer, not by URL.** The first release carrying breaking changes is `2.0.0`; no `/api/v1` prefix | Accepted | API consumers are unknown. A URL prefix would itself break every current client; CHANGELOG plus the API_PROGRESS ledger carry the contract. |
| ADR-016 | **Strangler migration.** M2 builds the TS platform (`src/config`, `src/core`, `src/app.ts`, `src/server.ts`) and mounts the legacy JS routers unchanged; M3 replaces each legacy area with a TS feature module, and legacy files are deleted when their module lands | Accepted | Every file is converted once, never twice. The M1 regression suite stays green at every step, giving each commit a safety net. |
| ADR-017 | **CommonJS output; `src/` → `dist/` build; legacy JS stays outside the build.** `src/legacy.ts` is the only TS→JS seam; legacy never requires `src/`. In M3, legacy reads TS-owned models from the Mongoose registry | Accepted 2026-09-23 (D2 review; details in [M2-foundation](docs/design/M2-foundation.md) §1.1) | Legacy `__dirname` paths keep working; one instance of every CJS package is shared by app, legacy and tests. ESM output is a separate decision after M3. |
| ADR-018 | **TypeScript 6.0.3**, not 7.x, until typescript-eslint supports 7; the tsconfig stays 7-clean | Accepted 2026-09-23 (D2 review; details in [M2-foundation](docs/design/M2-foundation.md) §1.1) | `typescript-eslint@8.70.1` caps TypeScript at `<6.1.0`. Revisit in M10 (Renovate). |
| ADR-019 | **Config:** one zod env schema, fail-fast at boot (exit 1, every bad variable listed); env names unchanged; empty = unset; `dotenv` → `node --env-file-if-exists`. Until M3, legacy JS reads only `SECRET_KEY`, `GOOGLE_CLIENT_ID`, `CLOUDINARY_URL` from `process.env` (lint allowlist). `TRUST_PROXY` (C9) is part of the schema | Accepted 2026-09-23 (D2 review; details in [M2-foundation](docs/design/M2-foundation.md) §1.1) | CFG-01 fixed for the platform in M2 and fully in M3. `GOOGLE_CLIENT_ID` is required, because an unset audience would accept any Google client's tokens. |
| ADR-020 | **Logging wiring:** pino-http is the first middleware, `x-request-id` in/out, one line per request with the error cause. Legacy logs only via `req.log`; `console.*` is a lint error | Accepted 2026-09-23 (D2 review; details in [M2-foundation](docs/design/M2-foundation.md) §1.1) | LOG-01 fixed in M2 with no AsyncLocalStorage and no new legacy imports. |
| ADR-021 | **Error bodies stay `{ msg }` in M2** (M1 C1/C2 byte-identical). `AppError`, `toAppError` and the envelope helpers ship in M2; the handler switches to `{ error: { code, message, details? } }` in M3 as part of **3.0.0** (ADR-024) | Accepted 2026-09-23 (D2 review; details in [M2-foundation](docs/design/M2-foundation.md) §1.1) | No two error shapes in one release. REL-02 fixed in M2; HTTP-01 in M3. |
| ADR-022 | **CORS allowlist via `CORS_ORIGINS`**; unset or `*` keeps any-origin, with a `warn` at production boot. Kept as written (D2 Q3): auth is a header token, never a cookie, and consumers are unknown | Accepted 2026-09-23 (D2 review; details in [M2-foundation](docs/design/M2-foundation.md) §1.1) | SEC-10 allowlist available; the M9 production checklist sets it. |
| ADR-023 | **No `vi.mock`** (it can't reach `require()` in legacy CJS): tests spy on the shared CommonJS instance via `tests/helpers/legacy.ts`. One process and one database per test file on a shared `mongod` | Accepted 2026-09-23 (D2 review; details in [M2-foundation](docs/design/M2-foundation.md) §1.1) | The M1 suite ports mechanically; files run in parallel safely. |
| ADR-024 | **Release mapping (SemVer, ADR-015).** M1 ships as **2.0.0** (breaking security fixes, releasable alone). M2 ships as **2.1.0** (operational and additive; operator objects in filters now get 400 as a security fix). The M3–M6 contract changes (envelope, status codes, `id`, Bearer auth, RBAC) are batched into **3.0.0**. Deprecated aliases (`uid`, `x-token`) are removed in **4.0.0**. Releases are git tags on `master` | Accepted 2026-09-23 (Orchestrator) | Clients migrate once per major. Erratum: D2's "2.0.0" for the envelope switch reads 3.0.0, and D4's "`uid` until 3.0.0" reads 4.0.0. Version numbers come from this mapping, not from commit markers: a `!` on an M2 dependency-upgrade commit (`build(deps)!:` for Express 5 and Mongoose 9) marks an internal breaking change for developers, not an API break. Release tooling (M10) must start from the `v2.1.0` tag. |
| ADR-025 | **Supply-chain age gate.** Keep pnpm 12's default `minimumReleaseAge` (24 h) and **never** add `minimumReleaseAgeExclude`. A dependency task pins only versions published at least 24 h earlier, or waits for the gate to clear, and proves it with a cold frozen install (empty store, state and cache) | Accepted 2026-09-24 (Orchestrator, from the T2.1 finding) | A fresh release is the classic window for a compromised package. The local verification cache hides violations, so the cold install is the only real proof. |
| ADR-026 | **Release lines.** `master` carries the released 2.x line (2.1.0), and a hotfix is cut from it as 2.1.x. The 3.0 line accumulates on a long-lived **`next`** branch. Each milestone M3–M6 integrates on its own `mN/*` branch, cut from `next`, and merges back into `next` when accepted. `next` merges into `master` as **3.0.0** after M6 (ADR-024). Security fixes land on `master` first and are merged forward into `next` | Accepted 2026-09-24 (Orchestrator) | Clients see one breaking release. `master` stays deployable and patchable throughout the M3–M6 rewrite. |
| ADR-027 | **Registry seam for migrated models.** The TS model is the sole `mongoose.model` registrant, behind an idempotent guard. The legacy `models/<x>.js` becomes a registry re-export. Cross-module models are resolved lazily or from the owning module | Accepted 2026-09-24 (D3 review; details in [M3-modules](docs/design/M3-modules.md) §1.1) | Removes `OverwriteModelError`/`MissingSchemaError` during the strangler (both reproduced). |
| ADR-028 | **Interim `authenticate` (x-token) and `requireAdmin` / `requireSelfOrAdmin` / `requireRole` guards** with today's semantics | Accepted 2026-09-24 (D3 review; details in [M3-modules](docs/design/M3-modules.md) §1.1) | M5 swaps the transport, M6 replaces the guards with `authorize(policy)`, and the route wiring doesn't change again. |
| ADR-029 | **zod DTOs and one `validate(part, schema)` middleware → 422 with `details`.** `express-validator` and `db-validators` are removed; existence checks become find-active-or-404 in services | Accepted 2026-09-24 (D3 review; details in [M3-modules](docs/design/M3-modules.md) §1.1) | Fixes VAL-01, VAL-02 and F3. Express 5 getter-only `query`/`params` are handled with `defineProperty`. |
| ADR-030 | **Media is Cloudinary only.** `POST /api/uploads` is removed. `GET` 302-redirects **only to this app's own Cloudinary cloud** (AM-M3-1), otherwise 404. Magic-byte MIME sniffing; parser errors → 400; oversize → 413 JSON; C10/C11 kept | Accepted 2026-09-24 (D3 review; details in [M3-modules](docs/design/M3-modules.md) §1.1) | Fixes FUNC-01, HTTP-02, F4 and SEC-08 (MIME). The allowlist prevents an open redirect from legacy `image` values. |
