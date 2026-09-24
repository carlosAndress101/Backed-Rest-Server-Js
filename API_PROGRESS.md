# API Progress

> Baseline: commit `2f18dce` · Updated 2026-09-24 (M3 closed on `next`: the 3.0 line, unreleased; `master` is 2.1.0 and still serves the 2.x contract)
> Status legend: 🔴 blocking defect · 🟠 works with defects · 🟢 target met · ⚪ to remove · ✂️ removed
> Debt IDs link to [TECH_DEBT.md](TECH_DEBT.md). Contract source of truth: [docs/design/M3-modules.md](docs/design/M3-modules.md) §6.

## Route inventory (after M3, 3.0 line)

Every route is a TypeScript feature module (`src/modules/<feature>`). "Auth" = what is **enforced**. Every success body is `{ data }` or, for lists, `{ data, meta: { total, limit, offset } }`. Every error body is `{ error: { code, message, details? } }`.

| # | Method | Path | Auth | Request DTO (zod, 422 on failure) | Success | Issues | Status | Target |
|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/hello` | — | — | ✂️ 404 | — | ✂️ | Removed (CQ-02); `/health` in M9 |
| 2 | POST | `/api/auth/login` | none; rate-limited 10 / 15 min / IP (shared with #3) | `{ email, password }` | 200 `{ data: { token, user } }` | PERF-01, SEC-11 | 🟠 | M5 (Bearer, async bcrypt) |
| 3 | POST | `/api/auth/google` | none; rate-limited (shared with #2) | `{ id_token }` | 200 `{ data: { token, user } }` | SEC-12 | 🟠 | M5 (`email_verified`, no placeholder password) |
| 4 | GET | `/api/user` | JWT + admin | `?limit` 1–50 (default 5), `?offset` ≥ 0 | 200 page | — | 🟢 | — |
| 5 | POST | `/api/user` | none (public sign-up); always `USER_ROLE` | `{ name, email, password ≥ 8 }` | **201** `{ data: user }` | — | 🟢 | — |
| 6 | PUT | `/api/user/:id` | JWT + owner-or-admin | `{ name?, password?, role?, state? }`; `role`/`state` applied for admins only (`role` ∈ ROLES) | 200 `{ data: user }` | — | 🟢 | M6 `authorize(policy)` (AM-M3-7: an admin can reactivate a soft-deleted user) |
| 7 | DELETE | `/api/user/:id` | JWT + `ADMIN_ROLE`\|`VENTAS_ROLE` | `:id` | **204** | SEC-13 | 🟠 | M6 |
| 8 | PATCH | `/api/user` | — | — | ✂️ 404 | — | ✂️ | Removed (CQ-02) |
| 9 | GET | `/api/category` | none | pagination | 200 page | — | 🟢 | — |
| 10 | GET | `/api/category/:id` | none | `:id` (ObjectId) | 200 `{ data }` | — | 🟢 | — |
| 11 | POST | `/api/category` | JWT (any role) | `{ name }` | 201 `{ data }` | SEC-13 | 🟠 | M6 policy |
| 12 | PUT | `/api/category/:id` | JWT + admin | `{ name }` | 200 `{ data }` | — | 🟢 | — |
| 13 | DELETE | `/api/category/:id` | JWT + admin | `:id` | **204** | — | 🟢 | — |
| 14 | GET | `/api/product` | none | pagination | 200 page | — | 🟢 | — |
| 15 | GET | `/api/product/:id` | none | `:id` | 200 `{ data }` | — | 🟢 | — |
| 16 | POST | `/api/product` | JWT (any role) | `{ name, price?, category, description?, available? }` (no `_id`/`user`/`image`/`state`) | 201 `{ data }` | — | 🟢 | — |
| 17 | PUT | `/api/product/:id` | JWT + admin | the same fields, all optional | 200 `{ data }` | — | 🟢 | — |
| 18 | DELETE | `/api/product/:id` | JWT + admin | `:id` | **204** | — | 🟢 | — |
| 19 | GET | `/api/search/:collection/:term` | category/product public; user: JWT + admin (on the decoded param) | collection ∈ {user, category, product}, else 400 | 200 `{ data: [...] }` (≤ 20) | PERF-02 (scan, accepted until the D4 trigger) | 🟢 | M4 trigger |
| 20 | POST | `/api/uploads` | — | — | ✂️ 404 | — | ✂️ | Removed (ADR-008, ADR-030) |
| 21 | PUT | `/api/uploads/:collection/:id` | JWT + owner-or-admin (`product`: admin) | `:collection` ∈ {user, product}, `:id`; one PNG/JPEG/GIF ≤ 5 MB (magic bytes) | 200 `{ data: record }` | TEST-04 (test-only) | 🟢 | — |
| 22 | GET | `/api/uploads/:collection/:id` | none | `:collection`, `:id` | **302** to this app's own Cloudinary asset; otherwise 404 (AM-M3-1) | — | 🟢 | — |
| 23 | GET | `/` (static `public/`) | none | — | 200 | CQ-07 (dead demo URL) | 🟠 | M8 decide |

**Totals:** 23 entry points · 🔴 0 · 🟠 5 (was 20) · 🟢 15 (was 0) · ✂️ 3 removed (was ⚪ 3)

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
| M5 | `Authorization: Bearer <token>`; `x-token` deprecated (still accepted, `Deprecation` header) | all authenticated |
