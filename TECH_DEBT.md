# Technical Debt Register

> Baseline: commit `2f18dce` · Audited 2026-09-23 · Milestone 0
> ⚠️ **Disclosure notice:** this repository is **public**. Don't push this file until the M1 hotfix is deployed wherever this code runs. It describes exploitable issues; exploit payloads are deliberately left out.

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
| High | 17 | M1 (12), M2–M3 (5) |
| Medium | 17 | M1 (partial) → M8 |
| Low | 5 | M1, M3, M5, M8 |
| **Total** | **44** | |

---

## Critical

| ID | Category | Issue | Location | Fix in | Status |
|---|---|---|---|---|---|
| SEC-01 | Security | **Unauthenticated account takeover.** `PUT /api/user/:id` has no authentication and mass-assigns the body. Anyone can set any user's password, role, email, state, or image, admins included. | `routes/usuarios.js:26-31`, `controllers/usuarios.js:40-58` | M1 | open |
| SEC-02 | Security | **Privilege escalation at sign-up.** Public `POST /api/user` accepts a client-supplied `role`, validated only for existence, so `ADMIN_ROLE` can be self-assigned. | `routes/usuarios.js:17-24`, `controllers/usuarios.js:26-30` | M1 | open |
| SEC-03 | Security | **Unauthenticated media writes.** `POST /api/uploads` writes to local disk, and `PUT /api/uploads/:collection/:id` replaces any user/product image and destroys the previous Cloudinary asset. Neither requires a token. | `routes/uploads.js:9,15`; `controllers/uploads.js:110-151` | M1 | open |
| SEC-04 | Security | **Arbitrary file read (chained).** `GET /api/uploads/:collection/:id` joins the stored `image` value into a filesystem path with no containment check and sends the file. Combined with SEC-01, which lets anyone write `image`, any non-dotfile readable by the process can be downloaded. | `controllers/uploads.js:97-104` | M1 | open |
| REL-01 | Reliability | **Remote process crash (DoS).** Express 4 does not catch rejected promises from async handlers, and Node ≥15 exits on unhandled rejections. Unauthenticated search can reach it with a term that isn't a valid regular expression, or with a well-formed id that doesn't exist (null dereference). Authenticated callers, and sign-up is open (SEC-02), reach it with product-name collisions that differ only in case (the duplicate check compares un-normalised names), with products missing a category, and through any DB error in create or upload handlers. | `controllers/search.js:14-108`, `controllers/product.js:46-68`, `controllers/category.js:44-65`, `controllers/uploads.js:29-151` | M1 | open |

## High

| ID | Category | Issue | Location | Fix in | Status |
|---|---|---|---|---|---|
| SEC-05 | Security / PII | Public `GET /api/user` lists every active user's name, email, and role. Public `GET /api/search/user/:term` allows regex enumeration over name/email. | `routes/usuarios.js:15`, `routes/search.js:9` | M1 (gate) → M6 | open |
| SEC-06 | Security | No brute-force protection on `/api/auth/login` or `/api/auth/google`, and no rate limiting anywhere. | `routes/auth.js` | M1 → M5 | open |
| SEC-07 | Security | User enumeration: login returns distinct messages for unknown email, disabled account, and wrong password, and returns early (timing). | `controllers/auth.js:13-32` | M1 | open |
| SEC-08 | Security | Upload hardening: no size limits; multipart parsed on **every** route to `/tmp`; temp files never removed after the Cloudinary upload; extension check is filename-based and case-sensitive; no MIME sniffing. | `models/server.js:57-61`, `helpers/upload-file.js:9-14`, `controllers/uploads.js:143-145` | M1 (limits, cleanup) → M3 (MIME) | open |
| SEC-09 | Security / Supply chain | Vulnerable dependencies: `cloudinary` <2.7.0 (high, argument injection), `tar` ≤7.5.20 via `bcrypt` → `@mapbox/node-pre-gyp` (critical, install-time), `uuid` <11.1.1 (moderate). | `package.json` | M1 | open |
| SEC-10 | Security | No HTTP hardening: no `helmet`, CORS open to all origins, `x-powered-by` exposed. | `models/server.js:47` | M1 (helmet) → M2 (CORS allowlist) | open |
| REL-02 | Reliability | No centralised error handling. There is no error middleware and no 404 handler. Five different error shapes. Raw Mongoose error objects are returned to clients. A failed `POST /api/user` returns **200 with an empty body** (`res.json(error.output)` where `output` is undefined). | all controllers; `controllers/usuarios.js:35-37` | M1 (middleware) → M2 (AppError) | open |
| REL-03 | Reliability | Boot sequence: the DB connection is fired from the constructor and never awaited, so the server accepts traffic before the DB is ready. A connection failure is an unhandled rejection with no diagnostics. No startup log, no graceful shutdown. | `models/server.js:30,39-41,79-82`, `database/config.js` | M1 (await + fail fast) → M9 (shutdown) | open |
| OPS-01 | Build | `pnpm-lock.yaml` is lockfile v6 and the installed pnpm 12 refuses to read it (`ERR_PNPM_BROKEN_LOCKFILE`). The package manager version isn't pinned, so installs aren't reproducible. | `pnpm-lock.yaml`, `package.json` | M1 | open |
| OPS-02 | Build | `google-auth-library` is a **devDependency** but is required at runtime. A production install (dev deps omitted) crashes on boot. | `package.json:35`, `helpers/google-verify.js:1` | M1 | open |
| TEST-01 | Testing | The test suite is non-functional: a `tobe` typo; it passes the `Server` instance instead of the Express app to supertest; the constructor connects to the real DB; a fixed port is bound in `beforeEach`; it queries an invalid ObjectId; it tests a route that doesn't exist (`GET /api/user/:id`); the other file is a placeholder. Effective coverage ≈ 0%. | `e2e/*.js` | M1 (regression suite) → M7 | open |
| ARC-01 | Architecture | No service layer. Fat controllers mix HTTP, business rules, persistence, and third-party calls (Cloudinary). | `controllers/*` | M3 | open |
| ARC-02 | Architecture | Layer-by-type layout. `Server` lives in `models/` and is exported as a model. App construction is coupled to DB connection and `listen`, which blocks integration testing. | `models/server.js`, `models/index.js` | M2 | open |
| FUNC-01 | Functional | `GET /api/uploads/:collection/:id` always returns the placeholder for Cloudinary-hosted images, because it path-joins a URL. Two storage strategies conflict. | `controllers/uploads.js:97-107` | M3 (ADR-008) | open |
| DB-01 | Database / Onboarding | Creating a user requires a matching `Role` document, but no seed exists. On a fresh DB, sign-up always fails. | `helpers/db-validators.js:3-9` | M1 (sign-up no longer takes role) → M4 (ADR-007) | open |
| CFG-01 | Config | No centralised or validated config. `process.env` is read ad hoc in 5 files, and a missing `SECRET_KEY` only surfaces at the first login. `.example.env` lists names only. `GOOGLE_SECRET_ID` is unused. | see ARCHITECTURE §1.6 | M2 | open |
| LOG-01 | Observability | No logging. `console.log` only, with no levels, no request logs or ids. `req.files` metadata is logged on every Cloudinary upload, and full stacks on every invalid token. | `controllers/uploads.js:143`, `middlewares/validar-jwt.js:41` | M2 | open |

## Medium

| ID | Category | Issue | Location | Fix in | Status |
|---|---|---|---|---|---|
| DUP-01 | Duplication | Duplicated logic: collection→model `switch` ×3 in `uploads.js`, plus search dispatch; `exist*ById` ×3; search functions ×3; paginated list ×3; soft delete ×3; `esAdminRole` ≡ `hasRole('ADMIN_ROLE')`; bcrypt hashing ×2; id validation chains ×6. | controllers/, helpers/, routes/ | M3 | open |
| VAL-01 | Validation | DB-existence checks run *before* `isMongoId` (extra query, duplicate errors). Search params, pagination (unbounded, non-numeric), product price/category/description, and PUT user fields are unvalidated. Soft-deleted categories are accepted as a product category and returned by `GET /:id`. The raw express-validator object is returned. | routes/*.js | M3 | open |
| VAL-02 | Validation | No DTOs: `...body` / `...data` spread into models, a mass-assignment surface on every write. | controllers/* | M3 | open |
| HTTP-01 | API contract | Status codes misused: GET and DELETE return 201; login failures return 400, not 401; insufficient role returns 400 or 401, not 403; validation returns 400, not 422. No response envelope. | controllers/*, `middlewares/validar-roles.js` | M1 (403) → M3 | open |
| SEC-11 | Security | JWT: custom `x-token` header instead of `Authorization: Bearer`; no revocation (logout, password change); expiry hardcoded to 4h; no `iss`/`aud`; secret strength not enforced. | `helpers/generar-jwt.js`, `middlewares/validar-jwt.js` | M5 | open |
| SEC-12 | Security | Google sign-in doesn't check `email_verified`, stores a placeholder non-hash password, reports every failure (including DB errors) as "invalid token", and auto-links to an existing password account by email. | `controllers/auth.js:50-86` | M5 | open |
| SEC-13 | Security | Authorization semantics: no ownership checks; route comments contradict the enforced rules; `VENTAS_ROLE` is referenced but never defined. | `routes/*.js`, `middlewares/validar-roles.js` | M6 | open |
| SEC-14 | Security | NoSQL filter hardening is off: `sanitizeFilter` not enabled, `strictQuery` set to `false`. | `database/config.js:4` | M2 | open |
| CFG-02 | Config | Hardcoded values: port fallback 1500 (docs assume 4321); `tempFileDir` `/tmp/`; JWT TTL `4h`; bcrypt cost 10 (×2); page size 5; Google client id in `public/index.html`; a production URL in `public/js/auth.js`; allowed extensions. | multiple | M2 | open |
| DB-02 | Database | No timestamps. Email not lowercased/trimmed, so case-duplicate accounts are possible. `role` is a free string. No `min` on price. A unique name combined with soft delete blocks re-creating a deleted name. Inconsistent id exposure (`uid` vs `_id`) and `toJSON` rules. | `models/*.js` | M4 | open |
| PERF-01 | Performance | `bcrypt.compareSync` blocks the event loop on every login. | `controllers/auth.js:27` | M5 | open |
| PERF-02 | Performance | Search uses unanchored case-insensitive regexes, which means a collection scan, with no result cap. Pagination `limit` is uncapped. Existence validators and controllers fetch the same document twice. | `controllers/search.js`, routes/* | M1 (cap + escape) → M3/M4 (indexes) | open |
| PERF-03 | Performance | No indexes on `state`, `category`, or `user` used by list and count queries. | `models/*.js` | M4 | open |
| DOC-01 | Documentation | No README, no OpenAPI spec, no setup guide, no error catalogue. | — | M8 | open |
| OPS-03 | DevOps | No lint/format config, no CI, no Dockerfile, no health endpoint, no `engines` / `.nvmrc`. Docker is not installed on the dev machine. | — | M1 (engines) → M2 / M9 / M10 | open |
| CQ-01 | Code quality | Mixed Spanish/English identifiers and messages; typos (`categoty`, "Takl", "valied", "Encript"); misleading comments ("physically eliminated" on a soft delete). | multiple | M3 | open |
| CQ-02 | Code quality | Dead code and placeholders: `updateImage` (unrouted), `usuariosPatch` stub route, debug `GET /hello`, `role` in search's permitted collections with no handler, unused imports. | `controllers/uploads.js:29-69`, `routes/usuarios.js:43`, `models/server.js:66-70`, `controllers/search.js:10` | M3 | open |

## Low

| ID | Category | Issue | Location | Fix in | Status |
|---|---|---|---|---|---|
| CQ-03 | Hygiene | Package metadata: name `07-restserver`, `main: index.js` (file doesn't exist), `repository` points to a different repo, no LICENSE file although MIT is declared. | `package.json` | M1 | open |
| CQ-04 | Hygiene | `cloudinary.config(process.env.CLOUDINARY_URL)` is a no-op getter call. `uploader.destroy` isn't awaited, so failures are silent. | `controllers/uploads.js:4,140` | M1 | open |
| CQ-05 | Hygiene | `deleteUser` returns the pre-update document and echoes the authenticated user object. | `controllers/usuarios.js:66-79` | M3 | open |
| CQ-06 | Hygiene | `googleSignin` error message typos; `Google` errors swallowed without a log. | `controllers/auth.js:68,82` | M5 | open |
| CQ-07 | Hygiene | `public/` demo page ships with a hardcoded client id and production URL; its ownership (keep as dev tool or remove) is undecided. | `public/` | M8 | open |
