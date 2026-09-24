# Technical Debt Register

> Baseline: commit `2f18dce` · Audited 2026-09-23 · Milestone 0
> ⚠️ **Disclosure notice:** this repository is **public**. There is no live deployment (owner, 2026-09-23: the app is no longer deployed on Zeabur), but the vulnerable code is still on public `master`. Push this file only together with, or after, the M1 fix reaches `master`. It describes exploitable issues; exploit payloads are deliberately left out.

**Severity**
- **Critical:** exploitable now, unauthenticated or near-unauthenticated, with full compromise or outage.
- **High:** serious security, reliability, or delivery risk.
- **Medium:** correctness, maintainability, or performance debt with bounded impact.
- **Low:** hygiene.

**Status:** `open` · `in-progress (Mx)` · `fixed (Mx, commit)` · `won't fix (ADR-x)`

## Summary

| Severity | Count | Target milestone(s) |
|---|---|---|
| Critical | 5 | M1 |
| High | 19 | M1 (13), M2–M3 (6) |
| Medium | 20 | M1 (partial) → M8 |
| Low | 7 | M1, M3, M5, M8 |
| **Total** | **51** | |

---

## Critical

| ID | Category | Issue | Location | Fix in | Status |
|---|---|---|---|---|---|
| SEC-01 | Security | **Unauthenticated account takeover.** `PUT /api/user/:id` has no authentication and mass-assigns the body. Anyone can set any user's password, role, email, state, or image, admins included. | `routes/usuarios.js:26-31`, `controllers/usuarios.js:40-58` | M1 | fixed (M1/T1.2, 00fe9b1) |
| SEC-02 | Security | **Privilege escalation at sign-up.** Public `POST /api/user` accepts a client-supplied `role`, validated only for existence, so `ADMIN_ROLE` can be self-assigned. | `routes/usuarios.js:17-24`, `controllers/usuarios.js:26-30` | M1 | fixed (M1/T1.2, 00fe9b1) |
| SEC-03 | Security | **Unauthenticated media writes.** `POST /api/uploads` writes to local disk, and `PUT /api/uploads/:collection/:id` replaces any user/product image and destroys the previous Cloudinary asset. Neither requires a token. | `routes/uploads.js:9,15`; `controllers/uploads.js:110-151` | M1 | fixed (M1/T1.2, 00fe9b1) |
| SEC-04 | Security | **Arbitrary file read (chained).** `GET /api/uploads/:collection/:id` joins the stored `image` value into a filesystem path with no containment check and sends the file. Combined with SEC-01, which lets anyone write `image`, any non-dotfile readable by the process can be downloaded. | `controllers/uploads.js:97-104` | M1 | fixed (M1/T1.2, 00fe9b1) |
| REL-01 | Reliability | **Remote process crash (DoS).** Express 4 does not catch rejected promises from async handlers, and Node ≥15 exits on unhandled rejections. Unauthenticated search can reach it with a term that isn't a valid regular expression, or with a well-formed id that doesn't exist (null dereference). Authenticated callers, and sign-up is open (SEC-02), reach it with product-name collisions that differ only in case (the duplicate check compares un-normalised names), with products missing a category, and through any DB error in create or upload handlers. | `controllers/search.js:14-108`, `controllers/product.js:46-68`, `controllers/category.js:44-65`, `controllers/uploads.js:29-151` | M1 | fixed (M1/T1.2 + T1.3, 00fe9b1 + 79def09) |

## High

| ID | Category | Issue | Location | Fix in | Status |
|---|---|---|---|---|---|
| SEC-05 | Security / PII | Public `GET /api/user` lists every active user's name, email, and role. Public `GET /api/search/user/:term` allows regex enumeration over name/email. | `routes/usuarios.js:15`, `routes/search.js:9` | M1 (gate) → M6 | M1 part fixed (users: T1.2 00fe9b1; search: T1.3 79def09); M6 open |
| SEC-06 | Security | No brute-force protection on `/api/auth/login` or `/api/auth/google`, and no rate limiting anywhere. | `routes/auth.js` | M1 → M5 | M1 part fixed (M1/T1.2, 00fe9b1); per-instance store and proxy trust → T1.7 (SEC-15), M5 open |
| SEC-07 | Security | User enumeration: login returns distinct messages for unknown email, disabled account, and wrong password, and returns early (timing). | `controllers/auth.js:13-32` | M1 | fixed (M1/T1.2 00fe9b1 + T1.2R 4752ae0: every failed login costs one cost-10 bcrypt check, including non-password accounts, which can never log in with a password) |
| SEC-08 | Security | Upload hardening: no size limits; multipart parsed on **every** route to `/tmp`; temp files never removed after the Cloudinary upload; extension check is filename-based and case-sensitive; no MIME sniffing. | `models/server.js:57-61`, `helpers/upload-file.js:9-14`, `controllers/uploads.js:143-145` | M1 (limits, cleanup) → M3 (MIME) | M1 part fixed: limits (T1.3 79def09); extension and cleanup (T1.2 00fe9b1); multipart only on upload write routes after auth, one file per request, per-request temp folder removed on every exit path (M1/T1.7, e0782fd). MIME check M3. The 413 body is `text/plain` until M3. |
| SEC-09 | Security / Supply chain | Vulnerable dependencies. The **committed lockfile** carried **48 advisories (2 critical, 25 high, 13 moderate, 8 low)**, measured with pnpm 8 by T1.1. They include `mongoose` <7.8.4 search injection (critical, GHSA-vg7j-7cwx-8wgw), `mongoose` `$nor` sanitizeFilter bypass (high), `tar` via `bcrypt` → `@mapbox/node-pre-gyp` (critical, install-time), `cloudinary` <2.7.0 argument injection (high), `jws`, `body-parser`, `path-to-regexp`, `validator`, `lodash` (high), and `uuid` (moderate). | `package.json`, `pnpm-lock.yaml` | M1 | fixed (M1/T1.1: 48 → 0 advisories) |
| SEC-10 | Security | No HTTP hardening: no `helmet`, CORS open to all origins, `x-powered-by` exposed. | `models/server.js:47` | M1 (helmet) → M2 (CORS allowlist) | fixed: helmet (M1 79def09); `CORS_ORIGINS` allowlist, production warning when unset (M2/T2.5, cdec304); set per deploy (M9 checklist) |
| REL-02 | Reliability | No centralised error handling. There is no error middleware and no 404 handler. Five different error shapes. Raw Mongoose error objects are returned to clients. A failed `POST /api/user` returns **200 with an empty body** (`res.json(error.output)` where `output` is undefined). | all controllers; `controllers/usuarios.js:35-37` | M1 (middleware) → M2 (AppError) | fixed: one `AppError` model + `toAppError` + one error middleware (T2.4 c281787, M2/T2.5, cdec304); C1/C2 bodies unchanged; envelope switch M3 (3.0.0) |
| REL-03 | Reliability | Boot sequence: the DB connection is fired from the constructor and never awaited, so the server accepts traffic before the DB is ready. A connection failure is an unhandled rejection with no diagnostics. No startup log, no graceful shutdown. | `models/server.js:30,39-41,79-82`, `database/config.js` | M1 (await + fail fast) → M9 (shutdown) | fixed: awaited connect + fail fast (M1 79def09); graceful SIGTERM/SIGINT shutdown with 10 s drain (M2/T2.5, cdec304) |
| OPS-01 | Build | `pnpm-lock.yaml` is lockfile v6 and the installed pnpm 12 refuses to read it (`ERR_PNPM_BROKEN_LOCKFILE`). The package manager version isn't pinned, so installs aren't reproducible. | `pnpm-lock.yaml`, `package.json` | M1 | fixed (M1/T1.1, e09da3f) |
| OPS-02 | Build | `google-auth-library` is a **devDependency** but is required at runtime. A production install (dev deps omitted) crashes on boot. | `package.json:35`, `helpers/google-verify.js:1` | M1 | fixed (M1/T1.1, 54e2515) |
| TEST-01 | Testing | The test suite is non-functional: a `tobe` typo; it passes the `Server` instance instead of the Express app to supertest; the constructor connects to the real DB; a fixed port is bound in `beforeEach`; it queries an invalid ObjectId; it tests a route that doesn't exist (`GET /api/user/:id`); the other file is a placeholder. Effective coverage ≈ 0%. | `e2e/*.js` | M1 (regression suite) → M7 | M1 part fixed (64-test regression suite, M1/T1.4, 5ed4efc); Vitest port M2, coverage M7 open |
| ARC-01 | Architecture | No service layer. Fat controllers mix HTTP, business rules, persistence, and third-party calls (Cloudinary). | `controllers/*` | M3 | open |
| ARC-03 | Architecture | **Circular require** `models/index` → `models/server` → `routes/*` → `controllers/uploads` / `helpers/index` → `helpers/db-validators` → `models/index`. It only works when entered via `models/server`. Entering via `models` first leaves the validators holding `undefined` models (`TypeError` in `esRoleValido`), and entering via `controllers/uploads` crashes on load. Found by T1.1. | `models/index.js:7`, `helpers/db-validators.js:1` | M2 (composition root; `Server` leaves `models/`) | fixed (M2/T2.5, cdec304): `Server` removed from `models/index.js`; every legacy module loads in any entry order |
| ARC-02 | Architecture | Layer-by-type layout. `Server` lives in `models/` and is exported as a model. App construction is coupled to DB connection and `listen`, which blocks integration testing. | `models/server.js`, `models/index.js` | M2 | fixed (M2/T2.5, cdec304): `src/app.ts` createApp (no I/O) + `src/server.ts` boot; `models/server.js` removed |
| FUNC-01 | Functional | `GET /api/uploads/:collection/:id` always returns the placeholder for Cloudinary-hosted images, because it path-joins a URL. Two storage strategies conflict. | `controllers/uploads.js:97-107` | M3 (ADR-008) | open |
| DB-01 | Database / Onboarding | Creating a user requires a matching `Role` document, but no seed exists. On a fresh DB, sign-up always fails. | `helpers/db-validators.js:3-9` | M1 (sign-up no longer takes role) → M4 (ADR-007) | M1 part fixed (M1/T1.2, 00fe9b1); Role → enum M4 open |
| CFG-01 | Config | No centralised or validated config. `process.env` is read ad hoc in 5 files, and a missing `SECRET_KEY` only surfaces at the first login. `.example.env` lists names only. `GOOGLE_SECRET_ID` is unused. | see ARCHITECTURE §1.6 | M2 | platform fixed (T2.4 c281787 + M2/T2.5, cdec304): zod env schema, fail-fast, `dotenv` removed; legacy JS still reads `SECRET_KEY`/`GOOGLE_CLIENT_ID`/`CLOUDINARY_URL` directly (lint allowlist) until M3 |
| LOG-01 | Observability | No logging. `console.log` only, with no levels, no request logs or ids. `req.files` metadata is logged on every Cloudinary upload, and full stacks on every invalid token. | `controllers/uploads.js:143`, `middlewares/validar-jwt.js:41` | M2 | fixed (M2/T2.5, cdec304): pino + pino-http with request id and redaction; legacy logs via `req.log`; `console.*` is a lint error |
| SEC-15 | Security / Availability | **Proxy trust not configured.** Behind any reverse proxy (PaaS ingress, load balancer, nginx), `req.ip` is the proxy's address, so the C5 auth limiter puts every client in one bucket: 10 auth requests per 15 min for everyone, and anyone can lock all users out of login. It blocks any proxied deploy; there is no live deployment today. Found in the T1.2 review. | `models/server.js` | M1 (T1.7, C9) → M2 (config) | fixed (M1/T1.7, e0782fd); moves into the M2 config schema (ADR-019) |

## Medium

| ID | Category | Issue | Location | Fix in | Status |
|---|---|---|---|---|---|
| DUP-01 | Duplication | Duplicated logic: collection→model `switch` ×3 in `uploads.js`, plus search dispatch; `exist*ById` ×3; search functions ×3; paginated list ×3; soft delete ×3; `esAdminRole` ≡ `hasRole('ADMIN_ROLE')`; bcrypt hashing ×2; id validation chains ×6. | controllers/, helpers/, routes/ | M3 | open |
| VAL-01 | Validation | DB-existence checks run *before* `isMongoId` (extra query, duplicate errors). Search params, pagination (unbounded, non-numeric), product price/category/description, and PUT user fields are unvalidated. Soft-deleted categories are accepted as a product category and returned by `GET /:id`. The raw express-validator object is returned. | routes/*.js | M3 | open |
| VAL-02 | Validation | No DTOs: `...body` / `...data` spread into models, a mass-assignment surface on every write. | controllers/* | M3 | open |
| HTTP-01 | API contract | Status codes misused: GET and DELETE return 201; login failures return 400, not 401; insufficient role returns 400 or 401, not 403; validation returns 400, not 422. No response envelope. | controllers/*, `middlewares/validar-roles.js` | M1 (403) → M3 | M1 part fixed (403, M1/T1.2, 00fe9b1); M3 open |
| SEC-11 | Security | JWT: custom `x-token` header instead of `Authorization: Bearer`; no revocation (logout, password change); expiry hardcoded to 4h; no `iss`/`aud`; secret strength not enforced. | `helpers/generar-jwt.js`, `middlewares/validar-jwt.js` | M5 | open |
| SEC-12 | Security | Google sign-in doesn't check `email_verified`, stores a placeholder non-hash password, reports every failure (including DB errors) as "invalid token", and auto-links to an existing password account by email. | `controllers/auth.js:50-86` | M5 | open |
| SEC-13 | Security | Authorization semantics: no ownership checks; route comments contradict the enforced rules; `VENTAS_ROLE` is referenced but never defined. | `routes/*.js`, `middlewares/validar-roles.js` | M6 | open |
| SEC-14 | Security | NoSQL filter hardening is off: `sanitizeFilter` not enabled, `strictQuery` set to `false`. | `database/config.js:4` | M2 | fixed (M2/T2.5, cdec304, commit f579b5f): `sanitizeFilter` + `strictQuery` on |
| CFG-02 | Config | Hardcoded values: port fallback 1500 (docs assume 4321); `tempFileDir` `/tmp/`; JWT TTL `4h`; bcrypt cost 10 (×2); page size 5; Google client id in `public/index.html`; a production URL in `public/js/auth.js`; allowed extensions. | multiple | M2 | open |
| DB-02 | Database | No timestamps. Email not lowercased/trimmed, so case-duplicate accounts are possible. `role` is a free string. No `min` on price. A unique name combined with soft delete blocks re-creating a deleted name. Inconsistent id exposure (`uid` vs `_id`) and `toJSON` rules. | `models/*.js` | M4 | open |
| PERF-01 | Performance | `bcrypt.compareSync` blocks the event loop on every login. | `controllers/auth.js:27` | M5 | open |
| PERF-02 | Performance | Search uses unanchored case-insensitive regexes, which means a collection scan, with no result cap. Pagination `limit` is uncapped. Existence validators and controllers fetch the same document twice. | `controllers/search.js`, routes/* | M1 (cap + escape) → M3/M4 (indexes) | M1 part fixed (escape + caps, M1/T1.3, 79def09); indexes M4 open |
| PERF-03 | Performance | No indexes on `state`, `category`, or `user` used by list and count queries. | `models/*.js` | M4 | open |
| DOC-01 | Documentation | No README, no OpenAPI spec, no setup guide, no error catalogue. | — | M8 | open |
| OPS-03 | DevOps | No lint/format config, no CI, no Dockerfile, no health endpoint, no `engines` / `.nvmrc`. Docker is not installed on the dev machine. | — | M1 (engines) → M2 / M9 / M10 | open |
| CQ-01 | Code quality | Mixed Spanish/English identifiers and messages; typos (`categoty`, "Takl", "valied", "Encript"); misleading comments ("physically eliminated" on a soft delete). | multiple | M3 | open |
| CQ-02 | Code quality | Dead code and placeholders: `updateImage` (unrouted), `usuariosPatch` stub route, debug `GET /hello`, `role` in search's permitted collections with no handler, unused imports. | `controllers/uploads.js:29-69`, `routes/usuarios.js:43`, `models/server.js:66-70`, `controllers/search.js:10` | M3 | `updateImage` removed (M1/T1.7, e0782fd); `usuariosPatch`, `/hello`, search `role` leftovers → M3 |
| REL-04 | Reliability | Image replacement destroys the old Cloudinary asset **before** uploading the new one. A failed upload or save leaves the record pointing at a deleted asset. Found in the T1.2 review. | `controllers/uploads.js` (`updateImageCloudinary`) | M1 (T1.7, C11) | fixed (M1/T1.7, e0782fd) |
| TEST-02 | Testing | Intermittent failure (about 1–2% of full runs, T1.5 finding F2): `image-replacement.e2e.js` gets a 401 for a freshly minted token. Fail-closed, test reliability only; it must be fixed before the suite becomes the CI gate and is ported (T2.6). | `e2e/` | M1 (T1.8) | fixed (M1/T1.8, 9727bca): root cause was a foreign local process answering on 127.0.0.1 (SuperTest bound bare apps to `::`); the harness now serves on 127.0.0.1. 250 consecutive green runs. Carried into M2 as P6 AM-5 |
| TEST-03 | Testing | Vitest runs files in parallel. T2.5's platform tests (`app.test.ts` ×2, `legacy-logs.test.ts` ×1) make successful `POST /api/uploads` requests that write `uploads/imgs/`, while `security/uploads.test.ts` owns that tree and resets it. About 2 in 15 full runs fail (`ENOTEMPTY` in `resetUploadDirs`, or 500 instead of 200). Test-only. | `tests/integration/platform/` | M2 (T2.5R) | in-progress (M2/T2.5R) |

## Low

| ID | Category | Issue | Location | Fix in | Status |
|---|---|---|---|---|---|
| CQ-03 | Hygiene | Package metadata: name `07-restserver`, `main: index.js` (file doesn't exist), `repository` points to a different repo, no LICENSE file although MIT is declared. | `package.json` | M1 | fixed (M1/T1.1, cddadd0) |
| CQ-04 | Hygiene | `cloudinary.config(process.env.CLOUDINARY_URL)` is a no-op getter call. `uploader.destroy` isn't awaited, so failures are silent. | `controllers/uploads.js:4,140` | M1 | fixed (M1/T1.2, 00fe9b1) |
| CQ-05 | Hygiene | `deleteUser` returns the pre-update document and echoes the authenticated user object. | `controllers/usuarios.js:66-79` | M3 | open |
| CQ-06 | Hygiene | `googleSignin` error message typos; `Google` errors swallowed without a log. | `controllers/auth.js:68,82` | M5 | open |
| CQ-07 | Hygiene | `public/` demo page ships with a hardcoded client id and production URL. That URL (`hookcoffee.zeabur.app`) is **dead**: the app is no longer deployed there (owner, 2026-09-23), so the page's Google sign-in fails anywhere except localhost. Its ownership (keep as dev tool or remove) is undecided. | `public/` | M8 | open |
| HTTP-02 | API contract | A malformed multipart body on an upload route (busboy "Unexpected end of form", "Malformed part header") carries no `status`, so C1 maps it to 500 instead of 400. It is reachable only after authentication (C10). Found in the T1.7 review. | `middlewares/file-valid.js` (`fileParser`), C1 | M3 (media module wraps parser errors in `BadRequestError`) | open |
| LOG-02 | Observability / PII | A Mongoose validator message containing `{VALUE}` (e.g. the default `minlength`) puts the rejected password into `err.message`/`err.stack`, which the `REDACT_PATHS` value paths don't cover. Not reachable today (only bcrypt hashes reach Mongoose; the only rule is `required`). Convention: password validators never use `{VALUE}`. Found in T2.4. | `models/user.js` → M3 `users.model.ts` | M3 (convention + unit test) | open |
