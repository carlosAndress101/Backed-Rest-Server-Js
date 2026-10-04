# API Progress

> Baseline: commit `2f18dce` · Updated 2026-10-04 (M8: `/docs` added and the demo page removed, unreleased, planned as 3.1.0; M3–M7 released as 3.0.0 on 2026-10-03)
> Status legend: 🔴 blocking defect · 🟠 works with defects · 🟢 target met · ⚪ to remove · ✂️ removed
> Debt IDs link to [TECH_DEBT.md](TECH_DEBT.md). Contract source of truth: [docs/design/M3-modules.md](docs/design/M3-modules.md) §6.

## Route inventory (after M8, 3.x line)

Every route is a TypeScript feature module (`src/modules/<feature>`). "Auth" = what is **enforced**; "JWT" is `Authorization: Bearer <token>` (`x-token` is still accepted, deprecated, until 4.0.0). Every success body is `{ data }` or, for lists, `{ data, meta: { total, limit, offset } }`. Every error body is `{ error: { code, message, details? } }`. "Auth" is the M6 permission matrix ([M6-authz](docs/design/M6-authz.md) §2.2 as ruled in §11), enforced by one `authorize(policy)` and tested cell by cell (`tests/helpers/permission-matrix.ts`). 401 = no valid token; 403 = authenticated but not allowed (message `Not allowed`); 404 = missing or soft-deleted, whoever asks.

| # | Method | Path | Auth | Request DTO (zod, 422 on failure) | Success | Issues | Status | Target |
|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/hello` | — | — | ✂️ 404 | — | ✂️ | Removed (CQ-02); `/health` in M9 |
| 2 | POST | `/api/auth/login` | none; rate-limited 10 / 15 min / IP (shared with #3) **and** 10 / 15 min / account | `{ email, password }` | 200 `{ data: { token, user } }` | SEC-17 (targeted lockout, accepted) | 🟢 | — |
| 3 | POST | `/api/auth/google` | none; rate-limited (shared with #2) | `{ id_token }`; Google `email_verified` required | 200 `{ data: { token, user } }` | — | 🟢 | — |
| 4 | GET | `/api/user` | JWT + admin | `?limit` 1–50 (default 5), `?offset` ≥ 0 | 200 page | — | 🟢 | — |
| 5 | POST | `/api/user` | none (public sign-up); always `USER_ROLE` | `{ name, email, password ≥ 8 }` | **201** `{ data: user }` | — | 🟢 | — |
| 6 | PUT | `/api/user/:id` | JWT; self (id in either hex case) or `ADMIN_ROLE` | `{ name?, password?, role?, state? }`; `role`/`state` applied for admins only (`role` ∈ ROLES), but an admin may not change their **own** role or deactivate themself (403; resending the current values is accepted, ADR-042/AM-M6-3); `password` only as an admin reset of **another** user (revokes their tokens), else 422 (AM-M5-10); an admin can reactivate a soft-deleted user (AM-M3-7) | 200 `{ data: user }` | — | 🟢 | — |
| 7 | DELETE | `/api/user/:id` | JWT + `ADMIN_ROLE`; never your own account (403, ADR-042) | `:id` | **204** | — | 🟢 | — |
| 8 | PATCH | `/api/user` | — | — | ✂️ 404 | — | ✂️ | Removed (CQ-02) |
| 9 | GET | `/api/category` | none | pagination | 200 page | — | 🟢 | — |
| 10 | GET | `/api/category/:id` | none | `:id` (ObjectId) | 200 `{ data }` | — | 🟢 | — |
| 11 | POST | `/api/category` | JWT (any role; the caller is the creator) | `{ name }` | 201 `{ data }` | — | 🟢 | — |
| 12 | PUT | `/api/category/:id` | JWT + `ADMIN_ROLE`\|`VENTAS_ROLE` (categories are shared: no creator rights, AM-M6-2) | `{ name }` | 200 `{ data }` | — | 🟢 | — |
| 13 | DELETE | `/api/category/:id` | JWT + `ADMIN_ROLE`\|`VENTAS_ROLE` | `:id` | **204** | — | 🟢 | — |
| 14 | GET | `/api/product` | none | pagination | 200 page | — | 🟢 | — |
| 15 | GET | `/api/product/:id` | none | `:id` | 200 `{ data }` | — | 🟢 | — |
| 16 | POST | `/api/product` | JWT (any role; the caller is the creator) | `{ name, price?, category, description?, available? }` (no `_id`/`user`/`image`/`state`) | 201 `{ data }` | — | 🟢 | — |
| 17 | PUT | `/api/product/:id` | JWT + `ADMIN_ROLE`\|`VENTAS_ROLE` (any product), or the product's creator (ADR-041) | the same fields, all optional; the creator never changes | 200 `{ data }` | — | 🟢 | — |
| 18 | DELETE | `/api/product/:id` | JWT + `ADMIN_ROLE`\|`VENTAS_ROLE` (any product), or the product's creator | `:id` | **204** | — | 🟢 | — |
| 19 | GET | `/api/search/:collection/:term` | category/product public; user: JWT + admin (on the decoded param) | collection ∈ {user, category, product}, else 400 | 200 `{ data: [...] }` (≤ 20) | PERF-02 (scan, accepted until the D4 trigger) | 🟢 | M4 trigger |
| 20 | POST | `/api/uploads` | — | — | ✂️ 404 | — | ✂️ | Removed (ADR-008, ADR-030) |
| 21 | PUT | `/api/uploads/:collection/:id` | JWT; `user`: self (either hex case) or `ADMIN_ROLE`; `product`: `ADMIN_ROLE`\|`VENTAS_ROLE` (no creator rights) | `:collection` ∈ {user, product}, `:id`; one PNG/JPEG/GIF ≤ 5 MB (magic bytes) | 200 `{ data: record }` | TEST-04 (test-only) | 🟢 | — |
| 22 | GET | `/api/uploads/:collection/:id` | none | `:collection`, `:id` | **302** to this app's own Cloudinary asset; otherwise 404 (AM-M3-1) | — | 🟢 | — |
| 23 | GET | `/` (static `public/`) | — | — | ✂️ 404 | — | ✂️ | Removed (CQ-07, owner decision D1, ADR-050) |
| 24 | POST | `/api/auth/logout-all` | JWT | — | **204** | — | 🟢 | — |
| 25 | PUT | `/api/auth/password` | JWT | `{ currentPassword, newPassword }` (8 characters to 72 bytes) | 200 `{ data: { token } }` (a fresh token; every earlier one is revoked) | — | 🟢 | — |
| 26 | GET | `/docs` | none; mounted only when `DOCS_ENABLED` is on (default off in production, ADR-047) | — | 200 HTML (the Redoc page, with its own CSP, ADR-046); otherwise 404 | — | 🟢 | — |
| 27 | GET | `/docs/openapi.json` | none; the same flag | — | 200 the OpenAPI 3.1 document (`Cache-Control: no-cache`, ETag); otherwise 404 | — | 🟢 | — |

**Totals:** 27 entry points · 🔴 0 · 🟠 0 (after M6: 1) · 🟢 23 (after M6: 21) · ✂️ 4 removed

## Planned contract changes (breaking-change ledger)

Every change clients can observe is listed here before it ships, and in CHANGELOG under **Breaking**.

| Milestone | Change | Affected routes |
|---|---|---|
| M1 | `role` in the sign-up body is ignored; new users are always `USER_ROLE` | #5 |
| M1 | Authentication required: `PUT /api/user/:id` (self or admin), `GET /api/user` (admin), uploads write routes, `GET /api/search/user/*` (admin) | #4, #6, #19, #20, #21 |
| M1 | Non-admin callers can no longer change `role`, `state`, `email`, `image` through `PUT /api/user/:id` | #6 |
| M1 | Insufficient role returns **403** (was 400 / 401). Credential failures return **401** with one generic message (was three 400 messages). Too many login attempts return **429** | #2, #3, #7, #12, #13, #17, #18 |
| M1 | Unknown routes return a JSON 404; unhandled errors return a JSON 500 with no internals; duplicate keys return 409 | all |
| M1 | A bad Google token and a blocked Google user both return **401** `Invalid credentials` (was 400 / a distinct 401). Login and Google share one limiter budget of 10 requests / 15 min / IP, with `RateLimit` / `RateLimit-Policy` headers | #2, #3 |
| M1 | Search: the `role` collection is removed (400); at most 20 results; terms match literally. List endpoints cap `limit` at 50 and coerce `limit`/`offset` to integers | #9, #14, #19 |
| M1 | Uploads larger than 5 MB return 413 | #20, #21 |
| M1 (T1.7) | Multipart bodies are parsed **only** on the upload write routes, and only after auth; elsewhere they are ignored (send JSON). Note that a form-data `PUT /api/user/:id` returns 200 and changes nothing. At most one file per upload request (extra files are ignored). On `PUT /api/uploads/:collection/:id`, an invalid `id`/`collection` gets its validator 400 before the missing-file 400 | all except #20, #21 |
| M1 (T1.7) | Operational: the optional `TRUST_PROXY` (non-negative integer hop count) sets Express `trust proxy`; an invalid value stops the boot (exit 1). Set it to the real hop count behind any reverse proxy | — |
| M2 | **Additive:** every response carries `x-request-id` (a valid inbound id is echoed, otherwise a generated UUID) | all |
| M2 | **Security:** operator objects in filter values (e.g. `{"email":{"$ne":null}}`) now return **400** `Invalid request data` (`sanitizeFilter`, SEC-14) | all with a body or query filter |
| M2 | `CORS_ORIGINS` allowlist (optional; unset keeps any origin). Static files send a lowercase `charset=utf-8` (Express 5) | all · `/` |
| M3 | **Envelope:** success `{ data }` / `{ data, meta: { total, limit, offset } }` (was the bare document, `{ total, <plural> }`, `{ user, token }`, `{ results }`); errors `{ error: { code, message, details? } }` (was `{ msg }`) | all |
| M3 | **Status codes:** GET 200 (was 201 on category/product reads), POST 201 (sign-up was 200), DELETE **204** with no body (was 201/200 with a body), validation **422** `VALIDATION_FAILED` with `details` (was 400), missing or soft-deleted **404** | all |
| M3 | **Pagination:** `limit` outside 1–50, or a non-integer `limit`/`offset`, is **422** (2.x clamped it) | #4, #9, #14 |
| M3 | **Ids:** every resource has `id`; `_id` and `__v` are never exposed; users keep `uid` as a deprecated alias (removed in 4.0.0). **Additive:** product responses now include `state` (AM-M3-9) | all |
| M3 | **Removed:** `GET /hello`, `PATCH /api/user`, `POST /api/uploads` (404) | #1, #8, #20 |
| M3 | **Media:** `GET /api/uploads/:collection/:id` **302-redirects** to the record's Cloudinary asset of this app's own cloud, anything else is 404 (was an image file or a placeholder); uploads must be PNG, JPEG or GIF by content (400 otherwise); a malformed multipart body is **400**; a file over 5 MB is **413** with the JSON envelope; an admin-only `product` target and an owner-or-admin `user` target are checked before the body is read | #21, #22 |
| M3 | **Error codes:** 429 is `RATE_LIMITED`; 413 is `PAYLOAD_TOO_LARGE` (JSON over 100 kb now says `Payload too large`) | #2, #3, #21, all JSON bodies |
| M3 | **Search:** `{ data: [...] }` (was `{ results: [...] }`) | #19 |
| M4 | **Additive:** every resource carries `createdAt` and `updatedAt` | all resource responses |
| M4 | **Email** is stored and returned trimmed and lowercased, and matched case-insensitively at sign-up, login and Google sign-in; a case-variant duplicate is **409** `Email already registered` | #2, #3, #4–#6 |
| M4 | **Limits:** user `name` ≤ 120, `email` ≤ 254, category/product `name` ≤ 120, product `description` ≤ 2000, `price` ≥ 0; anything else is **422** | #5, #6, #11, #12, #16, #17 |
| M4 | **Reusable names:** a name that only a soft-deleted category or product holds can be used again: **201** (M3 answered 409). Active duplicates stay 409, whatever the case | #11, #16 |
| M4 | **Operational:** `pnpm migrate up` must complete **before** the M4 code serves traffic (M4 design §7.1 step 0); `pnpm seed` bootstraps the first admin from `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` | — |
| M5 | **Tokens:** every token issued before M5 is refused (401) on deploy; tokens now carry `iss`, `aud` and `tv`, HS256 only. Sign in again | all authenticated |
| M5 | **Transport:** `Authorization: Bearer <token>` (scheme case-insensitive). `x-token` is read only when there is no `Authorization` header, and its responses carry `Deprecation: true`; a malformed `Authorization` is 401 with no fallback. `x-token` is removed in 4.0.0 | all authenticated |
| M5 | **Passwords:** 8 characters to 72 UTF-8 bytes; longer is **422** (was silently truncated) | #5, #6, #25 |
| M5 | **Google:** an unverified address, or an address that belongs to a password account, is the generic **401** (2.x signed the caller into that account) | #3 |
| M5 | **Own password:** `PUT /api/user/:id` with a `password` for your own account is **422**, for every role; use `PUT /api/auth/password`. An admin reset of another user's password signs that user out everywhere (AM-M5-10) | #6 |
| M5 | **Added:** `POST /api/auth/logout-all` (204) and `PUT /api/auth/password` (200 `{ data: { token } }`); login is also limited per account (429 `RATE_LIMITED`) | #2, #24, #25 |
| M5 | **Operational:** `SECRET_KEY` must be at least 32 characters or the boot fails; every session ends at the deploy; `pnpm migrate up` runs M005/M006 (M5 design §10.1) | — |
| M6 | **`VENTAS_ROLE` is the catalog manager:** it may update and delete any product or category and replace a product image (was 403); it can no longer delete a user (**403**, was 204) | #7, #12, #13, #17, #18, #21 |
| M6 | **Product ownership:** a product's creator may update and delete their own active product (200/204, was 403). Categories stay `ADMIN_ROLE`/`VENTAS_ROLE` only. Editing a product or category no longer makes the editor its creator | #12, #13, #17, #18 |
| M6 | **Self-lockout guard:** an administrator can no longer change their own role or deactivate themself through `PUT /api/user/:id` (**403**; resending the current values is accepted), and nobody can delete their own account (**403**) | #6, #7 |
| M6 | **Messages and order:** every authorization 403 says `Not allowed` (product ownership: `Only the creator, an administrator or VENTAS_ROLE may …`). A non-creator's product `PUT`/`DELETE` with a malformed id is **422** (was 403), and with a missing `category` 404 (AM-M6-8). A request on your own account with an upper-case id is accepted (was 403, AM-M6-7) | #4, #6, #7, #12, #13, #17, #18, #19, #21 |
| M8 | **Removed:** `GET /` no longer serves the `public/` demo page (**404**). Its Google sign-in allowances leave the global headers: every response now carries helmet's default CSP and `Cross-Origin-Opener-Policy: same-origin`; `Cross-Origin-Resource-Policy: cross-origin` stays (ADR-050) | #23, all |
| M8 | **Added:** `GET /docs` and `GET /docs/openapi.json`, mounted only when `DOCS_ENABLED` is on (default off in production) | #26, #27 |
