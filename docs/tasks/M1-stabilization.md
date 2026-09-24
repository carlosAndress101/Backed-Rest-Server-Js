# M1: Stabilization & Security Hotfix · Delegation Briefs

> Issued by the Orchestrator · 2026-09-23 · Governing ADRs: ADR-001, ADR-012, ADR-013, ADR-014
> ⚠️ Public repo: push this file and TECH_DEBT.md only together with, or after, the M1 fix reaching `master`. There is no live deployment (owner, 2026-09-23: no longer on Zeabur).

## Ground rules for every agent

1. **Minimal, in-pattern changes.** This is a hotfix, not a refactor. Keep the existing file layout, CommonJS, naming, and code style. No renames, no new folders, no new abstractions except the ones explicitly listed.
2. **Touch only your Files Allowed.** If you believe another file must change, stop and raise it under **Questions**. Don't edit it.
3. **No new dependencies.** T1.1 installs everything M1 needs.
4. **Conventional commits**, one logical change per commit, and the debt IDs in the body (e.g. `fix(users): require auth on PUT /api/user/:id` / `Refs: SEC-01`).
5. **Never fix a bug you find outside your scope.** Report it.
6. **Local runtime:** Docker isn't installed. For a live Mongo, run `mongodb-memory-server` (installed by T1.1) from a scratch script outside the repo, and never commit it.
7. **Return format (mandatory):**
   ```
   ## Summary
   ## Files changed        (paste `git diff --stat <base>...HEAD`)
   ## Decisions made
   ## Risks
   ## Questions
   ## Acceptance checklist (every criterion: ✅/❌ + the command or test that proves it)
   ```

## Execution plan

Worktrees live under `~/Workspace/Nodeterm/worktrees/`; briefs and reports under `~/Workspace/Nodeterm/.orchestrator/`.

```
master ──► m1/stabilization (integration, includes M0 docs)
              │
              ├─► T1.1  BACKEND ENGINEER    (worktrees/m1-t1.1-build, branch m1/t1.1-build)                [first, alone]
              │        Orchestrator review + merge ─┐
              │                                     ├─► T1.2 SECURITY & QA AGENT (worktrees/m1-t1.2-access-control)   ┐
              │                                     ├─► T1.3 BACKEND ENGINEER    (worktrees/m1-t1.3-crash-safety)     ├ parallel, disjoint files
              │                                     └─► T1.4 DATABASE AGENT      (worktrees/m1-t1.4-regression-tests) ┘
              │        merge order: T1.3 → T1.2 → T1.4, then full suite
              ├─► T1.7 SECURITY & QA AGENT (worktrees/m1-t1.7-deploy-hardening)  [follow-up from the T1.2 review]
              └─► T1.5 ARCHITECT (read-only on m1/stabilization, after T1.7) → ACCEPT or RETURN per task
                        Orchestrator: docs update → milestone gate → owner approves push/PR
```

| Task | Assigned node | Agent CLI / model |
|---|---|---|
| T1.1, T1.3 | BACKEND ENGINEER | Claude Code · Opus 5.5 |
| T1.2, T1.7 | SECURITY & QA AGENT | Claude Code · Opus 5.5 |
| T1.4 | DATABASE AGENT | OpenCode · DeepSeek V4 Flash |
| T1.5 | ARCHITECT | Claude Code · Opus 5.5 |

## Shared contracts (binding across T1.2 / T1.3 / T1.4)

| ID | Contract | Owner | Consumers |
|---|---|---|---|
| C1 | **Error middleware** is registered last in `models/server.js` with signature `(err, req, res, next)`. Mapping: `err.code === 11000` → `409 {msg:'Resource already exists'}`; `err.name` `ValidationError` or `CastError` → `400 {msg:'Invalid request data'}`; anything else → `500 {msg:'Internal server error'}`. Log with `console.error(err)`, and never send stack traces or raw error objects to the client. Controllers pass failures with `next(err)`. **Amendment A1 (2026-09-23):** errors already flagged as client errors by Express or body-parser (`err.status` 4xx and `err.expose`, e.g. malformed JSON or a bad URL escape) keep their status and return `{msg:'Invalid request data'}`; they aren't logged as server errors. | T1.3 | T1.2, T1.4 |
| C2 | **404:** unknown routes → `404 {msg:'Route not found'}` (JSON), registered after the routers and before C1. | T1.3 | T1.4 |
| C3 | **Boot:** `new Server()` has **no side effects** (no DB connect). `server.app` is the Express instance. `app.js` does `await connection()` then `server.listen()`, and on failure runs `console.error` + `process.exit(1)`. Tests use `await connection()` from `database/config.js` with the memory-server URI in `MONGO_CLOUD`, then `request(new Server().app)`. | T1.3 | T1.4 |
| C4 | **AuthZ responses:** missing or invalid token → 401 (unchanged); insufficient role or not the owner → `403 {msg}`. | T1.2 | T1.3, T1.4 |
| C5 | **Credential failures:** unknown email, disabled user, and wrong password all return `401 {msg:'Invalid credentials'}`. More than **10 requests / 15 min / IP** on `POST /api/auth/login` or `POST /api/auth/google` → 429. | T1.2 | T1.4 |
| C6 | **User write policy.** `POST /api/user` ignores `role` and always stores `USER_ROLE`. `PUT /api/user/:id`: the owner may change `name`, `password`; an admin may additionally change `role` (must exist in `Role`) and `state`. `email`, `google`, `image`, `_id` are never writable here. Disallowed fields are **silently dropped**. `GET /api/user` is admin-only. | T1.2 | T1.4 |
| C7 | **Media write policy.** `POST /api/uploads` is admin-only. `PUT /api/uploads/user/:id` is owner or admin. `PUT /api/uploads/product/:id` is admin-only. `GET` stays public. | T1.2 | T1.4 |
| C8 | **Search policy.** `category` and `product` are public; `user` requires a token (401) and admin (403); `role` is no longer an allowed collection (400). Terms match **literally** (regex metacharacters escaped). At most **20** results. An id that doesn't exist → `200 {results: []}`. | T1.3 | T1.4 |
| C9 | **Proxy trust (added with T1.7).** The `TRUST_PROXY` env var is either unset/empty, which keeps Express's default (`req.ip` = socket address, `X-Forwarded-For` ignored), or a non-negative integer N, which runs `app.set('trust proxy', N)`. Any other value makes `new Server()` throw a clear error, so `app.js` exits 1. The C5 limiter keys on `req.ip`. | T1.7 | T1.7 tests |
| C10 | **Multipart scope (added with T1.7).** Multipart bodies are parsed **only** on `POST /api/uploads` and `PUT /api/uploads/:collection/:id`, and only after authentication, authorization and param validation pass. An unauthenticated, unauthorized or invalid request never writes a temp file. Every other route ignores multipart bodies. At most **1 file** per request. Every temp file a request writes is removed on **every** exit path (success, 400, 413, error), by one implementation. | T1.7 | T1.7 tests |
| C11 | **Image replacement order (added with T1.7).** `PUT /api/uploads/:collection/:id` uploads the new image, saves the record, and only then destroys the previous Cloudinary asset. That destroy is best-effort (logged, non-fatal). If the upload or the save fails, the record keeps its previous `image`, the previous asset is **not** destroyed, and the client gets a C1 JSON error. A new asset orphaned by a failed save is accepted and logged. | T1.7 | T1.7 tests |

---

## T1.1: Build & Dependency Repair
- **Agent:** BACKEND ENGINEER · **Worktree:** `worktrees/m1-t1.1-build` · **Branch:** `m1/t1.1-build` · **Debt:** OPS-01, OPS-02, SEC-09, CQ-03, OPS-03 (engines only)
- **Objective:** Make installs reproducible and production-safe, remove the known-vulnerable dependency versions, and pre-install everything M1 needs.
- **Files allowed:** `package.json`, `pnpm-lock.yaml`, `.nvmrc` (new), `LICENSE` (new), `helpers/upload-file.js` (**only** the `uuid` import and its one call site).
- **Files forbidden:** everything else.
- **Required changes:**
  1. Add `"packageManager": "pnpm@12.3.4"` and regenerate `pnpm-lock.yaml` with that pnpm.
  2. `engines.node: ">=24"`; `.nvmrc` = `24`.
  3. Move `google-auth-library` to `dependencies`. Upgrade to the latest major **only if** `OAuth2Client#verifyIdToken` / `ticket.getPayload()` are unchanged (cite the changelog); otherwise keep `^9` and record the residual advisory.
  4. `cloudinary` → `^2` (confirm `require('cloudinary').v2` still resolves); `bcrypt` → `^6` (drops `@mapbox/node-pre-gyp`/`tar`).
  5. Remove `uuid` and replace it with `crypto.randomUUID()` in `helpers/upload-file.js`.
  6. Add `helmet@^8` and `express-rate-limit@^8` to dependencies; add `mongodb-memory-server@^11` and upgrade `supertest` to `^7` in devDependencies.
  7. Metadata: `name: "backed-rest-server-js"`, `main: "app.js"`, `repository.url` → `git+https://github.com/carlosAndress101/Backed-Rest-Server-Js.git`. Add a MIT `LICENSE` (© 2023 Carlos Andres Hinestroza).
- **Acceptance criteria:**
  - [ ] On a clean checkout with Node 24: `pnpm install --frozen-lockfile` succeeds.
  - [ ] `pnpm audit --prod` reports **no high or critical** advisories; any remaining moderate one is listed under Risks.
  - [ ] After `pnpm install --prod`: `node -e "require('./models/server')"` exits 0 (no dev-only runtime imports).
  - [ ] `git diff --stat` shows only the allowed files. No script, route, or controller changes.
- **Deliverables:** branch `m1/t1.1-build`, report in the mandatory format including the before/after `pnpm audit` output.

## T1.2: Access Control & Auth Surface Hotfix
- **Agent:** SECURITY & QA AGENT · **Worktree:** `worktrees/m1-t1.2-access-control` · **Branch:** `m1/t1.2-access-control` (from integration **after T1.1**) · **Debt:** SEC-01, SEC-02, SEC-03, SEC-04, SEC-05 (users), SEC-06, SEC-07, SEC-08 (extension/cleanup), REL-01 (uploads), DB-01, HTTP-01 (403), CQ-04
- **Objective:** Close unauthenticated takeover, privilege escalation, media tampering, and file-read vectors; harden the login surface. Implements contracts C4–C7.
- **Files allowed:** `routes/usuarios.js`, `routes/uploads.js`, `routes/auth.js`, `controllers/usuarios.js`, `controllers/uploads.js`, `controllers/auth.js`, `helpers/upload-file.js`, `helpers/db-validators.js`, `middlewares/validar-roles.js`, `middlewares/index.js`, `middlewares/rate-limit.js` (new).
- **Files forbidden:** `models/**`, `app.js`, `database/**`, `controllers/{search,category,product}.js`, `routes/{search,category,products}.js`, `e2e/**`, `package.json`, `pnpm-lock.yaml`, all `*.md`.
- **Required changes:**
  1. **C6:** In `POST /api/user`, remove the `role` validator and force `USER_ROLE`. In `PUT /api/user/:id`, add `validarJWT` plus an owner-or-admin check, build the update from an explicit whitelist, make the `role` validator `.optional()` and apply it for admins only. Make `GET /api/user` require `validarJWT` + `esAdminRole`.
  2. **C7:** Add authentication and authorization to the upload write routes as specified.
  3. **SEC-04:** In `showImage`, serve a local file only if `image` is a bare filename (`path.basename(image) === image`) **and** the resolved path is inside `uploads/<collection>`; otherwise serve the placeholder.
  4. **Cloudinary flow:** `await` the `destroy` call and treat its failure as non-fatal (log it, continue). Delete the temp file in `finally`. Replace the no-op `cloudinary.config(...)` call. Remove `console.log(req.files)`.
  5. `helpers/upload-file.js`: compare extensions case-insensitively.
  6. **C5:** Add a rate limiter in `middlewares/rate-limit.js` (`express-rate-limit`, `standardHeaders: 'draft-7'`, `legacyHeaders: false`) on both auth routes. Use one generic 401 message for every credential failure.
  7. **C4:** `esAdminRole` and `hasRole` return 403.
  8. Every async handler in the owned controllers catches and forwards with `next(err)` (C1).
- **Acceptance criteria:**
  - [ ] Every C4–C7 rule holds (verified by T1.4 tests, plus your own curl evidence).
  - [ ] Sign-up works on a DB with **no** `Role` documents (DB-01).
  - [ ] A self-update that includes `role`/`state`/`email`/`image` leaves those fields unchanged.
  - [ ] A traversal-style `image` value stored directly in the DB yields the placeholder, while normal filenames are still served.
  - [ ] Temp upload files are gone after both a successful and a failed Cloudinary upload.
  - [ ] No unhandled promise rejection is possible from the owned handlers.
  - [ ] No files outside Files Allowed changed. No new dependencies.
- **Deliverables:** branch `m1/t1.2-access-control`, report in the mandatory format.

## T1.3: Crash-Safety, DoS & HTTP Hardening
- **Agent:** BACKEND ENGINEER · **Worktree:** `worktrees/m1-t1.3-crash-safety` · **Branch:** `m1/t1.3-crash-safety` (from integration **after T1.1**) · **Debt:** REL-01 (search/category/product), REL-02, REL-03, SEC-05 (search), SEC-08 (limits), SEC-10 (helmet), PERF-02 (escape, caps)
- **Objective:** Make the process impossible to crash from a request, fail fast on boot, and add baseline HTTP hardening. Implements contracts C1–C3 and C8.
- **Files allowed:** `models/server.js`, `app.js`, `database/config.js`, `controllers/search.js`, `controllers/category.js`, `controllers/product.js`, `routes/search.js`.
- **Files forbidden:** `routes/{usuarios,uploads,auth,category,products}.js`, `controllers/{usuarios,uploads,auth}.js`, `middlewares/**`, `helpers/**`, `models/{user,role,category,product,index}.js`, `e2e/**`, `package.json`, `pnpm-lock.yaml`, all `*.md`.
- **Required changes:**
  1. **C3:** Remove the DB connect from the constructor. `app.js` awaits the connection, then listens, and logs `Server listening on :<port>`; on failure it logs and exits 1.
  2. **C2 + C1:** Add the JSON 404 and the error middleware exactly as specified.
  3. **C8:** In `search.js`, `await` or `return` every branch, escape regex metacharacters (a local function, not a new file), cap results at 20, null-safe id lookups, and drop `role`. Gate the `user` collection in `routes/search.js` using the existing `validarJWT` / `esAdminRole`.
  4. `category.js` / `product.js`: no raw `error` objects in responses; every async handler forwards with `next(err)`. `createProduct` must uppercase the name **before** the duplicate lookup. List endpoints coerce `limit`/`offset` to integers and cap `limit` at 50.
  5. `helmet()`, configured so that (a) `public/index.html` still loads Google Identity Services (`accounts.google.com`) and Google Fonts; (b) images from `/api/uploads` can be embedded cross-origin (`crossOriginResourcePolicy: cross-origin`); (c) the Google sign-in popup keeps working (`crossOriginOpenerPolicy: same-origin-allow-popups`). Call `app.disable('x-powered-by')`.
  6. `fileUpload`: `limits: { fileSize: 5 * 1024 * 1024 }`, `abortOnLimit: true` (413), `tempFileDir: os.tmpdir()`.
- **Acceptance criteria:**
  - [ ] No request can terminate the process: invalid regex terms, a non-existent id in search, a case-variant duplicate product, a product without a category, and a forced DB error all get a JSON response, and the next request still succeeds.
  - [ ] Unknown routes → JSON 404. Errors never include a stack or raw Mongoose object.
  - [ ] With Mongo unreachable, `node app.js` logs the error and exits non-zero instead of listening.
  - [ ] An upload larger than 5 MB → 413.
  - [ ] The `/` demo page still works under the new headers. Evidence: the `Content-Security-Policy` header (via `curl -I`) allows `accounts.google.com`, `fonts.googleapis.com`, `fonts.gstatic.com`; plus a browser console check with no CSP violations if a browser tool is available.
  - [ ] No files outside Files Allowed changed. No new dependencies.
- **Deliverables:** branch `m1/t1.3-crash-safety`, report in the mandatory format.

## T1.4: Security Regression Suite
- **Agent:** DATABASE AGENT · **Worktree:** `worktrees/m1-t1.4-regression-tests` · **Branch:** `m1/t1.4-regression-tests` (from integration **after T1.1**; write against contracts C1–C8 while T1.2/T1.3 run) · **Debt:** TEST-01
- **Objective:** Executable proof that every M1 fix works and stays fixed.
- **Files allowed:** `e2e/**` (new helpers allowed), `jest-e2e.json`.
- **Files forbidden:** all application code, `package.json`, `pnpm-lock.yaml`, all `*.md`.
- **Required changes:**
  1. Delete `e2e/prueba.e2e.js` and replace the broken `e2e/user.e2e.js`.
  2. Harness: `mongodb-memory-server` (global setup/teardown via `jest-e2e.json`), `request(new Server().app)` per C3, the DB cleaned between tests, `Role` seeded where C6 needs it. Mock `cloudinary` and `helpers/google-verify`. Mint tokens with `generarJWT` rather than login, so the C5 limiter isn't consumed.
  3. One `describe` per debt ID, covering the rows of C4–C8, SEC-04, REL-01 (every trigger listed in T1.3), C1/C2, and a login-enumeration check (identical status and body across all three failure causes).
- **Acceptance criteria:**
  - [ ] `pnpm e2e` is green on `m1/stabilization` after T1.2 and T1.3 are merged, runtime under 60 s, no network apart from the one-time `mongod` download.
  - [ ] **Proof of detection:** run the suite against the T1.1-only integration commit and attach the failure list. Every SEC/REL test is expected to fail there.
  - [ ] Tests are deterministic (3 consecutive green runs).
  - [ ] No application file changed. If a test exposes a bug, report it; don't patch the app.
- **Deliverables:** branch `m1/t1.4-regression-tests`, report in the mandatory format including the proof-of-detection output.

## T1.7: Deploy Hardening Follow-up
- **Agent:** SECURITY & QA AGENT · **Worktree:** `worktrees/m1-t1.7-deploy-hardening` · **Branch:** `m1/t1.7-deploy-hardening` (from integration **after T1.2/T1.3/T1.4 merged**) · **Debt:** SEC-15 (new), SEC-08 (residual: pre-controller temp files), REL-04 (new), CQ-02 (`updateImage` only)
- **Origin:** the T1.2 report's Risks 1–4 and Q1–Q3. Without C9, behind any reverse proxy the C5 limiter puts every client in one bucket, which lets anyone lock all users out of login. There is no live deployment today (no longer on Zeabur), but C9 must exist before any proxied deploy (M9).
- **Objective:** Implements contracts C9–C11 and removes the unrouted `updateImage`.
- **Files allowed:** `models/server.js` (only the `fileUpload` mount and the `trust proxy` setting), `routes/uploads.js`, `controllers/uploads.js`, `middlewares/file-valid.js`, `middlewares/index.js`, `helpers/upload-file.js`, `e2e/**` (new test files, plus edits to `e2e/uploads.e2e.js` and `e2e/helpers/db.js` where the contracts require them).
- **Files forbidden:** everything else, including `app.js`, `database/**`, the other routes and controllers, `package.json`, `pnpm-lock.yaml`, `jest-e2e.json`, all `*.md`.
- **Required changes:**
  1. **C9:** Parse `TRUST_PROXY` in `models/server.js` exactly as C9 says. No new config module (that is M2).
  2. **C10:** Remove the global `fileUpload` from `models/server.js`. Mount it on the two upload write routes, **after** `validarJWT`, the authz middleware, the param validators and `validarCampos`, and **before** `fileValid`. Keep the current options (5 MB, `abortOnLimit`, `os.tmpdir()`) and add `limits.files: 1`. Define the options once, not per route. Every exit path after parsing removes the request's temp files, including a `fileValid` rejection. Use one shared removal function: the controllers must not keep a second copy.
  3. **C11:** Reorder `updateImageCloudinary` as specified.
  4. **CQ-02 (partial):** Delete `updateImage` and the commented-out `//], updateImage);` route line.
- **Acceptance criteria:**
  - [ ] C9: with `TRUST_PROXY=1`, two clients with different `X-Forwarded-For` values have independent limiter budgets. With it unset, rotating `X-Forwarded-For` still gets 429. `TRUST_PROXY` set to `abc`, `-1` or `true` makes `new Server()` throw.
  - [ ] C10: a multipart request to `POST /api/uploads` with no token, with a USER token, and a `PUT` with an invalid id each write **zero** temp files. So do multipart requests to `POST /api/auth/login` and `POST /api/user`. A `fileValid` rejection, an extension rejection, a 413 and a two-file request each leave zero temp files.
  - [ ] C11: when the upload fails, `destroy` is never called and `image` is unchanged. When the save fails, the old asset isn't destroyed. On success, `destroy` runs after `upload`, with the old public id.
  - [ ] The full `pnpm e2e` suite is green 3 times in a row, under 60 s. Existing tests are changed only where C10 changed the behaviour, and each such change is listed in the report.
  - [ ] No files outside Files Allowed changed. No new dependencies. No leftover debug logging.
- **Deliverables:** branch `m1/t1.7-deploy-hardening`, report in the mandatory format, plus the list of breaking changes (multipart on non-upload routes).

## T1.5: Independent Review (quality gate)
- **Agent:** ARCHITECT (**read-only**) · **Target:** `m1/stabilization` after all merges (T1.1–T1.4 and T1.7).
- **Objective:** Adversarially verify M1 before the Orchestrator accepts it.
- **Files allowed:** none (read-only; scratchpad for experiments).
- **Acceptance criteria / checks:**
  - [ ] Every acceptance criterion in T1.1–T1.4 has evidence.
  - [ ] Attempt to bypass each Critical fix (SEC-01…04, REL-01). Any success is an automatic RETURN.
  - [ ] Scope compliance: each branch's diff touches only its Files Allowed.
  - [ ] Quality gates: no new duplicated logic, no dead code, no leftover `console.log` debugging, no new dependencies outside T1.1, style consistent with the surrounding code.
- **Deliverables:** findings ranked by severity, and a verdict per task: **ACCEPT** or **RETURN** (with the exact criterion failed).

## T1.6: Milestone close (Orchestrator)
- Merge, update CHANGELOG (**Breaking** section from the API_PROGRESS ledger), mark the TECH_DEBT statuses, update the API_PROGRESS statuses, move ROADMAP to M2.
- Owner action, **only if the old production database (from the Zeabur deployment) still exists and will be reused**: list users with `role: ADMIN_ROLE` and users whose `image` isn't a plain filename or a Cloudinary URL, then review both lists with the Orchestrator. Otherwise there is nothing to check: the app has no live deployment (owner, 2026-09-23).
