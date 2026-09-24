# API Progress

> Baseline: commit `2f18dce` · Updated 2026-09-24 (M1 closed, release 2.0.0)
> Status legend: 🔴 blocking defect · 🟠 works with defects · 🟢 target met · ⚪ to remove
> Debt IDs link to [TECH_DEBT.md](TECH_DEBT.md).

## Route inventory (after M1, 2.0.0)

"Auth" = what is **enforced**, not what the comments claim. **Bold** = changed by M1.

| # | Method | Path | Auth today | Validation today | Handler | Issues | Status | Target |
|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/hello` | none | none | inline (`models/server.js`) | CQ-02 | ⚪ | Remove (M3); replaced by `/health` (M9) |
| 2 | POST | `/api/auth/login` | none; **rate-limited** 10 / 15 min / IP (shared with #3) | email, password non-empty | `auth.login` | PERF-01, SEC-11 | 🟠 | M5 (Bearer, async bcrypt) |
| 3 | POST | `/api/auth/google` | none; **rate-limited** (shared with #2) | `id_token` non-empty | `auth.googleSignin` | SEC-12 | 🟠 | M5 (`email_verified`, no placeholder password) |
| 4 | GET | `/api/user` | **JWT + admin** | none (limit/offset not validated) | `usuarios.getUsers` | VAL-01, HTTP-01 | 🟠 | M3 |
| 5 | POST | `/api/user` | none (public sign-up); **`role` ignored, always `USER_ROLE`** | name, password ≥8, email, email unique | `usuarios.postUser` | VAL-02, HTTP-01 | 🟠 | M3 |
| 6 | PUT | `/api/user/:id` | **JWT + owner-or-admin**; field whitelist | id, id exists, role (admin only) | `usuarios.putUser` | VAL-02 | 🟠 | M3 DTO, M6 policy |
| 7 | DELETE | `/api/user/:id` | JWT + `ADMIN_ROLE`\|`VENTAS_ROLE` (403 otherwise) | id, id exists | `usuarios.deleteUser` | SEC-13, CQ-05, HTTP-01 | 🟠 | M6 |
| 8 | PATCH | `/api/user` | none | none | `usuarios.usuariosPatch` (stub) | CQ-02 | ⚪ | Remove (M3) |
| 9 | GET | `/api/category` | none (public) | limit/offset coerced, `limit` ≤ 50 | `category.getCategory` | HTTP-01 | 🟠 | M3 |
| 10 | GET | `/api/category/:id` | none (public) | id exists → isMongoId | `category.getCategoryId` | VAL-01, HTTP-01 | 🟠 | M3 |
| 11 | POST | `/api/category` | JWT (any role) | name non-empty | `category.createCategory` (crash-safe) | VAL-02 (non-string name → 500), SEC-13 | 🟠 | M3 DTO; M6 policy |
| 12 | PUT | `/api/category/:id` | JWT + admin | name, id | `category.putCategory` | VAL-02 | 🟠 | M3 |
| 13 | DELETE | `/api/category/:id` | JWT + admin | id | `category.deleteCategory` | HTTP-01 | 🟠 | M3 |
| 14 | GET | `/api/product` | none (public) | limit/offset coerced, `limit` ≤ 50 | `product.getProducts` | HTTP-01 | 🟠 | M3 |
| 15 | GET | `/api/product/:id` | none (public) | id exists → isMongoId | `product.getProductId` | VAL-01, HTTP-01 | 🟠 | M3 |
| 16 | POST | `/api/product` | JWT (any role) | name non-empty | `product.createProduct` (crash-safe) | VAL-02 (mass-assigns `_id`/`image`) | 🟠 | M3 DTO |
| 17 | PUT | `/api/product/:id` | JWT + admin | name, id | `product.putProduct` | VAL-02 | 🟠 | M3 |
| 18 | DELETE | `/api/product/:id` | JWT + admin | id | `product.deleteProduct` | HTTP-01 | 🟠 | M3 |
| 19 | GET | `/api/search/:collection/:term` | category/product public; **user: JWT + admin** | collection ∈ {user, category, product}; term escaped; ≤ 20 results | `search.search` | PERF-02 (scan, accepted until the D4 trigger) | 🟠 | M3 module |
| 20 | POST | `/api/uploads` | **JWT + admin** | file (1, ≤ 5 MB), extension allow-list | `uploads.fileUpload` (local disk) | SEC-08 (MIME), HTTP-02 | 🟠 | M3 remove (ADR-008) |
| 21 | PUT | `/api/uploads/:collection/:id` | **JWT + owner-or-admin** (`product`: admin) | id, collection ∈ {user, product}, file (1, ≤ 5 MB) | `uploads.updateImageCloudinary` (upload → save → destroy) | HTTP-02, FUNC-01 | 🟠 | M3 media module |
| 22 | GET | `/api/uploads/:collection/:id` | none (public) | id, collection ∈ {user, product} | `uploads.showImage` (bare filename inside `uploads/<collection>/` only) | FUNC-01 | 🟠 | M3 redirect to URL |
| 23 | GET | `/` (static `public/`) | none | — | `express.static` | CQ-07 (dead demo URL) | 🟠 | M8 decide |

**Totals:** 23 entry points · 🔴 0 (was 9) · 🟠 20 · ⚪ 3 · 🟢 0

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
| M3 | Response envelope, correct status codes (GET 200, DELETE 204, validation 422), consistent `id` field, stub/debug routes removed | all |
| M5 | `Authorization: Bearer <token>`; `x-token` deprecated (still accepted, `Deprecation` header) | all authenticated |
