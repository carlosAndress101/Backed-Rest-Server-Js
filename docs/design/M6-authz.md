# M6 — Authorization (RBAC + Ownership) Design

> Milestone **M6 (Authorization)** · Design only — no code in this document is executed by the M6 design task.
> Prepared by the ARCHITECT · 2026-09-24 · Base: `next` @ `51fc0b5` (M5 accepted and merged, 1109 tests).
> Governing ADRs: **ADR-004** (no repository layer; services own persistence), **ADR-005** (DI factories, one composition root), **ADR-007** (roles as a code enum), **ADR-024/026** (release mapping and lines — M6 is the **last** milestone before 3.0.0 ships from `next`), **ADR-025** (supply-chain age gate: prefer no new dependency), **ADR-028** (the interim guards this design replaces), **ADR-032/033** (`authenticate`, `tokenVersion`, both unchanged by M6).
> Debt closed or advanced: **SEC-13** (M6, in full).

Two mechanics below are marked **[P#]**, measured directly against this branch's real dependencies (Mongoose 9.10.2, Express 5.2.1), not assumed.

---

## 0. Scope, assumptions, non-goals

**Assumes M5 has landed.** `authenticate` re-reads `role` and `state` from the database on every request (never from the token); `tokenVersion` revocation exists; the three interim guards (`requireAdmin`, `requireSelfOrAdmin`, `requireRole`) are stateless and imported directly by each `*.routes.ts` file (AM-M3-8).

**In scope (M6 deliverables):**
- One `authorize(policy)` middleware, replacing `requireAdmin`, `requireSelfOrAdmin` and `requireRole` on every route (SEC-13).
- A permission matrix, one row per route, one column per role plus anonymous and owner, published in API_PROGRESS.md and enforced by a matrix-driven test.
- Ownership rules for products and categories (today admin-only writes, despite any authenticated role being allowed to *create* one).
- A definition for `VENTAS_ROLE` (today referenced, never defined — SEC-13's own words).
- Consistent 401/403/404 semantics, decided once and applied everywhere.
- A fix for the last-administrator lockout risk on `PUT /api/user/:id` and `DELETE /api/user/:id`.
- 3.0.0 release readiness: the consolidated CHANGELOG entry, the full migration order, the combined deploy runbook, and what must not ship.

**Out of scope (scope fences, per the brief):**
- **M7** owns broad test hardening; M6 ships exactly one test per matrix cell, not a coverage campaign beyond that.
- **M8** owns OpenAPI and the `public/` demo page decision (CQ-07).
- **M9** owns the multi-instance rate-limiter store, the production boot guard (OPS-05) and SEC-17 (targeted lockout).
- Authentication mechanics (transport, tokens, passwords, Google, rate limits) — unchanged from M5.
- A new self-service account-deletion feature, or a new "link my Google account" flow — neither is requested here.

**Principles applied (ARCHITECTURE §2.1):** no new dependency (ADR-025) — `authorize(policy)` is native Express middleware, same shape as the guards it replaces. No CASL, no casbin: a permission matrix this small (25 routes × 3 roles × an ownership axis) is a lookup table and two comparisons, not a rules engine; a library would add a dependency to re-implement `if (role in policy.roles) next()`.

---

## 1. Decisions summary (proposed ADRs, ADR-038+)

| ADR | Decision | Why | Consequence |
|---|---|---|---|
| **ADR-038** | **One `authorize(policy)` middleware.** `Policy = { roles?: Role[], selfParam?: string, deferToService?: true }`. `authorize` never touches the database: `roles` is a plain membership check against `req.user.role`; `selfParam` compares `req.params[selfParam]` to `req.user.id` (a string compare — no DB read, because the resource's own id *is* the owner's id, as with a user's account); `deferToService` lets any authenticated caller through and leaves the actual ownership decision to the service that already loads the resource. | `requireAdmin`/`requireSelfOrAdmin`/`requireRole` are three call sites doing the same job (a role/id membership check) with three names (SEC-13's "route comments contradict the enforced rules" symptom). One typed policy object, declared next to the route it protects exactly as today (AM-M3-8), is self-documenting and is the literal input to the matrix test (§6). | Every `*.routes.ts` file changes its guard imports; no route's *behaviour* changes unless a decision below says so. `src/middlewares/authorize.ts` keeps its name and path (only its exports change) — no import path churn outside routes files. |
| **ADR-039** | **Ownership resolved without a DB read is a route-level check (`selfParam`); ownership resolved from a stored field is a service-level check, atomic with the write.** A deferred-ownership write (`update`/`softDelete` on products and categories) filters by `{ _id, state: true, user: actor.id }` for a non-privileged caller in the *same* query as the write — an owner and a privileged role both succeed in one atomic operation, with no race between "check" and "write." When that filtered write matches nothing, the service runs **one** unprivileged existence check (`{ _id, state: true }`, no `user` clause — the same shape `activeOr404` already uses) purely to choose between 403 (exists, not yours) and 404 (doesn't exist or is soft-deleted). This is the **only** place M6 adds a second read, it reuses the find-active-or-404 shape verbatim, and a privileged caller (whose filter never carries `user`) never pays for it. | The brief's own warning — "loading a resource to check its owner must not become a second, inconsistent source of 404s" — is satisfied by construction: there is exactly one authoritative existence filter (`{ _id, state: true }`) in each service, reused by both the normal 404 path and the ownership-disambiguation path. Baking ownership into the write's filter (rather than reading first, then writing) also removes a TOCTOU window: nothing can soft-delete or reassign the item between the ownership check and the write. | Every ownership-checked service method (`ProductsService.update/softDelete`, `CategoriesService.update/softDelete`) takes an `Actor` (`{ id, role }`), not a bare `userId`, mirroring `UsersService.update`'s existing `Actor` shape (AM-M5-10). **[P29]** confirmed: Mongoose's `ObjectId.equals()` (used when the filter's `user` field is compared) parses hex to binary before comparing, so it is inherently case-insensitive — no manual `.toLowerCase()` is needed here, unlike the users route's plain *string* comparison against `req.params.id`, which still needs it (unchanged). |
| **ADR-040** | **`VENTAS_ROLE` means "catalog manager": full write access (create, update, delete — any item, not only their own) to products and categories, and read access to their image via media, but zero rights over user accounts.** `DELETE /api/user/:id` drops `VENTAS_ROLE` (**breaking**); `PUT /api/uploads/product/:id` gains it (additive). No enum change, no migration: a stored `VENTAS_ROLE` document needs no rewrite, only its routes' policies change. | SEC-13 names this exact gap: "`VENTAS_ROLE` is referenced but never defined." The one place it appears today (`DELETE /api/user`) is a *users* action, which contradicts a role named for sales/inventory; giving it full catalog rights instead is the definition its name already implies, and it costs no data migration (owner Question 1, §9, recommends this over removal). | **Breaking:** an existing `VENTAS_ROLE` account loses `DELETE /api/user/:id`. **Additive:** it gains `PUT`/`DELETE /api/{category,product}/:id` on any item and `PUT /api/uploads/product/:id`. Both ship in the same 3.0.0 release as every other M3–M6 contract change (ADR-024), so there is no intermediate state a client observes. |
| **ADR-041** | **A product's or category's creator may update or delete their own active item**, alongside an administrator or `VENTAS_ROLE` (any item). Image replacement (`PUT /api/uploads/product/:id`) is **not** extended to the creator — it stays admin/`VENTAS_ROLE`-only, unchanged for that collection. | Today any authenticated role may **create** a product or category (`user.routes.ts`/`category.routes.ts`/`product.routes.ts`: `authenticate` only, no guard) but only an administrator may **edit or delete** it — a creator cannot fix a typo in their own listing. Extending ownership to the write routes closes that asymmetry; **not** extending it to media avoids a second DB read and a wider `ImageRecordModel` interface (YAGNI) for a capability nobody asked for — image replacement is also the one action with an external side effect (a Cloudinary upload/destroy pair, C11), which is a reasonable place to keep the bar at "privileged role only." | **Additive:** a non-privileged creator's own `PUT`/`DELETE` goes from 403 to 200/204. No existing 200/204 response changes to 403 (no client that could previously write can no longer do so) — the change is purely permission-widening, so it is **not** in the Breaking section. Discovered while designing this: `product.service.ts`'s `update()` and `category.service.ts`'s `update()` today unconditionally set `user: <the editor's id>` on every write (`product.service.ts:86`, `category.service.ts:56`) — silently reassigning the item to whoever last edited it, admin included. This stops being a harmless quirk once ownership is enforced (an admin fixing a typo would permanently steal the item), so M6 removes that reassignment; ownership never changes via `PUT` (§4). |
| **ADR-042** | **An administrator may not change their own `role` or `state` via `PUT /api/user/:id`, and nobody may target their own account with `DELETE /api/user/:id`**, whatever their role. Both are a plain `actor.id === target id` check — no count of active administrators, no query. | The brief names the last-active-administrator lockout risk explicitly. Today's code has **no** protection at all: `user.service.ts`'s `update()` lets an administrator flip their own `role` or `state` (only the *password* field is blocked for `isSelf`, by AM-M5-10), and `DELETE /api/user/:id` has no self-check whatsoever — a sole administrator can strip their own role or delete their own account in one request, with no recovery path short of direct database access. Blocking every self-targeted role/state/delete action (instead of counting administrators and only blocking the *last* one) needs no query, has no race window, and is simple enough to reason about with certainty (KISS/YAGNI, ARCHITECTURE §2.1). | **Breaking:** an administrator who could previously self-demote, self-deactivate or self-delete now gets 403 and must ask another administrator. A single-administrator deployment that relies on self-service role changes must create a second administrator first — worth a CHANGELOG callout (§3). |
| **ADR-043** | **A role or state change does not bump `tokenVersion`.** | `authenticate` (M5, unchanged) reads `role` and `state` fresh from the database on **every** request — neither is ever embedded in the JWT (M5's claims are `{ uid, tv, iat, exp, iss, aud }`, no `role`). A demoted user's very next request, on the *same still-valid* token, already reflects the new role; there is no privilege-escalation window a revocation would close, unlike a *password* change (AM-M5-10), which must revoke because the old credential itself keeps working otherwise. Bumping `tokenVersion` here would only add an unnecessary forced re-login. | No change to `authenticate`, `TokenService`, or the login/token contract. Verified directly against `src/middlewares/authenticate.ts:59` (`req.user.role` is read from `user.role`, the freshly-loaded document, every call) and `src/core/security/jwt.ts`'s claim shape (T5.1, unchanged since). |
| **ADR-044** | **Every module exports a `<X>_ROUTE_POLICIES` array — one entry per registered route, `{ method, path, policy }` — next to its router.** A shared test helper cross-checks each module's array against the router's own registered stack (**[P30]**: Express 5's `router.stack` exposes exactly one `{ route: { path, methods } }` entry per `router.<method>()` call) and against the canonical matrix fixture (§6). | Satisfies the brief's constraint #2 literally: "it is the single source of truth, and the tests are generated from it or checked against it." A hand-maintained matrix in a markdown table and a separately hand-written test suite can silently drift from each other and from the code; a stack-length/shape cross-check fails **mechanically** the moment a route is added to a router without a matching policy entry — no reviewer discipline required. | A new route added to any `*.routes.ts` file without a matching `ROUTE_POLICIES` entry fails `tests/integration/security/authorize-matrix.test.ts` (§6) on the very next `pnpm test`, not on a later audit. |

---

## 2. The permission matrix and the 401/403/404 rules

### 2.1 401 vs 403 vs 404 (binding for every route)

- **401** — no token, an invalid/expired/wrong-algorithm/wrong-`iss`/`aud` token, or a revoked (`tokenVersion` mismatch) one. Unchanged from M5 (ADR-032/033); `authenticate` alone decides this, before `authorize` ever runs.
- **403** — a valid, current token, but the policy refuses: the role isn't listed, the caller isn't the resource's owner, or one of ADR-042's self-lockout guards fires. `authorize` decides this at the route when it can (role/selfParam); the service decides it when ownership needed a DB read (ADR-039).
- **404** — the resource doesn't exist, or is soft-deleted (`state: false`), for *anyone* who isn't already privileged enough to reach it (find-active-or-404, unchanged since M3; an administrator's `PUT /api/user/:id` still reaches a soft-deleted user by design, AM-M3-7, kept in §4).
- **A non-owner never gets 404 to hide existence.** Recommendation (Owner Question 4, §9): **keep 403**, matching the status quo the SEC-01 test already gates (`PUT /api/user/:id` from a non-owner is 403, not 404) and every other write route today. Existence isn't secret here: product and category ids are visible through the *public* `GET` routes (#9, #10, #14, #15), and a user id is routinely learned by its owner from their own `GET /api/user` listing (admin) or their own login response — a 403 leaks nothing an attacker with a guessed id couldn't already suspect from those public reads. Switching to 404 for a *different* future resource with genuinely private ids would be a local decision at that resource, not a global rule.

### 2.2 The matrix (API_PROGRESS format, ready to paste)

Role columns show the outcome for a **non-owner** of that role. **Owner** shows the outcome when the caller — of any non-privileged role — is the resource's creator (`user` field) or, for user accounts, is the account itself. A blank Owner cell means ownership isn't a dimension of that route (a list, a creation, or a self-only action with no `:id` target).

| # | Method | Path | Anonymous | `USER_ROLE` | `VENTAS_ROLE` | `ADMIN_ROLE` | Owner |
|---|---|---|---|---|---|---|---|
| 2 | POST | `/api/auth/login` | 200/401 (creds) | — | — | — | |
| 3 | POST | `/api/auth/google` | 200/401 (creds) | — | — | — | |
| 4 | GET | `/api/user` | 401 | 403 | 403 | 200 | |
| 5 | POST | `/api/user` | 201 (public sign-up) | — | — | — | |
| 6 | PUT | `/api/user/:id` | 401 | 403 | 403 | 200 (any target); **403 on `role`/`state` for self**, ADR-042 | 200 (self, whitelisted fields; `password` is 422, AM-M5-10) |
| 7 | DELETE | `/api/user/:id` | 401 | 403 | 403 (was 204, **breaking**, ADR-040) | 204 (any *other* target); **403 on self**, ADR-042 | — |
| 9 | GET | `/api/category` | 200 | 200 | 200 | 200 | |
| 10 | GET | `/api/category/:id` | 200/404 | 200/404 | 200/404 | 200/404 | |
| 11 | POST | `/api/category` | 401 | 201 | 201 | 201 | |
| 12 | PUT | `/api/category/:id` | 401 | 403 (unless owner) | 200 (any, **additive**, ADR-040) | 200 (any) | 200 (creator, **additive**, ADR-041) |
| 13 | DELETE | `/api/category/:id` | 401 | 403 (unless owner) | 204 (any, **additive**) | 204 (any) | 204 (creator, **additive**) |
| 14 | GET | `/api/product` | 200 | 200 | 200 | 200 | |
| 15 | GET | `/api/product/:id` | 200/404 | 200/404 | 200/404 | 200/404 | |
| 16 | POST | `/api/product` | 401 | 201 | 201 | 201 | |
| 17 | PUT | `/api/product/:id` | 401 | 403 (unless owner) | 200 (any, **additive**) | 200 (any) | 200 (creator, **additive**) |
| 18 | DELETE | `/api/product/:id` | 401 | 403 (unless owner) | 204 (any, **additive**) | 204 (any) | 204 (creator, **additive**) |
| 19 | GET | `/api/search/category\|product/:term` | 200 | 200 | 200 | 200 | |
| 19 | GET | `/api/search/user/:term` | 401 | 403 | 403 | 200 | |
| 21a | PUT | `/api/uploads/user/:id` | 401 | 403 (unless self) | 403 (unless self) | 200 (any) | 200 (self) |
| 21b | PUT | `/api/uploads/product/:id` | 401 | 403 **(no owner exception, ADR-041)** | 200 (any, **additive**) | 200 (any) | **403 — not extended** |
| 22 | GET | `/api/uploads/:collection/:id` | 302/404 | 302/404 | 302/404 | 302/404 | |
| 24 | POST | `/api/auth/logout-all` | 401 | 204 (self only) | 204 (self only) | 204 (self only) | — |
| 25 | PUT | `/api/auth/password` | 401 | 200 (self only) | 200 (self only) | 200 (self only) | — |

Routes `#1`, `#8`, `#20` stay `✂️` removed (unchanged); `#23` (`GET /`, static) is unaffected.

---

## 3. Contract changes for 3.0.0

M6 ships inside the same 3.0.0 release as M3–M5 (ADR-024/026): no new version number, and every change below lands on `next` before the tag.

### 3.1 Breaking

- **`DELETE /api/user/:id` no longer accepts `VENTAS_ROLE`** (`ADMIN_ROLE` only). A `VENTAS_ROLE` account that could delete users can no longer do so (ADR-040).
- **An administrator may no longer change their own `role` or `state`** via `PUT /api/user/:id` (403). A single-administrator deployment must create a second administrator before ever needing to change the first one's role or state (ADR-042).
- **Nobody may target their own account with `DELETE /api/user/:id`** (403), administrators included (ADR-042).
- **A `PUT`/`DELETE` on a product or category no longer reassigns its `user` (creator) field to the editor.** Previously, any admin edit silently transferred ownership; now ownership never changes through these routes (a corollary of ADR-041, not a feature anyone relied on — but technically observable).

### 3.2 Added / Changed (additive — no existing 200/204 response becomes an error)

- The creator of a product or category may now `PUT`/`DELETE` their own active item, alongside an administrator or `VENTAS_ROLE` (ADR-041).
- `VENTAS_ROLE` may now `PUT`/`DELETE` **any** product or category, and `PUT /api/uploads/product/:id` (ADR-040).

### 3.3 Per-route table (extends the M3 §6 / M4 §11 / M5 §2.1 table)

| # | Method | Path | Auth | Notes |
|---|---|---|---|---|
| 6 | PUT | `/api/user/:id` | JWT; self-or-admin; admin blocked on own `role`/`state` | ADR-042 |
| 7 | DELETE | `/api/user/:id` | JWT + `ADMIN_ROLE`; blocked on self | ADR-040/042 |
| 12 | PUT | `/api/category/:id` | JWT; admin, `VENTAS_ROLE`, or the creator | ADR-040/041 |
| 13 | DELETE | `/api/category/:id` | JWT; admin, `VENTAS_ROLE`, or the creator | ADR-040/041 |
| 17 | PUT | `/api/product/:id` | JWT; admin, `VENTAS_ROLE`, or the creator | ADR-040/041 |
| 18 | DELETE | `/api/product/:id` | JWT; admin, `VENTAS_ROLE`, or the creator | ADR-040/041 |
| 21 | PUT | `/api/uploads/:collection/:id` | `user`: self-or-admin (unchanged); `product`: admin or `VENTAS_ROLE` (was admin-only) | ADR-040 |

### 3.4 API_PROGRESS.md ledger rows

Update rows #6, #7, #11–#13, #16–#18, #21's **Issues**/**Status**/**Target** columns to `— | 🟢 | —` (SEC-13 closes). No new route numbers: M6 adds no endpoint.

### 3.5 CHANGELOG (`### M6: Authorization (on next)`)

**Breaking**
- `DELETE /api/user/:id` no longer accepts `VENTAS_ROLE`.
- An administrator can no longer change their own `role` or `state` through `PUT /api/user/:id`, or delete their own account through `DELETE /api/user/:id` — ask another administrator.
- A `PUT` on a product or category no longer reassigns its creator to the editor.

**Changed**
- The creator of a product or category may now update or delete their own active item.
- `VENTAS_ROLE` gains full write access to products and categories (any item, not only its own) and to a product's image; it loses the ability to delete a user.
- `src/middlewares/authorize.ts`'s `requireAdmin`/`requireSelfOrAdmin`/`requireRole` are replaced by one `authorize(policy)`. Internal only — no client observes this.

---

## 4. Signatures and sketches

### 4.1 `src/middlewares/authorize.ts` — replaces ADR-028's three guards

```ts
import type { Request, RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../core/errors';
import type { Role } from '../core/security/roles';
import type { AuthUser } from './authenticate';

/**
 * A route's access rule (ADR-038). `authorize` never reads the database: a check that needs the
 * resource itself (a stored creator, not the URL's own id) is deferred to the service, which already
 * loads it for find-active-or-404 (ADR-039).
 */
export interface Policy {
  /** Roles that satisfy this policy on their own. Omitted = every authenticated role. */
  roles?: readonly Role[];
  /** Also satisfied when req.params[selfParam] equals the caller's own id (no DB read: the id IS the owner). */
  selfParam?: string;
  /** Also satisfied once the service, having loaded the resource, finds the caller is its creator (ADR-039). */
  deferToService?: true;
}

const requireUser = (req: Request): AuthUser => {
  if (!req.user) throw new UnauthorizedError(); // defence in depth: authenticate always runs first
  return req.user;
};

/** ADR-038: the one authorization middleware. Runs after authenticate; touches no database. */
export const authorize =
  (policy: Policy): RequestHandler =>
  (req, _res, next) => {
    const user = requireUser(req);
    if (!policy.roles || policy.roles.includes(user.role as Role)) return next();
    if (policy.selfParam && req.params[policy.selfParam] === user.id) return next();
    if (policy.deferToService) return next(); // the service decides, atomically with its write (ADR-039)
    throw new ForbiddenError('Not allowed');
  };
```

### 4.2 Ownership helper (`src/modules/products/product.service.ts`, mirrored in `category.service.ts`)

```ts
export interface Actor {
  id: string;
  role: string;
}
const PRIVILEGED = new Set(['ADMIN_ROLE', 'VENTAS_ROLE']);

async update(id: string, dto: UpdateProductDto, actor: Actor): Promise<ProductDocument> {
  const filter: FilterQuery<Product> = { _id: id, state: true };
  if (!PRIVILEGED.has(actor.role)) filter.user = actor.id; // ownership enforced in the write itself (ADR-039)

  const update: UpdateQuery<Product> = {}; // no more `user: actor.id` reassignment (ADR-041)
  if (dto.name !== undefined) update.name = dto.name.toUpperCase();
  if (dto.category !== undefined) { await activeCategory(dto.category); update.category = dto.category; }
  if (dto.price !== undefined) update.price = dto.price;
  if (dto.description !== undefined) update.description = dto.description;
  if (dto.available !== undefined) update.available = dto.available;

  const doc = await Product.findOneAndUpdate(filter, update, { returnDocument: 'after' })
    .populate('user', 'name').populate('category', 'name');
  if (doc) return doc;
  // Disambiguate 403 vs 404 with the same shape activeOr404 already uses — no new source of truth.
  if (filter.user && (await Product.exists({ _id: id, state: true }))) {
    throw new ForbiddenError('Only the creator, an administrator or VENTAS_ROLE may update this product');
  }
  throw new NotFoundError('Product not found');
}
// softDelete(id, actor) follows the identical filter/disambiguate shape.
```

`create(dto, userId)` is unchanged — the creator is still whoever's token authenticated the request, and any authenticated role may still create (§2.2, unchanged from M3).

### 4.3 `src/modules/users/user.service.ts` — ADR-042's self-lockout guards

```ts
async update(id: string, dto: UpdateUserDto, actor: Actor): Promise<UserDocument> {
  const isAdmin = actor.role === 'ADMIN_ROLE';
  const isSelf = id.toLowerCase() === actor.id.toLowerCase();
  if (dto.password !== undefined && (isSelf || !isAdmin)) {
    throw new ValidationError([{ path: 'password', message: OWN_PASSWORD }]); // AM-M5-10, unchanged
  }
  // ADR-042: an administrator may not change their own role or active state (the lockout guard).
  if (isSelf && isAdmin && (dto.role !== undefined || dto.state !== undefined)) {
    throw new ForbiddenError('Ask another administrator to change your own role or active state');
  }
  // … the rest of the C6 whitelist and the atomic $set/$inc write are unchanged.
}

async softDelete(id: string, actor: Actor): Promise<void> {
  if (id.toLowerCase() === actor.id.toLowerCase()) {
    throw new ForbiddenError('You cannot delete your own account');
  }
  const doc = await User.findOneAndUpdate({ _id: id, state: true }, { state: false });
  if (!doc) throw new NotFoundError('User not found');
}
```

`UsersController.remove` starts passing `req.user` (already available post-`authenticate`) into `softDelete`, mirroring how `update` already receives it.

### 4.4 Route changes per module

```ts
// user.routes.ts
router.get('/', authenticate, authorize({ roles: ['ADMIN_ROLE'] }), validate('query', ...), controller.list);
router.post('/', validate('body', createUserBody), controller.create); // unchanged, public
router.put('/:id', authenticate, authorize({ roles: ['ADMIN_ROLE'], selfParam: 'id' }), ..., controller.update);
router.delete('/:id', authenticate, authorize({ roles: ['ADMIN_ROLE'] }), ..., controller.remove); // VENTAS_ROLE dropped

export const USER_ROUTE_POLICIES = [
  { method: 'get', path: '/', policy: { roles: ['ADMIN_ROLE'] } },
  { method: 'post', path: '/', policy: null },
  { method: 'put', path: '/:id', policy: { roles: ['ADMIN_ROLE'], selfParam: 'id' } },
  { method: 'delete', path: '/:id', policy: { roles: ['ADMIN_ROLE'] } },
] as const;
```

```ts
// category.routes.ts and product.routes.ts (identical shape)
const write = { roles: ['ADMIN_ROLE', 'VENTAS_ROLE'], deferToService: true } as const;
router.post('/', authenticate, authorize({}), validate('body', createBody), controller.create); // any role
router.put('/:id', authenticate, authorize(write), ..., controller.update);
router.delete('/:id', authenticate, authorize(write), ..., controller.remove);
// GET routes are unchanged: no authenticate, no policy — still public.
```

```ts
// media.routes.ts — one dispatcher, two policies
const authorizeCollection: RequestHandler = (req, res, next) => {
  const policy: Policy =
    req.params.collection === 'user'
      ? { roles: ['ADMIN_ROLE'], selfParam: 'id' }
      : { roles: ['ADMIN_ROLE', 'VENTAS_ROLE'] }; // no deferToService: ADR-041 does not extend media ownership
  authorize(policy)(req, res, next);
};
```

```ts
// search.routes.ts — unchanged structure, new guard name
router.get('/:collection/:term', forUserSearch(authenticate), forUserSearch(authorize({ roles: ['ADMIN_ROLE'] })), controller.search);
```

### 4.5 Fate of `src/middlewares/authorize.ts`'s interim exports

`requireAdmin`, `requireSelfOrAdmin` and `requireRole` are deleted; every import site listed above moves to `authorize`. No route file keeps a fallback import — ADR-028 named this file as the one place M6 would change, and every caller is enumerated in §4.4, so the removal is total in one commit, not a deprecation period (internal API; ADR-024's client-facing versioning rules don't apply to it).

---

## 5. Data: migrations

**No migration is required under this design's recommended defaults** (§9): `VENTAS_ROLE` keeps its enum value and every existing document that holds it; only route policies change, which needs no data write. `M001`–`M006` remain the complete migration set for 3.0.0.

**If the owner instead rules to remove `VENTAS_ROLE`** (the alternative in Owner Question 1), `M007` would be needed, in the M004 style (the one other role-touching, potentially-destructive migration):

```ts
// M007-remap-ventas-role.ts (NOT part of this design's recommended path — sketched for completeness only)
export const M007: Migration = {
  id: 'M007-remap-ventas-role',
  async up(db, log) {
    const { modifiedCount } = await db.collection('users').updateMany({ role: 'VENTAS_ROLE' }, { $set: { role: 'USER_ROLE' } });
    log.info({ modified: modifiedCount }, 'M007: VENTAS_ROLE remapped to USER_ROLE');
  },
  async down(db, log) {
    log.warn('M007 down: VENTAS_ROLE cannot be restored — which USER_ROLE accounts were VENTAS_ROLE is not recorded');
  },
};
```

Its `down` is necessarily lossy (mirroring M001's own precedent for irreversible normalization) — one more reason the recommended default (keep and define the role) is preferable: it needs no migration, reversible or not.

---

## 6. Test strategy

### 6.1 Kept or re-expressed invariants

- **C6** (field whitelist), **SEC-01** (non-owner PUT is 403, victim untouched), **SEC-05** (`GET /api/user` and `GET /api/search/user/*` are admin-only) — unchanged; re-run verbatim against the new `authorize` wiring, since none of their assertions depend on which guard produced the 403/401.
- **AM-M3-7** (an admin `PUT /api/user/:id` reaches a soft-deleted user) — unchanged; `authorize` never touches `state`, only the service's `{ _id }` vs `{ _id, state: true }` filter choice does, which M6 does not alter.
- **AM-M5-10** (a token alone cannot change its own password; an admin reset revokes sessions) — unchanged; ADR-042's new self-lockout guard is additional, not a replacement, so both checks are tested independently (a self `role`/`state` change and a self `password` change fail for different, both-still-present reasons).

### 6.2 The matrix-driven test

`tests/helpers/permission-matrix.ts` holds the §2.2 table as data (one entry per row: method, path, and the expected outcome per role/anonymous/owner). `tests/integration/security/authorize-matrix.test.ts`:
1. For each module, imports its `<X>_ROUTE_POLICIES` (§4.4) and asserts its length and `(method, path)` set exactly match that router's live `router.stack` entries (**[P30]**) — this is what fails the moment a route is added without a policy.
2. Cross-checks every `ROUTE_POLICIES` entry against `permission-matrix.ts`'s corresponding row — a route whose code policy and documented matrix row disagree fails here, not in a later manual audit.
3. Fires one real HTTP request per matrix cell (anonymous, `USER_ROLE`, `VENTAS_ROLE`, `ADMIN_ROLE`, and, where the matrix has an Owner column, the creator) against `startTestApp()` and asserts the documented status code — this is the actual "one test per matrix cell" the brief asks for, generated from the same fixture the drift checks use, not hand-duplicated per route.

### 6.3 Adversarial cases

- **Role escalation on every write path:** re-confirm `POST /api/user`, `POST /api/category`, `POST /api/product` accept no `role`/`user` field from the client (SEC-02, and the schema reads in §0 confirm no DTO carries either field today).
- **Ownership bypass by id case:** a product/category `:id` supplied in a different hex case than stored still resolves the *same* document (Mongoose's binary `ObjectId` comparison, **[P29]**) — confirm the ownership filter still matches for the true owner and still rejects a different real owner, whatever case the URL uses.
- **Ownership bypass on a soft-deleted resource:** the creator of a soft-deleted product/category gets 404 on `PUT`/`DELETE`, never 403 or 200 — find-active-or-404 outranks ownership (§2.1).
- **A demoted administrator's still-valid token:** demote an administrator (as a second administrator), then immediately reuse their pre-existing, still-unexpired token against `GET /api/user` (now 403) — proves ADR-043's "role is read live" claim end-to-end, not just at the `authenticate` unit level.
- **The last-administrator lockout:** with exactly one active administrator, that administrator's own `PUT .../role`, `PUT .../state` and `DELETE` against their own id are all 403 (ADR-042) — proves the guard fires unconditionally, without needing to seed a second administrator to observe it.
- **IDOR on every `:id`:** a systematic sweep — a non-owner, non-privileged token against every ownership-checked route (`PUT`/`DELETE` on user/category/product, `PUT` media) never returns 200/204, only 403 or 404 per §2.1.
- **`VENTAS_ROLE`'s new and lost rights, both directions:** it succeeds on `PUT`/`DELETE` category/product (any item, not just its own) and on `PUT /api/uploads/product/:id`; it is refused (403) on `DELETE /api/user/:id`, closing the loop on ADR-040.

### 6.4 Coverage

Same bar M3–M5 held: `src/**` around 99% lines, enforced in CI (unchanged threshold).

---

## 7. Task breakdown

Integration branch **`m6/authz`**, cut from `next` @ `51fc0b5`. P-numbers continue from **P29**.

**Shared contracts:**
- **P29** — `authorize(policy)` never performs a database read; every DB-backed ownership decision lives in the service that already loads the resource (ADR-038/039).
- **P30** — every `*.routes.ts` module exports a `ROUTE_POLICIES` array whose `(method, path)` set exactly matches its router's live `router.stack` — checked mechanically, not by convention (ADR-044).
- **P31** — an ownership-checked service method takes an `Actor` (`{ id, role }`), never a bare `userId`; ownership is enforced inside the write's own filter, never as a separate read-then-write (ADR-039).
- **P32** — `role`/`state` self-changes and self-`DELETE` on `/api/user` are blocked unconditionally, not by counting administrators (ADR-042).
- **P33** — no route policy or service change ever writes to `tokenVersion` for a role/state change (ADR-043) — that field is touched only by the M5 paths already gated (logout-all, password change, admin password reset).

| Task | Agent | Files allowed | Forbidden | Required | Acceptance | Commits |
|---|---|---|---|---|---|---|
| **T6.1 authorize middleware & route migration (GATE)** | BACKEND | `src/middlewares/authorize.ts`, every `src/modules/*/*.routes.ts`, `src/modules/{users,products,categories}/{user,product,category}.service.ts`, `src/modules/{users,products,categories}/*.controller.ts` (actor plumbing only), `tests/unit/authorize.test.ts`, `tests/unit/modules/{user,product,category}.service.test.ts` | `src/middlewares/authenticate.ts`, `src/core/security/**`, `src/database/**`, `tests/integration/security/authorize-matrix.test.ts` (T6.2's) | §4.1–§4.4 exactly: the `Policy` type and `authorize` (P29), every module's `ROUTE_POLICIES` export (P30), the `Actor`-based ownership filter with no separate `user` reassignment on update (P31, ADR-041's fix), ADR-042's two self-lockout guards (P32), `VENTAS_ROLE` wired per ADR-040 (dropped from user delete, added to category/product write and product media). | typecheck/lint/format/build green; `authorize.test.ts` proves all three `Policy` branches plus the "no branch matches → 403" default; each service's unit tests prove the ownership filter (owner succeeds, non-owner/non-privileged 403, privileged succeeds on any item, soft-deleted is 404 regardless of ownership) and that `update` no longer reassigns `user`; `user.service.test.ts` proves both ADR-042 guards, including the "isSelf but not admin" and "isAdmin but not self" non-triggering cases; full suite green (every existing route test still passes: `requireAdmin`/`requireSelfOrAdmin`/`requireRole` call sites are gone, but no behaviour they gated changes except where this task's acceptance says so). | `feat(authz): authorize(policy) middleware replaces the interim guards (ADR-038)`; `feat(authz): product/category ownership, VENTAS_ROLE catalog rights (ADR-040/041)`; `fix(authz): block self role/state change and self-delete on /api/user (ADR-042)` |
| **T6.2 matrix tests & adversarial suite** | SECURITY & QA | `tests/helpers/permission-matrix.ts` (new), `tests/integration/security/authorize-matrix.test.ts` (new), `tests/integration/security/{users,uploads,search}.test.ts` (VENTAS_ROLE assertions only), `tests/integration/modules/{users,products,categories,media}.test.ts` (ownership/VENTAS_ROLE cases) | `src/**` | §6 exactly: the matrix fixture, the stack cross-check (P30), one HTTP test per matrix cell, every §6.3 adversarial case. | typecheck/lint/format/build green; `authorize-matrix.test.ts` fails if a `ROUTE_POLICIES` entry is deleted or a route added without one (proven by a temporary local edit during review, reverted before merge); every §6.3 case passes; full suite green; coverage bar held (§6.4). | `test(authz): permission matrix, drift check, adversarial IDOR/lockout suite` |
| **T6.3 VENTAS_ROLE migration (conditional)** | DATABASE AGENT | `src/database/migrations/M007-remap-ventas-role.ts` (new), `src/cli.ts` (append one line), `tests/integration/database/migrations.test.ts` (add cases) | everything else | **Only runs if the owner overrides Owner Question 1** (§9) and rules removal instead of the recommended default. Under the default, this task does not run and M6 ships with no M007. If invoked: §5's sketch exactly — the filter, the `$set` shape, and the stated lossy `down`. | (if invoked) `pnpm test` includes: M007 remaps every `VENTAS_ROLE` to `USER_ROLE`, a second run is a no-op, `down` logs its stated limitation and does not crash; full suite green. | `feat(db): M007 remap VENTAS_ROLE to USER_ROLE (only if Q1 is overridden)` |
| **T6.4 final review** | ARCHITECT | — (read-only) | — | Adversarial review vs this design; re-run C6/SEC-01…05/AM-M3-7/AM-M5-10 plus every §6.3 case; confirm the matrix test actually fails on a deliberately broken fixture; confirm no `requireAdmin`/`requireSelfOrAdmin`/`requireRole` call site survives; cold frozen install; contract-impact ledger; 3.0.0 release-readiness check (§10). | ACCEPT/RETURN per task; findings + reproduction; docs-for-close list. | — |

**Dependency sequence:** `T6.1` (**GATE** — reviewed before T6.2 starts, exactly as T5.1 gated T5.2) → `T6.2`. `T6.3` is conditional and, if invoked, runs independently in parallel with `T6.1` from the start (a role-value migration touches neither `authorize` nor any route). `T6.4` waits for `T6.1` (merged), `T6.2`, and `T6.3` if it ran.

**Shared edit surface:** none beyond the usual one-module-per-file discipline — T6.1 owns every routes file and the three ownership-bearing services; T6.2 owns only test files; T6.3 (if it runs) touches only its own migration and the two-line `cli.ts` append, mirroring T5.3's isolation.

**Revert units:** T6.1's three commits are independent revert units (the middleware, the ownership/VENTAS_ROLE change, the lockout fix can each be reverted alone if a review finds a problem with just one). T6.3, if it ran, reverts as data via `down` before the code revert, per the M4/M5 pattern. Reverting the whole `m6/authz` merge is the milestone-level rollback (ADR-026); unlike M5, no session invalidation is forced either way (no token/claim shape changes in M6).

---

## 8. Risks and rollback

| Risk | Task | Mitigation / rollback |
|---|---|---|
| **A route is added later without a matching `ROUTE_POLICIES` entry**, silently missing the matrix. | T6.1/T6.2 | Structurally prevented by the stack-length cross-check (ADR-044, P30): the very next `pnpm test` fails, not a later audit. |
| **A single-administrator deployment locks itself out of self-service role changes** (ADR-042 is intentionally stricter than "only the last admin"). | T6.1 | Documented in the CHANGELOG Breaking section (§3.5) and the deploy runbook (§10): create a second administrator (via the seed or another admin) before this milestone deploys, if the operator ever needs to change the first one's role. |
| **The ownership-filtered write (ADR-039) masks a real 404 as a 403**, or vice versa, if the disambiguation read races a concurrent delete. | T6.1 | Low severity: the window is the same as any check-then-read race elsewhere in the codebase (unavoidable without a transaction, which nothing else here uses either); the *write* itself is race-free (filter and update are one atomic operation), only the *error message choice* could theoretically be stale by one request in an already-rare concurrent-delete window. Not worth a transaction for a cosmetic 403-vs-404 distinction. |
| **`product.service.ts`/`category.service.ts`'s removed `user` reassignment on `update`** changes behaviour no test currently pins (nobody wrote a test asserting the old reassignment, because it was never a stated feature). | T6.1 | T6.2 adds an explicit regression test ("an admin's edit does not change the product's creator") so the fix, once made, cannot silently regress back to the old behaviour. |
| **`VENTAS_ROLE`'s new catalog-wide rights are broader than the owner expects** (any item, not just a self-service scope). | T6.1 | This is Owner Question 2's explicit trade-off (§9); the recommended default is stated plainly, and the owner can narrow `VENTAS_ROLE`'s policy to `deferToService`-only (owner-scoped, like `USER_ROLE`) with a one-line change to `write` in §4.4 if they prefer a stricter default — no migration needed either way. |
| **Removing the three interim guard exports breaks an out-of-tree import.** | T6.1 | None exist: `grep -rn "requireAdmin\|requireSelfOrAdmin\|requireRole"` outside `src/middlewares/authorize.ts` and the six routes files it lists in §4.4 returns nothing else in this repository; the file is internal, never re-exported from a module's public surface. |

---

## 9. Owner questions

1. **`VENTAS_ROLE`: define it, or remove it?** This design's default (ADR-040) is to **define** it as a catalog manager: full product/category write access (any item) plus product-image replacement, with no user-management rights at all — closing SEC-13 with zero data migration. The alternative is outright removal (§5's `M007` sketch, existing `VENTAS_ROLE` accounts remapped to `USER_ROLE`, a lossy `down`). **Recommendation: define it (the default above).** The role's own name already implies a sales/catalog scope, ADR-007's M4-era comment explicitly deferred defining it to M6 rather than flagging it for removal, and defining it is strictly less destructive (no data write, fully reversible by a future policy change alone) than removing it.
2. **Creator ownership of products and categories: yes, and how far?** This design's default (ADR-041) grants the creator `PUT`/`DELETE` on their own active item, but **not** image replacement. **Recommendation: accept as scoped.** It closes the "you can create it but never fix it" asymmetry that exists today, without extending to the one route with an external side effect (Cloudinary) and the one nobody has asked to unlock. What's breaking relative to today's 3.0 line: nothing removed, only added (§3.2); relative to 2.x: 2.x had no ownership concept at all (`SEC-13`'s original finding), so this is the *first* time either line has had creator rights — there is no narrower 2.x behaviour to preserve.
3. **Administrator self-demotion and the last administrator.** This design's default (ADR-042) blocks **every** self-targeted role/state change and self-`DELETE`, not only the last administrator's. **Recommendation: accept the blanket rule.** It needs no "how many active administrators are there" query (which itself has a race window under concurrent requests), it is trivial to test exhaustively (§6.3), and the cost — an administrator must ask a colleague to change their own role, even when others exist — is a one-time friction, not a recurring one, for a mistake class (self-lockout) that is otherwise unrecoverable without direct database access.
4. **403 or 404 for a non-owner?** This design's default (§2.1) is **403**, matching every non-owner write response today (SEC-01) and every route this milestone touches. **Recommendation: keep 403.** Every id a non-owner could plausibly guess is already visible through a public `GET` (products, categories) or through the caller's own prior interactions (users); switching to 404 here buys no real confidentiality and would be the one inconsistent route in an otherwise uniform contract.

---

## 10. 3.0.0 release readiness

**CHANGELOG `[3.0.0]` consolidation.** When `next` is ready to tag, collapse the `## [Unreleased]` section's four `### M3`/`### M4`/`### M5`/`### M6` subsections into one `## [3.0.0] - <date>` entry, merging their Breaking/Added/Changed/Security/Operational bullets under one set of those headings (in that milestone order, so a reader sees the changes in the order they were designed) — the same mechanical consolidation `CHANGELOG.md`'s own header already promises ("M3–M6 ship together as 3.0.0").

**Migration order.** `M001`–`M006` (M4: email/index/timestamp/roles-collection; M5: tokenVersion/Google-placeholder), plus `M007` **only if** Owner Question 1 is overridden toward removal (§5, §9). Under the recommended defaults, `pnpm migrate up` for 3.0.0 runs exactly `M001`–`M006` — M6 introduces no data change of its own.

**Combined deploy runbook** (extends M4 §7.1 and M5 §10.1 — M6 adds no new step, and that absence is itself worth stating explicitly so an operator doesn't go looking for one):
0. (M4) `pnpm migrate up` completes before the new code serves traffic.
1. (M5) `SECRET_KEY` is at least 32 characters, set **before** the deploy window; every session ends at this deploy regardless.
2. (M5) Warn clients that every session ends; they sign in again after the deploy.
3. (M4/M5) `pnpm migrate up` (`M001`–`M006`, or `–M007` if invoked).
4. **(M6) No additional step.** Authorization changes take effect the moment the new code serves traffic, for every *new* request; M6 changes no token, no schema, and no session state, so there is nothing to warn a client about beyond the CHANGELOG's Breaking bullets (§3.5) — a currently-mid-session client only notices on their next `PUT /api/user/:id` (self role/state), `DELETE /api/user/:id` (VENTAS_ROLE or self), or product/category write, whichever they attempt first.
5. Rollback: revert the `next`→`master` merge; `migrate down` only applies if `M007` ran.

**The tag.** Once M6's T6.4 review lands ACCEPT, the Orchestrator merges `next` into `master` and tags `v3.0.0` (ADR-024/026) — a manual step today; M10 (CI/CD, out of scope) later automates tagging from conventional commits.

**Must not ship in 3.0.0 (explicitly out of scope, not blocking):** refresh tokens (ADR-010, YAGNI); the multi-instance rate-limiter store and the OPS-05 production boot guard (M9); OpenAPI and the `public/` demo page decision, CQ-07 (M8); Docker/CI (M9/M10); SEC-17's targeted-lockout mitigation (M9, revisit with telemetry). None of these are part of the M3–M6 contract ADR-024 scopes into 3.0.0, and this design adds nothing that depends on them.

---

## 11. Orchestrator rulings on D6 (AM-M6-1…9, binding; override the text they name)

The owner delegated decisions to the Orchestrator ("toma las mejores decisiones"). Each owner question takes the design's recommended default unless a ruling below narrows it, and stays **reversible**: the owner may flip any of them before 3.0.0 ships.

| ID | Question / finding | Ruling |
|---|---|---|
| AM-M6-1 | §9 Q1: `VENTAS_ROLE` | **Define** it as the catalog manager (ADR-040): it writes **any** product and **any** category, and replaces product images; it loses `DELETE /api/user/:id` (Breaking). No `M007`; **T6.3 does not run**. |
| AM-M6-2 | §9 Q2: creator ownership | **Products only.** A product's creator may `PUT`/`DELETE` their own active product (not its image: #21b is unchanged). **Categories are a shared taxonomy** that other users' products reference, so a creator must not rename or delete one under them: `PUT`/`DELETE /api/category/:id` are a pure role policy, `ADMIN_ROLE` + `VENTAS_ROLE` (no `deferToService`, no `Actor` in `CategoriesService`). `POST /api/category` stays open to every authenticated role (unchanged). **Both** services stop reassigning `user` on `update` (the §3.1 Breaking row applies to products and categories). Overrides: §2.2 rows #12/#13 (`USER_ROLE` 403, Owner 403 — unchanged from the 3.0 line), §3.2 and §3.5 ("the creator of a **product**"), §4.2 ("mirrored in `category.service.ts`" becomes: the category service only drops the reassignment), ADR-041's Consequence. |
| AM-M6-3 | §9 Q3: self-demotion, last admin | **Accept the no-query self-guard, refined to real changes.** `PUT /api/user/:id` by an administrator on their own id is 403 only when it would change something: `(dto.role !== undefined && dto.role !== actor.role) \|\| dto.state === false`. An echo of their current role or `state: true` is accepted, so a client that PUTs a whole profile does not break. Still no query: `actor.role` is read live by `authenticate`, and an administrator who reached the route is necessarily active. Self-`DELETE` is always 403. **Residual (documented, not fixed):** two administrators demoting each other concurrently can leave zero active administrators; recovery is `pnpm seed` with a **new** `SEED_ADMIN_EMAIL` (the seed creates an administrator only when no active one exists, M4 §6). It goes in the 3.0.0 runbook (§10). Overrides §4.3's guard condition. |
| AM-M6-4 | §9 Q4: 403 vs 404 | **Keep 403** for an authenticated non-owner (§2.1). 404 only for a missing or soft-deleted resource, whoever asks. |
| AM-M6-5 | Review: two lists of privileged catalog roles | §4.2 hard-codes `PRIVILEGED` in the service while the route policy lists the same roles, so they can drift. **One source:** `src/core/security/roles.ts` exports `CATALOG_ROLES: readonly Role[] = ['ADMIN_ROLE', 'VENTAS_ROLE']`. The product and category route policies and `ProductsService`'s ownership bypass all use it; no service re-types a role list. T6.1's Files allowed gain `src/core/security/roles.ts` (this constant only). |
| AM-M6-6 | Review: ADR-044 `ROUTE_POLICIES` | **Amended: no `ROUTE_POLICIES` exports.** A second copy of each policy would be production code that exists only for a test, and it could drift from the policy the router actually applies. The fixture `tests/helpers/permission-matrix.ts` is the single source of truth: (a) a **drift check** compares the fixture's `(method, full path)` set with every route registered on the routers the app mounts [P30]; a route added to a module, or a module mounted in `src/app.ts`, without a fixture row fails `pnpm test`; (b) **one HTTP request per matrix cell** is the authoritative enforcement check. If mount prefixes cannot be read from the live app, the test takes them from the fixture and asserts that the number of mounted routers equals the number of prefixes; `src/app.ts` does not change for testability. P30 now reads: "the fixture's `(method, path)` set equals the live routers' registered set, checked mechanically". |
| AM-M6-7 | Review: `selfParam` case | `authorize` compares `req.params[selfParam]` and `req.user.id` **case-insensitively** (both lowercased), matching `users.update`'s `isSelf` (T5.2R D1) and [P29]: the same id in either hex case gets the same answer on #6 and #21a. CHANGELOG **Changed** (additive): a self request with an upper-case id goes from 403 to 200. Overrides §4.1's `===`. |
| AM-M6-8 | Review: check order on `PUT /api/product/:id` | **Accepted residual.** A non-owner who sends a `category` that does not exist gets that category's 404 before the ownership 403, because `activeCategory` runs before the filtered write. It discloses nothing: categories are public (#9/#10). Not fixed in M6. |
| AM-M6-9 | Sequencing | **T6.1 (BACKEND) and T6.2 (SECURITY & QA) start in parallel** from `m6/authz`. T6.2 works test-first from this design as ruled: new test files only, and the cells T6.1 changes fail until T6.1 lands. It commits and reports **T6.2A**. After T6.1 merges into `m6/authz` (an Orchestrator gate review; the ARCHITECT's budget is kept for T6.4), T6.2 merges `m6/authz` and finishes (**T6.2B**). T6.1 updates an existing test only where its own change flips that test's assertion, and lists each one. T6.4 is the final ARCHITECT review. |
