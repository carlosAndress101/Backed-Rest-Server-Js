# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).
Client-visible contract changes are always listed under **Breaking** and mirrored in [API_PROGRESS.md](API_PROGRESS.md).

## [Unreleased]

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
