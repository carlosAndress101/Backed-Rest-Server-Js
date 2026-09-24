# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).
Client-visible contract changes are always listed under **Breaking** and mirrored in [API_PROGRESS.md](API_PROGRESS.md).

## [Unreleased]

### Added
- M2 foundation design (`docs/design/M2-foundation.md`) and M4 database design (`docs/design/M4-database.md`); ADR-017…ADR-025.

## [2.0.0] - pending (M1: Stabilization & Security Hotfix; release after the T1.5 review)

First release with breaking changes (ADR-015, ADR-024). Security fixes for the Critical and High issues in the M0 audit. The public repository carried exploitable issues; see TECH_DEBT.md SEC-01…SEC-08.

### Security
- `PUT /api/user/:id` requires a token and is owner-or-admin, with a field whitelist: account takeover closed (SEC-01).
- Sign-up ignores a client-supplied `role`, so there is no admin self-registration (SEC-02).
- Media writes require authentication (admin, or the owner for their own user image) (SEC-03).
- Image serving only returns bare filenames inside `uploads/<collection>/`: arbitrary file read closed (SEC-04).
- `GET /api/user` and user search are admin-only (SEC-05).
- Login and Google sign-in are rate-limited, 10 requests per 15 min per IP (SEC-06), and answer every credential failure with one generic 401, constant-time for unknown emails (SEC-07).
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
- Security regression suite (Jest + supertest + mongodb-memory-server): 95 tests across 9 files (TEST-01, M1 part).

### Operational
- Optional `TRUST_PROXY`: a non-negative integer hop count; an invalid value stops the boot. Set it to the real hop count behind any reverse proxy. Unset keeps `req.ip` as the socket address.
- No live deployment exists (the Zeabur deployment is retired). If an old database is reused, first run the T1.6 data check: `ADMIN_ROLE` users, and `image` values that aren't plain filenames or Cloudinary URLs.

## [1.0.4] - 2023-10-03
- Last tagged release (`v1.0.4`, commit `975fb4f`). Two UI/CSS commits followed on 2023-10-12 (`2f18dce` is the audit baseline). No changelog was kept before this point; `package.json` still reports `1.0.0`.
