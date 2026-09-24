# API Progress

> Baseline: commit `2f18dce` · Updated 2026-09-23 (Milestone 0)
> Status legend: 🔴 blocking defect · 🟠 works with defects · 🟢 target met · ⚪ to remove
> Debt IDs link to [TECH_DEBT.md](TECH_DEBT.md).

## Route inventory (as-is)

"Auth" = what is **enforced** today, not what the comments claim.

| # | Method | Path | Auth today | Validation today | Handler | Issues | Status | Target |
|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/hello` | none | none | inline (`models/server.js`) | CQ-02 | ⚪ | Remove (M3); replaced by `/health` (M9) |
| 2 | POST | `/api/auth/login` | none | email, password non-empty | `auth.login` | SEC-06, SEC-07, PERF-01 | 🟠 | M1 rate limit + generic errors; M5 |
| 3 | POST | `/api/auth/google` | none | `id_token` non-empty | `auth.googleSignin` | SEC-06, SEC-12 | 🟠 | M1 rate limit; M5 |
| 4 | GET | `/api/user` | **none** | none | `usuarios.getUsers` | SEC-05 | 🔴 | M1 admin-only |
| 5 | POST | `/api/user` | none (public sign-up) | name, password ≥8, email, email unique, role exists | `usuarios.postUser` | **SEC-02**, REL-02, DB-01 | 🔴 | M1 ignore client role |
| 6 | PUT | `/api/user/:id` | **none** | id, id exists, role exists | `usuarios.putUser` | **SEC-01**, VAL-02 | 🔴 | M1 JWT + self/admin + field whitelist |
| 7 | DELETE | `/api/user/:id` | JWT + `ADMIN_ROLE`\|`VENTAS_ROLE` | id, id exists | `usuarios.deleteUser` | SEC-13, CQ-05, HTTP-01 | 🟠 | M6 |
| 8 | PATCH | `/api/user` | none | none | `usuarios.usuariosPatch` (stub) | CQ-02 | ⚪ | Remove (M3) |
| 9 | GET | `/api/category` | none (public) | none (limit/offset unbounded) | `category.getCategory` | PERF-02, HTTP-01 | 🟠 | M3 |
| 10 | GET | `/api/category/:id` | none (public) | id exists → isMongoId | `category.getCategoryId` | VAL-01, HTTP-01 | 🟠 | M3 |
| 11 | POST | `/api/category` | JWT (any role) | name non-empty | `category.createCategory` | **REL-01** | 🔴 | M1 crash-safe; M6 policy |
| 12 | PUT | `/api/category/:id` | JWT + admin | name, id | `category.putCategory` | VAL-02 | 🟠 | M3 |
| 13 | DELETE | `/api/category/:id` | JWT + admin | id | `category.deleteCategory` | HTTP-01 | 🟠 | M3 |
| 14 | GET | `/api/product` | none (public) | none (limit/offset unbounded) | `product.getProducts` | PERF-02, HTTP-01 | 🟠 | M3 |
| 15 | GET | `/api/product/:id` | none (public) | id exists → isMongoId | `product.getProductId` | VAL-01, HTTP-01 | 🟠 | M3 |
| 16 | POST | `/api/product` | JWT (any role) | name non-empty | `product.createProduct` | **REL-01**, VAL-02 | 🔴 | M1 crash-safe; M3 DTO |
| 17 | PUT | `/api/product/:id` | JWT + admin | name, id | `product.putProduct` | VAL-02 | 🟠 | M3 |
| 18 | DELETE | `/api/product/:id` | JWT + admin | id | `product.deleteProduct` | HTTP-01 | 🟠 | M3 |
| 19 | GET | `/api/search/:collection/:term` | **none** | collection allow-list only | `search.search` | **REL-01**, SEC-05, PERF-02 | 🔴 | M1 escape + cap + `user` admin-only |
| 20 | POST | `/api/uploads` | **none** | file present | `uploads.fileUpload` (local disk) | **SEC-03**, SEC-08 | 🔴 | M1 admin-only; M3 remove (ADR-008) |
| 21 | PUT | `/api/uploads/:collection/:id` | **none** | file, id, collection ∈ {user, product} | `uploads.updateImageCloudinary` | **SEC-03**, SEC-08, REL-01 | 🔴 | M1 JWT + self/admin |
| 22 | GET | `/api/uploads/:collection/:id` | none (public) | id, collection ∈ {user, product} | `uploads.showImage` | **SEC-04**, FUNC-01 | 🔴 | M1 containment; M3 redirect to URL |
| 23 | GET | `/` (static `public/`) | none | — | `express.static` | CQ-07 | 🟠 | M8 decide |

**Totals:** 23 entry points · 🔴 9 · 🟠 11 · ⚪ 3 · 🟢 0

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
