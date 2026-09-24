# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).
Client-visible contract changes are always listed under **Breaking** and mirrored in [API_PROGRESS.md](API_PROGRESS.md).

## [Unreleased]

The 3.0 line accumulates on the `next` branch: M3–M6 ship together as **3.0.0** (ADR-024, ADR-026). `master` stays on 2.x for hotfixes.

### M4: Database (on `next`)

#### Added
- `createdAt` and `updatedAt` on every resource.
- Database migrations: `pnpm migrate up|down|status [--dry-run]`, an in-repo runner with a `migrations` ledger (M001–M004). Every migration aborts on its data check before writing.
- `pnpm seed`: a create-only, idempotent first-admin bootstrap from `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`.
- A hidden `tokenVersion` on users, in preparation for M5.

#### Changed
- Email is trimmed and lowercased, and matched **case-insensitively** at sign-up, login and Google sign-in. A case-variant duplicate sign-up is 409 `Email already registered`; look-alike characters are rejected with 422.
- Length limits: user `name` ≤ 120, `email` ≤ 254, category and product `name` ≤ 120, product `description` ≤ 2000. `price` must be ≥ 0. Anything outside these is 422.
- A name that only a soft-deleted category or product holds can be reused (**201**; 3.0-line M3 answered 409). An active duplicate is still 409, whatever its case.

#### Security
- The password hash is never selected unless a read asks for it (`select: false`). Login keeps one constant-time bcrypt check per attempt.
- Validation error messages never contain the rejected value, and rejected values and the seed secret are redacted from logs.

#### Removed (data)
- The 2.x `roles` collection (M004). Roles are a code enum (ADR-007).

#### Operational
- **Run `pnpm build && pnpm migrate up` to completion before the new code serves traffic.** Until M001 has normalized existing emails, a case-variant sign-up can create a second account and lock the original one out (M4 design §7.1 step 0).
- `autoIndex` is off in production: the migrations build every index.
- Back up before migrating: M001's `down` cannot restore the original email casing.

### M3: Feature modules and DTOs (on `next`)

#### Breaking
- **Response envelope.** Every success body is `{ "data": ... }`, and lists are `{ "data": [...], "meta": { "total", "limit", "offset" } }`. This replaces the bare document, `{ total, users }`-style lists, `{ user, token }` and `{ results }`. Every error body is `{ "error": { "code", "message", "details"? } }` instead of `{ "msg" }` (ADR-021).
- **Status codes.**
  - Reads return 200 (category and product reads returned 201).
  - Sign-up returns 201 (was 200).
  - DELETE returns **204** with no body (was 200/201 with a body; the `{ userDelete, userAuthenticated }` body is gone).
  - Invalid input returns **422** `VALIDATION_FAILED` with `details: [{ path, message }]` (was 400).
  - A missing or soft-deleted resource returns **404**.
- **Pagination.** A `limit` outside 1–50, or a non-integer `limit` or `offset`, returns 422. 2.x silently clamped it.
- **Ids.** Every resource has `id`; `_id` and `__v` are never exposed. Users keep `uid` as a deprecated alias of `id`, removed in 4.0.0.
- **Removed routes (404):** `GET /hello`, `PATCH /api/user` (a stub) and `POST /api/uploads` (local-disk upload, ADR-008/ADR-030).
- **Media.**
  - `GET /api/uploads/:collection/:id` now **302-redirects** to the record's image when it is an asset of this app's own Cloudinary cloud. Anything else (no image, another host, a Google avatar, a legacy filename) is 404. 2.x served a local file or a placeholder image.
  - `PUT /api/uploads/:collection/:id` accepts one PNG, JPEG or GIF, checked by content (anything else is 400). A malformed multipart body is 400, and a file over 5 MB is **413** with the JSON envelope.
- **Error codes.** Rate limiting is 429 `RATE_LIMITED`, with the envelope. A payload over a limit is 413 `PAYLOAD_TOO_LARGE`; JSON bodies over 100 kb now say `Payload too large` (was 413 `Invalid request data`).
- **Search** returns `{ "data": [...] }`, not `{ "results": [...] }`.

#### Added
- Product responses include `state`, as category and user responses do (AM-M3-9).

#### Changed
- An administrator's `PUT /api/user/:id` also reaches a soft-deleted user, so `state: true` reactivates it; every other read or write treats a soft-deleted resource as missing (AM-M3-7).

#### Removed
- Local-disk media: `uploads/`, `assets/notFound.jpg` and the 2.x upload helpers.
- The `Role` model. Roles are a code enum (`ADMIN_ROLE`, `USER_ROLE`, `VENTAS_ROLE`, ADR-007); nothing reads a 2.x `roles` collection any more, and M4 drops it.
- `express-validator`, the legacy JavaScript and the strangler seam.

#### Security
- The request body DTOs close mass assignment on products: `_id`, `user`, `image` and `state` are no longer writable (VAL-02). Non-string inputs are rejected with 422 instead of reaching the database (REL-01, F3).
- Media hardening:
  - uploads are checked by magic bytes, not extension (SEC-08);
  - the redirect only targets this app's own cloud, with an allowlisted path (AM-M3-1, no open redirect);
  - only an own-cloud previous image is ever destroyed;
  - the per-request temp folder is removed synchronously on every exit path.
- A signed token whose `uid` is not an ObjectId is a 401, not a 400.
- A rejected password never appears in validation error messages or logs (LOG-02).

#### Changed (internal)
- Feature-first TypeScript modules (`src/modules/{auth,users,categories,products,search,media}`), each composed as model → service → controller → routes, and wired in `createApp` (ADR-005, ADR-027…ADR-030). The legacy JavaScript, the strangler seam (`src/legacy.ts`) and `express-validator` are gone; the codebase is TypeScript only.
- One zod `validate(part, schema)` middleware replaces express-validator (ADR-029). Interim `authenticate` and role guards replace the legacy middlewares (ADR-028); the roles are a code enum (ADR-007), and the `Role` model is gone.
- Tests: 746 (was 248), including a contract test and service unit tests per module. `src/**` coverage is about 99 %.

## [2.1.0] - 2026-09-24 (M2: Foundation)

Internal platform release (ADR-024). The HTTP contract of 2.0.0 is unchanged, apart from the additive and security items below.

### Added
- `x-request-id` response header on every response: the inbound value when it matches `^[\w.:-]{1,128}$`, otherwise a generated UUID.
- `CORS_ORIGINS`: a comma-separated origin allowlist. Unset or `*` keeps any-origin, with a warning at production boot (ADR-022).
- Structured JSON logs (pino) on stdout: one line per request with `reqId`, and redaction of `x-token`, `authorization`, cookies and passwords (ADR-011, ADR-020).

### Security
- MongoDB filter hardening: `sanitizeFilter` and `strictQuery` are on, so operator objects in filter values (e.g. `{"email":{"$ne":null}}`) are rejected with **400** `Invalid request data` instead of matching (SEC-14).
- Boot fails fast when `GOOGLE_CLIENT_ID` is missing, because an unset ID-token audience would accept any Google client's tokens (ADR-019).
- Supply-chain age gate: dependency versions must be at least 24 h old, verified by a cold frozen install in CI (ADR-025).

### Changed (internal)
- The app boots from TypeScript: `src/server.ts` → `createApp` (`src/app.ts`), with the legacy JS routers mounted unchanged behind `src/legacy.ts` (ADR-016, ADR-017). ARC-02 and ARC-03 are resolved.
- **Express 5.2.1** (ADR-003) and **Mongoose 9.10.2**, plus the MongoDB driver 7.6. The only visible difference is lowercase `charset=utf-8` on static-file `Content-Type` headers.
- One error model (`AppError`, `toAppError`) behind the error middleware. Error bodies are byte-identical to 2.0.0 (`{ msg }`); the envelope switch is 3.0.0 (ADR-021).
- Graceful shutdown on SIGTERM/SIGINT: stop accepting connections, drain for up to 10 s, disconnect from MongoDB.
- Tests: the Jest suite is ported 1:1 to **Vitest** (248 tests: 104 security regression, 42 platform, 102 unit). `src/**` coverage is gated in CI.
- Tooling: TypeScript 6 strict, ESLint 10 with layer-boundary rules, Prettier, and a GitHub Actions workflow (format, lint, typecheck, build, test with coverage, `pnpm audit --prod`).
- Docs: M2 foundation and M4 database designs (`docs/design/`); ADR-017…ADR-025.

### Removed
- `app.js`, `models/server.js`, `database/config.js`, `jest`, `nodemon` and `dotenv` (replaced by `node --env-file-if-exists`). `GOOGLE_SECRET_ID` is dropped from `.example.env` (it was never read).

### Operational
- Build before start: `pnpm install --frozen-lockfile && pnpm build && pnpm start` (`start` runs `dist/server.js`).
- Required environment: `MONGO_CLOUD`, `SECRET_KEY`, `GOOGLE_CLIENT_ID`, `CLOUDINARY_URL`. Optional: `NODE_ENV`, `PORT`, `LOG_LEVEL`, `CORS_ORIGINS`, `TRUST_PROXY`. An invalid or missing value stops the boot with exit 1 and lists every offending variable.
- MongoDB server ≥ 4.4 is required (driver 7).
- Without a `.env` file, Node prints `.env not found. Continuing without it.` (harmless).

## [2.0.0] - 2026-09-24 (M1: Stabilization & Security Hotfix)

First release with breaking changes (ADR-015, ADR-024). Security fixes for the Critical and High issues in the M0 audit. The public repository carried exploitable issues; see TECH_DEBT.md SEC-01…SEC-08.

### Security
- `PUT /api/user/:id` requires a token and is owner-or-admin, with a field whitelist: account takeover closed (SEC-01).
- Sign-up ignores a client-supplied `role`, so there is no admin self-registration (SEC-02).
- Media writes require authentication (admin, or the owner for their own user image) (SEC-03).
- Image serving only returns bare filenames inside `uploads/<collection>/`: arbitrary file read closed (SEC-04).
- `GET /api/user` and user search are admin-only (SEC-05).
- Login and Google sign-in are rate-limited, 10 requests per 15 min per IP (SEC-06), and answer every credential failure with one generic 401 at one bcrypt check each, including unknown emails and Google-created accounts (SEC-07).
- Uploads: 5 MB limit, case-insensitive extension check, multipart parsed only on the two upload write routes after auth, one file per request, and a per-request temp folder removed on every exit path (SEC-08).
- Dependencies: 48 advisories (2 critical, 25 high) down to 0 (SEC-09). `helmet` security headers, and `x-powered-by` disabled (SEC-10).
- New `TRUST_PROXY` setting, so the rate limiter sees real client addresses behind a reverse proxy (SEC-15).

### Breaking
- `role` in the sign-up body is ignored; new users are always `USER_ROLE`.
- Authentication is required on `PUT /api/user/:id` (self or admin), `GET /api/user` (admin), `POST /api/uploads` (admin), `PUT /api/uploads/:collection/:id` (owner or admin for `user`, admin for `product`), and `GET /api/search/user/*` (admin).
- Non-admins can no longer change `role`, `state`, `email`, `image`, `google` or `_id` through `PUT /api/user/:id`; those fields are silently dropped.
- An insufficient role returns **403** (was 400/401). Every credential failure, a bad Google token and a blocked user return **401** `{"msg":"Invalid credentials"}` (was three 400 messages). More than 10 auth requests per 15 min per IP return **429**, with `RateLimit`/`RateLimit-Policy` headers; login and Google share that budget.
- Unknown routes return a JSON 404 `{"msg":"Route not found"}`. Unhandled errors return a JSON 500 `{"msg":"Internal server error"}` with no internals. A duplicate key returns 409, and invalid data (Mongoose validation/cast, malformed JSON, bad URL escapes) returns 400 `{"msg":"Invalid request data"}`.
- Search: the `role` collection is removed (400), there are at most 20 results, and terms match literally. List endpoints cap `limit` at 50 and coerce `limit`/`offset` to integers.
- Uploads over 5 MB return 413. Multipart bodies are ignored on every route except the two upload write routes (send JSON); a form-data `PUT /api/user/:id` returns 200 and changes nothing. At most one file per upload request.

### Fixed
- No request can crash the process any more: async handler errors are caught and forwarded (REL-01). Boot awaits the DB connection and exits 1 on failure (REL-03).
- Sign-up works on a database without `Role` documents (DB-01).
- Replacing an image uploads the new one, saves the record, and only then deletes the old Cloudinary asset (REL-04). The Cloudinary cleanup is awaited and non-fatal (CQ-04).
- Reproducible install: pnpm 12.3.4 pinned with a regenerated lockfile, `google-auth-library` moved to runtime dependencies, Node 24 (`engines`, `.nvmrc`) (OPS-01, OPS-02).

### Removed
- The unrouted `updateImage` handler (CQ-02, partial). The `uuid` dependency, replaced by `crypto.randomUUID()`.

### Tests
- Security regression suite (Jest + supertest + mongodb-memory-server): 101 tests across 9 files (TEST-01, M1 part).

### Operational
- Optional `TRUST_PROXY`: a non-negative integer hop count; an invalid value stops the boot. Set it to the real hop count behind any reverse proxy. Unset keeps `req.ip` as the socket address.
- No live deployment exists (the Zeabur deployment is retired). If an old database is reused, first run the T1.6 data check: `ADMIN_ROLE` users, and `image` values that aren't plain filenames or Cloudinary URLs.

## [1.0.4] - 2023-10-03
- Last tagged release (`v1.0.4`, commit `975fb4f`). Two UI/CSS commits followed on 2023-10-12 (`2f18dce` is the audit baseline). No changelog was kept before this point; `package.json` still reports `1.0.0`.
