# M3: Feature-First Refactor + Validation/DTOs — Technical Design

> Author: ARCHITECT · 2026-09-24 · Status: **Proposed** (for Orchestrator acceptance)
> Base: `m3/design` cut from `next` @ `25fc00d` (release line ADR-026; 3.0.0 ships after M6). Builds on M2 (2.1.0, ARCHITECTURE §1.9).
> Governing ADRs: ADR-004…ADR-026, and proposed **ADR-027…ADR-030** (§1). New decisions are proposed ADRs for the Orchestrator to accept.

**How this was validated.** As for D2, every contract, signature and the whole reference module were built and run in a throw-away clone of `m3/design` (scratchpad, outside the repo). Results, all green:
- `tsc` typecheck and `tsc -p tsconfig.build.json` build of the core additions + the `categories` module;
- type-aware ESLint: the module passes every §2.3 layer rule (routes/controller/service/model boundaries);
- an integration test of `categories` proving the full 3.0.0 contract (envelope, `id` with no `_id`/`uid`, 200/201/204, 422 with `details`, 409, 404 on missing **and** soft-deleted, 401/403) — **3/3**;
- a unit test of `createCategoriesService` with a **hand-written fake** (no DB, no `vi.mock`, ADR-023) — **3/3**;
- the **registry seam** (ADR-027): reproduced the `OverwriteModelError` that naïvely registering a TS model causes, then proved the fix (legacy model file → registry re-export, TS model sole registrant, lazy cross-module resolution);
- the **error-envelope switch**: after flipping `error-handler.ts` to `errorEnvelope`, the existing 248-case suite showed **exactly 23 failures, every one an assertion of the old `{ msg }` body or a category `_id`→`id`** — zero crashes, zero `OverwriteModelError`/`MissingSchemaError`. That is the precise, bounded 3.0.0 drift this design maps in §7.

Evidence is cited inline and summarised in Appendix C.

---

## 1. Decisions summary

### 1.1 Proposed ADRs

| ID | Decision | Rationale | Consequence |
|---|---|---|---|
| **ADR-027** | **Registry seam for migrated models.** A migrated feature's TS model (`src/modules/<x>/<x>.model.ts`) is the **sole** `mongoose.model('<X>', schema)` registrant, guarded so re-import is idempotent (`mongoose.models.X ?? model(...)`). Its legacy file `models/<x>.js` is rewritten to a **registry re-export** — `module.exports = require('mongoose').model('<X>')` — so still-legacy consumers (`helpers/db-validators`, `controllers/search`, `models/index`) keep working with one registration. Cross-module model access in the composition root (e.g. `authenticate` needs `User`) is resolved **lazily / from the owning module**, never eagerly at `createApp` time. | Both a TS `model('Category', …)` and legacy `models/category.js` register the same name on the shared connection → `OverwriteModelError` (reproduced). A registry re-export removes the duplicate; the guard covers Vitest/tsx re-imports; lazy cross-module resolution removes load-order fragility (`MissingSchemaError`, reproduced when `createApp` read `User` before the legacy model registered). | This is the M3 form of ADR-017's "legacy reads TS-owned models from the registry". It is the one legacy edit each module task makes to `models/<x>.js`. |
| **ADR-028** | **Interim `authenticate` + role/ownership guards** live in `src/middlewares/` and replace `validar-jwt`/`validar-roles`, keeping **today's** semantics: `x-token` transport (ADR-010 defers Bearer to M5), load-user-and-check-`state`, `requireAdmin` (403), `requireSelfOrAdmin` (403). No `authorize(policy)` matrix (that is M6, SEC-13). | Every protected TS route needs auth now; re-expressing today's behaviour in TS is in-scope, changing the policy is not. | M5 swaps the token transport behind `authenticate`; M6 replaces the two guards with `authorize(policy)`. The route wiring does not change again. |
| **ADR-029** | **zod DTOs + one `validate(part, schema)` middleware** are the sole validation layer (ADR-006). It emits **422** `VALIDATION_FAILED` with `details: [{ path, message }]`. `express-validator` and `helpers/db-validators` are removed with the last module. Existence checks (`existCategoryById`, …) move **into services** as find-active-or-404, not validators. | One source of truth for shape+type+message; DTOs are the inferred TS types; removes the "existence check before isMongoId → double query / duplicate error" debt (VAL-01) and the raw express-validator error body (HTTP-01). | `req.query`/`req.params` are getter-only in Express 5, so `validate` writes the parsed value with `Object.defineProperty` (verified); `req.body` is reassigned normally. |
| **ADR-030** | **Media = Cloudinary only (ADR-008).** `POST /api/uploads` (local disk) is **removed**. `PUT /api/uploads/:collection/:id` keeps C10 scope + C11 order, adds **magic-byte MIME sniffing** (PNG/JPEG/GIF, no new dependency), maps parser errors → **400** (HTTP-02) and the 5 MB limit → **413 with a JSON envelope** (F4). `GET /api/uploads/:collection/:id` **302-redirects** to the stored Cloudinary URL, or 404 when the record has none (FUNC-01); local-disk serving is gone. | ADR-008 + the M3 debt list (FUNC-01, HTTP-02, F4, SEC-08 MIME). Magic bytes need no library, honouring "prefer no dependency". | `assets/notFound.jpg`, the `uploads/` dir and the disk-serving path are removed at media cut-over; the demo page's local-image expectation is CQ-07 (M8). |

### 1.2 Decisions inside existing ADRs (no new ADR)

- **Response shaping vs M4's `toJSON` plugin — reconciled (this is the brief's explicit ask).** M3 needs a consistent `id` **now** (3.0.0), and M4-database.md §1–§2 **already calls `toJsonPlugin(schema, { hidden?, uidAlias? })`** at `src/core/database/to-json.plugin.ts`. So **M3 authors that plugin, with exactly that signature**, and applies it to each ported model; M4 keeps ownership of *what each schema hides* and adds timestamps/indexes/enum/email-normalisation, **calling the same plugin**. No double work: M3 does not write per-controller mappers, M4 does not re-author serialization. The plugin emits `id` (string), drops `_id`/`__v`/hidden fields, and adds a `uid` alias **only** where the legacy model already exposed one (User), removed in 4.0.0 (ADR-024). Verified: the built categories responses carry `id`, no `_id`, no `uid`.
- **Stored shape unchanged (scope fence).** M3 models declare the **same fields** as the legacy schemas (no timestamps, no enum on `role`, no `select:false`, no `lowercase` email, no index changes — all M4). M3 changes only the **API** shape (envelope + `id`) and the **code** (TS, DI). Verified: `category.model.ts` mirrors `models/category.js` field-for-field.
- **Express 5 async handlers need no wrapper.** Controllers and `authenticate` are `async`; Express 5 forwards a rejected promise to the error handler (relied on in M2, re-confirmed). No `asyncHandler`.
- **No new runtime dependency.** `jsonwebtoken`, `zod`, `pino` are already present; MIME sniffing is hand-rolled. The only new package is the devDep **`@types/jsonwebtoken` 9.0.10** (pinned; ADR-025, well over 24 h old), needed because `core/security/jwt.ts` imports `jsonwebtoken`.
- **`VENTAS_ROLE`** stays a valid role string (it appears in `DELETE /api/user`'s `hasRole('ADMIN_ROLE','VENTAS_ROLE')`); the `ROLES` enum includes it. The decision about it is M6 (SEC-13).

---

## 2. Target tree after M3, and the order legacy disappears

```
src/
├── server.ts  app.ts  legacy.ts(DELETED at the end)   config/  (unchanged from M2)
├── core/
│   ├── errors/            (+ RateLimitedError, §5-auth; otherwise M2)
│   ├── http/
│   │   ├── envelope.ts     (M2; now consumed)
│   │   └── pagination.ts   NEW  paginationQuerySchema (DUP-01)
│   ├── logger.ts           (M2)
│   ├── security/
│   │   ├── roles.ts        NEW  ROLES / DEFAULT_ROLE / isRole (ADR-007 enum, code-level)
│   │   └── jwt.ts          NEW  createTokenService (x-token; M5 extends)
│   └── database/
│       └── to-json.plugin.ts   NEW  toJsonPlugin (id, hidden, uidAlias) — shared with M4
├── middlewares/
│   ├── request-logger.ts  not-found.ts        (M2)
│   ├── error-handler.ts   (M2 → emits errorEnvelope)
│   ├── validate.ts        NEW  validate(part, schema) → 422 + details
│   ├── authenticate.ts    NEW  x-token auth (ADR-028)
│   └── authorize.ts       NEW  requireAdmin, requireSelfOrAdmin (ADR-028)
├── types/express.d.ts     NEW  Request.user augmentation
└── modules/
    ├── categories/  {category.model,category.schemas,category.service,category.controller,category.routes,index}.ts
    ├── users/       users.* (+ user.model.ts)
    ├── auth/        auth.* (+ google.client.ts; reuses users' UserModel)
    ├── products/    product.* (+ product.model.ts)
    ├── search/      search.{service,controller,routes}.ts (no model; reads the three models)
    └── media/       media.{service,controller,routes,cloudinary.client}.ts (no model; reads User/Product)
tests/
├── unit/{config,envelope,errors,logger}.test.ts (M2) + unit/modules/<x>.service.test.ts NEW
├── integration/platform/* (M2; error-body assertions re-expressed, §7)
└── integration/{modules,security}/*  (M1 suite re-expressed per module, §7)
```

**Order legacy disappears** (one `LEGACY_ROUTES` entry removed per module cut-over):

| Wave | Module lands | `src/legacy.ts` entry removed | legacy files retired / made registry re-exports |
|---|---|---|---|
| 1 | core middlewares (no route change) | — | — |
| 2 | **categories** (reference) | `/api/category` | `models/category.js`→registry re-export; `routes/category.js`, `controllers/category.js` deleted |
| 3a | users | `/api/user` | `models/user.js`→re-export; `routes/usuarios.js`, `controllers/usuarios.js` deleted |
| 3b | auth | `/api/auth` | `routes/auth.js`, `controllers/auth.js`, `helpers/generar-jwt.js`, `helpers/google-verify.js`, `middlewares/rate-limit.js` deleted |
| 3c | products | `/api/product` | `models/product.js`→re-export; `routes/products.js`, `controllers/product.js` deleted |
| 3d | search | `/api/search` | `routes/search.js`, `controllers/search.js` deleted |
| 3e | media | `/api/uploads` + `/hello` | `routes/uploads.js`, `controllers/uploads.js`, `helpers/upload-file.js`, `middlewares/file-valid.js`, `assets/`, `uploads/` |
| 4 | **legacy removal** | file deleted | `src/legacy.ts`, `tests/helpers/legacy.ts`, `models/index.js`, `helpers/{index,db-validators}.js`, `middlewares/{index,validar-jwt,validar-roles,validar-campos}.js`, `models/role.js`, the legacy ESLint block, `express-validator` (dependency) |

Wave 4 runs only after every route is migrated; at that point `grep -r "require(" src/legacy.ts` and the whole `LEGACY_DIRS` set are gone, and `express-validator` has zero importers.

---

## 3. Core additions (as validated TypeScript)

All signatures below compiled, linted and ran in the prototype.

### 3.1 `validate(part, schema)` — `src/middlewares/validate.ts` (P9)

```ts
import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { ValidationError, type ValidationIssue } from '../core/errors';

type Part = 'body' | 'query' | 'params';

/** Validates one request part; on failure throws ValidationError → 422 with details. Replaces express-validator. */
export const validate =
  (part: Part, schema: ZodType): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      const details: ValidationIssue[] = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      throw new ValidationError(details);
    }
    if (part === 'body') req.body = result.data;
    else Object.defineProperty(req, part, { value: result.data, configurable: true }); // Express 5: query/params are getters
    next();
  };
```

`ValidationError` (M2, 422, `code: 'VALIDATION_FAILED'`) already carries `details`; the error handler now surfaces them (§3.5). Verified: `POST /api/category {name:''}` → `422 { error:{ code:'VALIDATION_FAILED', message:'Validation failed', details:[{path:'name',…}] } }`; `GET /api/category/not-an-id` → 422.

### 3.2 `authenticate` (x-token) — `src/middlewares/authenticate.ts` (P10)

```ts
export interface AuthUser { id: string; role: string; name: string; state: boolean }
interface LookupUser { _id: unknown; role: string; state: boolean; name: string }
export interface UserLookup { findById(id: string): PromiseLike<LookupUser | null> }

/** ADR-028: same 401 semantics as legacy validarJWT (C4). Async → Express 5 forwards the rejection. */
export const authenticate =
  (deps: { tokens: TokenService; users: UserLookup }): RequestHandler =>
  async (req, _res, next) => {
    const header = req.header('x-token');
    if (!header) throw new UnauthorizedError('No token in the request');
    let uid: string;
    try { uid = deps.tokens.verify(header).uid; } catch { throw new UnauthorizedError('Invalid token'); }
    const user = await deps.users.findById(uid);
    if (!user || !user.state) throw new UnauthorizedError('Invalid token');
    req.user = { id: String(user._id), role: user.role, name: user.name, state: user.state };
    next();
  };
```

`req.user` is typed by `src/types/express.d.ts` (`declare global { namespace Express { interface Request { user?: AuthUser } } }`). C4 preserved: missing/invalid token → 401. **Cross-module wiring (ADR-027):** the composition root passes `users` resolved from the owning module — `UserModel` once `users` is migrated, and until then `{ findById: (id) => db.model('User').findById(id) }` (lazy; the legacy `User` is registered by the time a request arrives). Verified this removes the `MissingSchemaError` the eager form caused.

### 3.3 Interim guards — `src/middlewares/authorize.ts` (P10)

```ts
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (requireUser(req).role !== 'ADMIN_ROLE') throw new ForbiddenError('Administrator role required');
  next();
};
export const requireSelfOrAdmin = (idParam = 'id'): RequestHandler => (req, _res, next) => {
  const user = requireUser(req);
  if (user.role !== 'ADMIN_ROLE' && user.id !== req.params[idParam]) throw new ForbiddenError('Owner or administrator required');
  next();
};
// requireUser throws UnauthorizedError when req.user is absent (defence in depth; authenticate runs first).
```

Preserves today's semantics: `esAdminRole`→`requireAdmin` (403), `esAdminOrOwner`→`requireSelfOrAdmin` (403), `hasRole('ADMIN_ROLE','VENTAS_ROLE')` on `DELETE /api/user` → a `requireRole('ADMIN_ROLE','VENTAS_ROLE')` variant (same file). M6 replaces all three with `authorize(policy)`.

### 3.4 Pagination — `src/core/http/pagination.ts` (P12, DUP-01)

```ts
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(5),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
```

One schema for every list route (categories, products, users), replacing the three copies of the M1 `parseInt/clamp` block. Consumed by ≥ 3 modules → clears the DUP-01 pagination duplication. Verified: `GET /api/category` → `meta:{ total, limit:5, offset:0 }`.

### 3.5 Error-handler switch to the envelope — `src/middlewares/error-handler.ts` (P11, ADR-021)

```ts
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const appError = toAppError(err);
  if (!(err instanceof AppError) || appError.status >= 500) res.err = err instanceof Error ? err : appError;
  if (res.headersSent) { next(err); return; }
  res.status(appError.status).json(errorEnvelope(appError)); // 3.0.0: was res.json({ msg: appError.message })
};
```

`toAppError` (M2) is unchanged — the C1 mapping (11000→409, ValidationError/CastError→400, http client 4xx, else 500) still holds; only the *body* changes from `{ msg }` to `{ error: { code, message, details? } }`. This is the single global 3.0.0 change; §7 maps every affected assertion. Verified: 404/400/409/500 now emit the envelope with the correct `code`.

### 3.6 `core/security` — `roles.ts`, `jwt.ts`

```ts
// roles.ts (ADR-007 code-level enum; no Role collection lookup)
export const ROLES = ['ADMIN_ROLE', 'USER_ROLE', 'VENTAS_ROLE'] as const;
export type Role = (typeof ROLES)[number];
export const DEFAULT_ROLE: Role = 'USER_ROLE';
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

// jwt.ts (interim: same payload/secret/4h TTL as helpers/generar-jwt.js; M5 adds iss/aud/tokenVersion)
export interface TokenService { sign(uid: string): Promise<string>; verify(token: string): { uid: string } }
export function createTokenService(secret: string): TokenService { /* jwt.sign/verify, throws on malformed */ }
```

`roles.ts` also feeds M4's `user.model.ts` (`enum: ROLES, default: DEFAULT_ROLE`) — the M4 design imports exactly these names, so M3 authoring them is consistent, not a conflict. `core/security/hashing` is **not** added in M3: bcrypt hashing stays inline in the users/auth services as today (async hashing is PERF-01/M5); adding a hashing abstraction now would be speculative (no second consumer).

### 3.7 `toJsonPlugin` — `src/core/database/to-json.plugin.ts` (P13, shared with M4)

```ts
export interface ToJsonOptions { hidden?: readonly string[]; uidAlias?: boolean }
export function toJsonPlugin(schema: Schema, options: ToJsonOptions = {}): void {
  const hidden = new Set(options.hidden ?? []);
  schema.set('toJSON', { virtuals: false, versionKey: false, transform(_doc, ret) {
    const id = String(ret._id); delete ret._id; delete ret.__v;
    for (const f of hidden) delete ret[f];
    return { id, ...(options.uidAlias ? { uid: id } : {}), ...ret };
  }});
}
```

Applied as `toJsonPlugin(categorySchema)` / `toJsonPlugin(productSchema)` (id, no alias) and `toJsonPlugin(userSchema, { hidden:['password'], uidAlias:true })`. M4 extends the hidden list (`tokenVersion`) and adds timestamps/indexes to the same schemas — signature identical to M4-database.md §2.

---

## 4. The reference module: `categories` (in full)

Every file below is from the validated prototype. The other modules follow this anatomy.

### 4.1 Model — `src/modules/categories/category.model.ts` (same stored shape as `models/category.js`)

```ts
import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { toJsonPlugin } from '../../core/database/to-json.plugin';

const categorySchema = new Schema(
  { name:  { type: String, required: [true, 'The name is required'], unique: true },
    state: { type: Boolean, required: true, default: true },
    user:  { type: Schema.Types.ObjectId, ref: 'User', required: true } },
  { versionKey: false },
);
toJsonPlugin(categorySchema); // id; no _id/__v; no uid alias (category never exposed uid)

export type Category = InferSchemaType<typeof categorySchema>;
export type CategoryDocument = HydratedDocument<Category>;
// Sole registrant of 'Category'; guard makes re-import idempotent (Vitest/tsx). ADR-027.
export const CategoryModel =
  (mongoose.models.Category as mongoose.Model<Category>) ?? mongoose.model<Category>('Category', categorySchema);
```

**Registry seam (ADR-027).** `models/category.js` becomes:

```js
// Migrated to TS in M3; the TS model is the sole registrant. Legacy consumers read from the registry.
module.exports = require('mongoose').model('Category');
```

so `models/index.js`, `helpers/db-validators.js` (`existCategoryById`) and `controllers/search.js` (still legacy in wave 2) keep working with **one** registration. Requirement proven in the prototype: `createApp` imports the categories module (registering `Category`) before `mountLegacyRoutes` requires the legacy routers, so the re-export resolves. M4 later replaces this file's schema body with timestamps/indexes on the same model.

### 4.2 Schemas (DTOs) — `category.schemas.ts`

```ts
export { paginationQuerySchema } from '../../core/http/pagination';
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a Mongo id');
export const categoryIdParams = z.object({ id: objectId });
export const createCategoryBody = z.object({ name: z.string().trim().min(1) });
export const updateCategoryBody = z.object({ name: z.string().trim().min(1) });
export type CreateCategoryDto = z.infer<typeof createCategoryBody>;
export type UpdateCategoryDto = z.infer<typeof updateCategoryBody>;
```

The `objectId` regex replaces `isMongoId` + the `existCategoryById` custom validator; **existence** is the service's job (§4.3), so a valid-but-missing id is a service 404, not a validation 422 (fixes VAL-01's double-query/duplicate-error).

### 4.3 Service factory — `category.service.ts` (owns rules + persistence; throws AppError; DI, ADR-005)

```ts
export function createCategoriesService(deps: { Category: Model<Category> }): CategoriesService {
  const { Category } = deps;
  const activeOr404 = async (id: string) => {
    const doc = await Category.findOne({ _id: id, state: true }).populate('user', 'name');
    if (!doc) throw new NotFoundError('Category not found');
    return doc;
  };
  return {
    async list(q) {
      const filter = { state: true };
      const [items, total] = await Promise.all([
        Category.find(filter).skip(q.offset).limit(q.limit).populate('user', 'name'),
        Category.countDocuments(filter),
      ]);
      return { items, total };
    },
    getActive: activeOr404,
    async create(dto, userId) {
      const name = dto.name.toUpperCase();
      if (await Category.exists({ name, state: true })) throw new ConflictError('Category already exists');
      return Category.create({ name, user: userId });
    },
    async update(id, dto, userId) {
      await activeOr404(id);
      const doc = await Category.findByIdAndUpdate(id, { name: dto.name.toUpperCase(), user: userId },
        { returnDocument: 'after' }).populate('user', 'name');
      if (!doc) throw new NotFoundError('Category not found');
      return doc;
    },
    async softDelete(id) {
      const doc = await Category.findOneAndUpdate({ _id: id, state: true }, { state: false });
      if (!doc) throw new NotFoundError('Category not found');
    },
  };
}
```

`activeOr404` is the proven **find-active-or-404** shape reused by users/products/media (DUP-01, §6). It stays a per-service local until the third module needs it, then extracts to `src/core/http/` — not before (YAGNI). Duplicate check → `ConflictError` (409) preserves C1's 11000 mapping as the race backstop.

### 4.4 Controller — `category.controller.ts` (thin; validated DTO → one service call → envelope)

```ts
export function createCategoriesController(service: CategoriesService) {
  const list: RequestHandler = async (req, res) => {
    const q = req.query as unknown as PaginationQuery;
    const { items, total } = await service.list(q);
    res.status(200).json(pageEnvelope(items, { total, limit: q.limit, offset: q.offset }));
  };
  const getOne: RequestHandler = async (req, res) => {
    const { id } = req.params as { id: string };
    res.status(200).json(envelope(await service.getActive(id)));
  };
  const create: RequestHandler = async (req, res) =>
    void res.status(201).json(envelope(await service.create(req.body as CreateCategoryDto, req.user!.id)));
  const update: RequestHandler = async (req, res) => {
    const { id } = req.params as { id: string };
    res.status(200).json(envelope(await service.update(id, req.body as UpdateCategoryDto, req.user!.id)));
  };
  const remove: RequestHandler = async (req, res) => {
    const { id } = req.params as { id: string };
    await service.softDelete(id); res.status(204).end();
  };
  return { list, getOne, create, update, remove };
}
```

No Mongoose, no rules (§2.3 rule 2 — lint-enforced: `*.controller.ts` may not import `mongoose`/`*.model`). Validated inputs are read with a narrow cast (`req.query`/`req.params` are typed loosely by Express; the value was already parsed by `validate`). `req.user!` is safe on routes behind `authenticate`.

### 4.5 Routes — `category.routes.ts` (path + middleware + controller only, §2.3 rule 1)

```ts
export function createCategoriesRouter(deps: CategoryRouteDeps): Router {
  const { controller, authenticate, requireAdmin } = deps;
  const router = Router();
  router.get('/',      validate('query', paginationQuerySchema), controller.list);
  router.get('/:id',   validate('params', categoryIdParams), controller.getOne);
  router.post('/',     authenticate, validate('body', createCategoryBody), controller.create);
  router.put('/:id',   authenticate, requireAdmin, validate('params', categoryIdParams), validate('body', updateCategoryBody), controller.update);
  router.delete('/:id',authenticate, requireAdmin, validate('params', categoryIdParams), controller.remove);
  return router;
}
```

Middleware order matches the legacy chain (auth → authz → validate → controller). Routes import no model/service/SDK (lint-enforced).

### 4.6 Composition — `index.ts` and `app.ts`

```ts
// modules/categories/index.ts
export function categoriesModule(deps: { authenticate: RequestHandler; requireAdmin: RequestHandler; Category?: Model<Category> }) {
  const service = createCategoriesService({ Category: deps.Category ?? CategoryModel });
  return createCategoriesRouter({ controller: createCategoriesController(service), authenticate: deps.authenticate, requireAdmin: deps.requireAdmin });
}
```

```ts
// src/app.ts (added; the /api/category entry is removed from src/legacy.ts)
const tokens = createTokenService(config.auth.jwtSecret);
const users = { findById: (id: string) => CategoryModel.db.model('User').findById(id) }; // ADR-027 lazy; → usersModule.UserModel once users lands
const auth = authenticate({ tokens, users });
app.use('/api/category', categoriesModule({ authenticate: auth, requireAdmin }));
// … other migrated modules …
mountLegacyRoutes(app); // remaining legacy routers
```

`createApp` stays the only composition root (§2.3, ADR-005). Each module task adds its `app.use(...)` line and deletes its `src/legacy.ts` entry.

### 4.7 Tests (both proven)

- **Integration** `tests/integration/modules/categories.test.ts` (3 blocks, green): the full contract table for #9–#13 (envelope, `id`/no `_id`/no `uid`, 200/201/204, 401 without token, 422 bad body with `details`, 409 duplicate, 403 non-admin PUT, 404 missing/soft-deleted, 422 bad id). Uses the M2 harness (`startTestApp` on 127.0.0.1 — AM-5, TEST-02) and factories.
- **Unit** `tests/unit/modules/category.service.test.ts` (3 blocks, green): `createCategoriesService({ Category: fake })` with a hand-written fake — create uppercases + passes owner; duplicate → `ConflictError`; missing → `NotFoundError`. No DB, no `vi.mock` (ADR-023).

---

## 5. Per-module deltas

Each module = the categories anatomy. Only the differences are listed; DTOs are zod, rules move into the service, responses use the envelope, models keep the legacy stored shape + `toJsonPlugin`.

### 5.1 `users` (routes #4–#8)
- **Model** `user.model.ts`: legacy fields (name/email/password/image/role/state/google); `toJsonPlugin(userSchema, { hidden:['password'], uidAlias:true })` → keeps the legacy `uid` **and** adds `id`. Sole registrant; `models/user.js`→registry re-export. Exports `UserModel`, consumed by `auth` and by `authenticate` (replaces the ADR-027 lazy stub in `app.ts`).
- **DTOs:** `createUserBody { name, email(email), password(min 8) }` (role never accepted — SEC-02); `updateUserBody { name?, password?, role?, state? }` with **role/state applied only for admins** in the service (C6 whitelist; email/google/image/_id never writable); `paginationQuerySchema` for list.
- **Service:** `list` (admin), `create` (bcrypt hash, force `USER_ROLE`, duplicate email → 409 via C1 or an explicit `exists` check), `update` (whitelist by caller role), `softDelete`.
- **Rules kept:** `GET /api/user` admin-only; `PUT /:id` self-or-admin (`requireSelfOrAdmin`); `DELETE /:id` `requireRole('ADMIN_ROLE','VENTAS_ROLE')`. `usuariosPatch` stub and `PATCH /api/user` **removed** (CQ-02).
- **Contract:** POST 200→**201**; DELETE 201→**204** and the CQ-05 `{userDelete,userAuthenticated}` body is gone; list `{total,user}`→`pageEnvelope`; non-string `name`/body caught by the DTO → **422** (fixes F3/VAL-02 mass-assignment).

### 5.2 `auth` (routes #2–#3)
- **No model.** Reuses `users`' `UserModel` and a `google.client.ts` wrapping `OAuth2Client` (SDK behind a `*.client.ts`, injected — lint-enforced). `createTokenService` from core.
- **Behaviour identical to today (M5 owns the hardening):** the F1 constant-time login (`DUMMY_HASH` + `BCRYPT_HASH` guard) is carried over verbatim into the service; generic 401 `Invalid credentials` (C5); Google failure/blocked → 401; the placeholder `':D'` password and `email_verified` stay untouched (SEC-12/M5).
- **Rate limiter:** the shared 10/15 min/IP limiter (C5) moves to `auth.routes.ts`; its `handler` calls `next(new RateLimitedError())` so the **429 body is the envelope** (adds `RateLimitedError(429,'RATE_LIMITED')` to `core/errors`; the only `ErrorCode` addition). Budget still shared by login+google.
- **Contract:** success body `{user, token}` → `envelope({ token, user })`; token stays in the body, transport stays `x-token` (M5 → Bearer). 429 body `{msg}`→envelope.

### 5.3 `products` (routes #14–#18) — mechanical mirror of `categories`
- **Model** `product.model.ts`: legacy fields (name/state/user/price/category/description/available/image); `toJsonPlugin(productSchema)` (id, no alias). `models/product.js`→registry re-export.
- **DTOs:** `createProductBody { name, price?, category(objectId), description?, available? }` — **no `_id`, no `user`, no `image`** (fixes VAL-02 mass-assignment of `_id`/`image`); `updateProductBody` same, all optional; `category` existence checked in the service (active category or 422/404). `image` is set only by the media module.
- **Service:** name uppercased before the duplicate check (kept from M1); `list`/`getActive` populate user+category; soft delete.
- **Contract:** GET list/by-id 201→**200**; POST **201**; PUT **200**; DELETE 201→**204**; `_id`→`id`; envelope. Because it mirrors categories field-for-field in structure, this is a **DATABASE-AGENT-suitable** mechanical task against the categories template.

### 5.4 `search` (route #19) — no model, cross-model reads
- **Service** `createSearchService({ User, Category, Product })` — injected models (from the three modules' registrations). Keeps the M1 behaviour exactly: allowlist `{user,category,product}` (role removed → 400), `isObjectIdOrHexString` id lookup (active only), escaped-regex substring, `≤ 20` results, `sanitizeFilter` on (M2). PERF-02 substring semantics are kept until M4's documented trigger.
- **Auth:** `user` collection stays admin-only (`authenticate`+`requireAdmin` on that branch); category/product public — same as the legacy `protectUserSearch`, re-expressed as route middleware keyed on the decoded `:collection`.
- **Contract:** body `{results:[…]}` → `envelope(items)` (`{data:[…]}`); items serialize with `id` (category/product) / `id`+`uid` (user). Unknown collection → **400** (kept). This is a **small** task.

### 5.5 `media` (routes #20–#22) — ADR-030
- **No model.** Reads `User`/`Product`; wraps Cloudinary in `cloudinary.client.ts` (injected). Keeps the M2 `fileParser` (C10 scope: multipart only here, after auth; one file; per-request temp dir removed on every exit) — moved into the module.
- **`POST /api/uploads` (#20) removed** (local disk, ADR-008). 404 after removal.
- **`PUT /api/uploads/:collection/:id` (#21):** `authenticate` → `requireSelfOrAdmin`-style (user: owner-or-admin; product: admin) → param DTO (`collection ∈ {user,product}`, `id` objectId) → `fileParser` → **MIME sniff** (magic bytes: PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `47 49 46 38`; mismatch → 400) → service: **upload → save → destroy old** (C11 order preserved), best-effort destroy logged via `req.log`. Parser errors → **400** (HTTP-02); > 5 MB → **413 with the JSON envelope** (F4) via the limiter/`abortOnLimit` handler mapped through the error handler.
- **`GET /api/uploads/:collection/:id` (#22):** loads the record; if `image` is a Cloudinary URL → **302 redirect** to it (FUNC-01); else **404** (no local-disk serving). `assets/notFound.jpg` and `uploads/` are deleted.
- **Contract:** #20 removed; #21 success body `envelope(record)` (id); #22 200-file → **302** (or 404). This is a **SECURITY & QA** task (MIME, media policy, C10/C11).

---

## 6. The 3.0.0 HTTP contract table (all 23 entry points)

Auth column = enforced. Success = status + body. All error bodies are the envelope `{ error:{ code, message, details? } }`. "env(x)" = `{data:x}`; "page(x)" = `{data:x, meta:{total,limit,offset}}`.

| # | Route | 3.0.0 auth | Request DTO | Success | Key errors |
|---|---|---|---|---|---|
| 1 | GET `/hello` | — | — | **removed** (404) | CQ-02 |
| 2 | POST `/api/auth/login` | none, limited | `{email,password}` | 200 `env({token,user})` | 401 `UNAUTHORIZED`; 422; 429 `RATE_LIMITED` |
| 3 | POST `/api/auth/google` | none, limited | `{id_token}` | 200 `env({token,user})` | 401; 422; 429 |
| 4 | GET `/api/user` | admin | `?limit&offset` | 200 `page(users)` | 401/403; 422 (bad query) |
| 5 | POST `/api/user` | none | `{name,email,password}` | **201** `env(user)` | 422; 409 (dup email) |
| 6 | PUT `/api/user/:id` | self-or-admin | `{name?,password?,role?(admin),state?(admin)}` | 200 `env(user)` | 401/403; 404; 422 |
| 7 | DELETE `/api/user/:id` | admin\|ventas | `:id` | **204** | 401/403; 404 |
| 8 | PATCH `/api/user` | — | — | **removed** (404) | CQ-02 |
| 9 | GET `/api/category` | none | `?limit&offset` | **200** `page` | 422 |
| 10 | GET `/api/category/:id` | none | `:id` | **200** `env` | 404 (missing/soft-deleted); 422 (bad id) |
| 11 | POST `/api/category` | any auth | `{name}` | 201 `env` | 401; 422; 409 |
| 12 | PUT `/api/category/:id` | admin | `{name}` | **200** `env` | 401/403; 404; 422; 409 |
| 13 | DELETE `/api/category/:id` | admin | `:id` | **204** | 401/403; 404 |
| 14 | GET `/api/product` | none | `?limit&offset` | **200** `page` | 422 |
| 15 | GET `/api/product/:id` | none | `:id` | **200** `env` | 404; 422 |
| 16 | POST `/api/product` | any auth | `{name,price?,category,description?,available?}` | 201 `env` | 401; 422; 409 |
| 17 | PUT `/api/product/:id` | admin | product fields (all optional) | **200** `env` | 401/403; 404; 422; 409 |
| 18 | DELETE `/api/product/:id` | admin | `:id` | **204** | 401/403; 404 |
| 19 | GET `/api/search/:collection/:term` | user→admin; else none | `:collection,:term` | 200 `env(items)` | 400 (bad collection); 401/403 (user) |
| 20 | POST `/api/uploads` | — | — | **removed** (404) | ADR-008 |
| 21 | PUT `/api/uploads/:collection/:id` | user: owner/admin; product: admin | multipart 1 file ≤5 MB | 200 `env(record)` | 401/403; 404; 400 (MIME/parse); 413; 422 |
| 22 | GET `/api/uploads/:collection/:id` | none | `:collection,:id` | **302** → Cloudinary URL | 404 (no image); 422 |
| 23 | GET `/` static | none | — | 200 (unchanged) | CQ-07 (M8) |

**Proposed API_PROGRESS ledger rows (M3):**
- Response envelope on every route: success `{data}` / `{data,meta}`, errors `{error:{code,message,details?}}` (was `{msg}` / bare `{results}`/`{total,…}`).
- Status corrections: GET 200 (was 201), POST 201, DELETE **204**, validation **422** (was 400), missing/soft-deleted **404**.
- Consistent `id` on every resource; `_id` never exposed; `uid` kept as a deprecated alias on users only (removed 4.0.0).
- `GET /hello`, `PATCH /api/user`, `POST /api/uploads` **removed**.
- Media: `GET /api/uploads/:collection/:id` **302-redirects** to the Cloudinary URL; uploads MIME-sniffed; parse error 400, oversize 413 JSON.
- Search returns `{data:[…]}` (was `{results:[…]}`).

**CHANGELOG (3.0.0) Breaking** = the six bullets above, each mapped to affected routes.

---

## 7. Test strategy

**Runtime today:** 248 cases across 19 files (154 `test(` blocks; `test.each` expands). Target after M3: the same behaviours, re-expressed for 3.0.0, plus per-module unit tests.

### 7.1 Where tests move
- **M1 security suite** (`tests/integration/security/*`, the C1–C11 + SEC coverage): each file's route assertions move to its module's test as that module lands; the security **invariants** (authz, C10/C11, rate limit, SEC-04, sanitizeFilter) stay and keep their status codes — only bodies become the envelope. `tests/helpers/legacy.ts` and `factories`' legacy-model creation are replaced by TS-model factories in wave 4.
- **M2 platform tests** (`tests/integration/platform/*`) stay; `app.test.ts` "C1/C2 bodies" and `reliability.test.ts` C1/C2 are re-expressed once (the envelope switch, T3.1). `database.test.ts` (sanitizeFilter), `server.test.ts` (boot), `trust-proxy.test.ts`, `harness.test.ts` keep their guarantees (the last two only change any error body they assert).
- **New:** `tests/unit/modules/<x>.service.test.ts` per module (fakes, ADR-023); `tests/integration/modules/<x>.test.ts` per module (the contract table).

### 7.2 Assertion-mapping table (the bounded 3.0.0 drift — measured, not guessed)

Flipping the error handler to the envelope produced **exactly 23 failing assertions** in the current suite, every one an old-body assertion. That is the complete list of what changes; **nothing else changed** (no new failures, crashes, or schema errors). The mechanical mapping:

| Old assertion | New assertion | Count seen | Owner |
|---|---|---|---|
| `body == { msg: 'Route not found' }` | `body == { error:{ code:'NOT_FOUND', message:'Route not found' } }` | 4 | T3.1 |
| `body == { msg: 'Invalid request data' }` (400) | `error.code == 'BAD_REQUEST'` | 6 | T3.1 |
| `body == { msg: 'Resource already exists' }` | `error.code == 'CONFLICT'` | 2 | T3.1 |
| `body == { msg: 'Internal server error' }` | `error.code == 'INTERNAL'` | 7 | T3.1 |
| `Object.keys(body) == ['msg']` | `Object.keys(body) == ['error']` | 2 | T3.1 |
| validation `400` (express-validator body) | `422`, `error.code=='VALIDATION_FAILED'`, `details[]` | per module | module task |
| list `{ total, xs }`, GET/DELETE `201` | `page(...)`/`env(...)`, GET 200 / DELETE 204 | per module | module task |
| resource `_id` / `res.body.category._id` | `id` | 1 (search) + per module | module task |
| success `{ user, token }`, `{ results }` | `env({token,user})`, `env(items)` | auth, search | module task |

**Contract:** every other assertion — status codes for 401/403/429, the security invariants, request-id, redaction, fail-fast, `sanitizeFilter`, C10/C11 — is **unchanged**. T3.1 owns the 21 global error-body assertions (the first five rows); each module task owns its own route rows as it migrates. The T3.8 review re-runs the full suite and confirms zero un-mapped drift.

### 7.3 Unit tests, coverage, hygiene
- **Unit:** every service has a fake-injected unit test (proven for categories). Target: services ≥ 90% lines (M7 raises the global gate); the `src/**/*.ts` ≥ 90/90/80/90 coverage gate (M2) stays and now covers `src/modules/**`.
- **Coverage config:** drop the `controllers/**`, `helpers/**`, `models/**`, `routes/**`, `middlewares/**` legacy globs from `vitest.config.mts` as each dir empties; at wave 4 only `src/**/*.ts` remains.
- **Hygiene (TEST-02/03):** keep AM-5 (`startTestApp` serves on 127.0.0.1, `Connection: close`); no test writes a shared FS path — the media module's Cloudinary client is stubbed via `tests/helpers/legacy.ts`'s successor (a TS `stubCloudinary` on the injected client), so no `uploads/` writes (TEST-03 root cause removed with the local-disk path).

---

## 8. Task breakdown

P-numbers continue from M2 (P1–P8). New shared contracts:

| ID | Contract | Owner | Consumers |
|---|---|---|---|
| P9 | `validate(part,schema)` → 422 + `details` (§3.1) | T3.1 | every module |
| P10 | `authenticate({tokens,users})` (x-token) + `requireAdmin`/`requireSelfOrAdmin`/`requireRole` (§3.2–3.3) | T3.1 | every protected route |
| P11 | error handler emits `errorEnvelope`; controllers use `envelope`/`pageEnvelope` (§3.5) | T3.1 | every module |
| P12 | `paginationQuerySchema` (§3.4) | T3.1 | categories, users, products |
| P13 | `toJsonPlugin(schema,{hidden,uidAlias})` (§3.7) — **shared with M4** | T3.1 | every model; M4 |
| P14 | Registry seam (ADR-027): migrated `models/<x>.js`→registry re-export; TS model sole registrant+guard; composition resolves cross-module models lazily/from owner | T3.2 (pattern) | every module task |
| P15 | Module anatomy + `xModule(deps): Router` composition signature (§4) | T3.2 (reference) | every module task |

### Sequence

```
core (T3.1) ─► categories reference (T3.2, REVIEW GATE) ─┬─► users (T3.3)
                                                          ├─► auth (T3.4, needs users' UserModel)
                                                          ├─► products (T3.5)
                                                          ├─► search (T3.6)
                                                          └─► media (T3.7)
   ─► legacy removal (T3.8) ─► ARCHITECT review (T3.9) ─► Orchestrator close (T3.10)
```

Files are **disjoint** across the parallel wave: each module owns `src/modules/<x>/**`, its `tests/**/<x>*`, its legacy `routes/<x>.js`+`controllers/<x>.js`(+`models/<x>.js`), and its one line in `src/app.ts`+`src/legacy.ts`. **`src/app.ts` and `src/legacy.ts` are the one shared edit surface** — serialize those one-line edits through the integration branch (each module task rebases before adding its line), or the Orchestrator applies them at merge. Everything else is disjoint.

| Task | Agent | Files allowed | Required | Acceptance | Commits |
|---|---|---|---|---|---|
| **T3.1 core** | BACKEND | `src/middlewares/{validate,authenticate,authorize}.ts`, `src/core/http/pagination.ts`, `src/core/security/{roles,jwt}.ts`, `src/core/database/to-json.plugin.ts`, `src/core/errors/*` (+`RateLimitedError`), `src/middlewares/error-handler.ts`, `src/types/express.d.ts`, `package.json`/lockfile (`@types/jsonwebtoken`), the 5 global error-body assertion groups in `tests/integration/platform/*` + `security/reliability.test.ts` | §3 verbatim; add `@types/jsonwebtoken@9.0.10`; flip error handler to envelope; re-express the 21 global error-body assertions (§7.2 rows 1–5) | typecheck+lint+build green; unit tests for `validate`/`toJsonPlugin`/`roles`; full suite green (only the 21 mapped assertions changed); `pnpm audit --prod` 0 | `feat(core): validate + zod DTOs`; `feat(core): interim authenticate and role guards`; `feat(core): toJsonPlugin + roles + jwt`; `feat(core)!: error responses use the envelope` |
| **T3.2 categories (reference, GATE)** | BACKEND | `src/modules/categories/**`, `tests/{unit/modules,integration/modules}/categor*`, `models/category.js`, `routes/category.js`, `controllers/category.js`, `src/app.ts`+`src/legacy.ts` (category line) | §4 verbatim; registry seam (P14); remove `/api/category` legacy entry + files; re-express category rows of `security/reliability.test.ts`/`search.test.ts` | contract test (§4.7) green; unit test green; no `OverwriteModelError`/`MissingSchemaError`; full suite green; layer lint clean | `feat(categories): TS module`; `refactor(categories): remove legacy router (ADR-027)` |
| **T3.3 users** | BACKEND | `src/modules/users/**`, `tests/**/users*`, `models/user.js`, `routes/usuarios.js`, `controllers/usuarios.js`, app/legacy line | §5.1; export `UserModel`; C6 whitelist; remove PATCH stub | users contract + C6/SEC-01/SEC-02 re-expressed green | as T3.2 shape |
| **T3.4 auth** | SECURITY & QA | `src/modules/auth/**`, `tests/**/auth*`,`rate-limit*`, `routes/auth.js`, `controllers/auth.js`, `helpers/{generar-jwt,google-verify}.js`, `middlewares/rate-limit.js`, app/legacy line | §5.2; carry F1 constant-time login verbatim; envelope + `RATE_LIMITED` 429; reuse `UserModel` | C5/SEC-07/F1 re-expressed green; login+google shared budget | |
| **T3.5 products** | DATABASE (mechanical, mirrors categories) | `src/modules/products/**`, `tests/**/product*`, `models/product.js`, `routes/products.js`, `controllers/product.js`, app/legacy line | §5.3 against the categories template; DTO drops `_id`/`user`/`image` | product contract green; mass-assignment (VAL-02) blocked | |
| **T3.6 search** | DATABASE (small) | `src/modules/search/**`, `tests/**/search*`, `routes/search.js`, `controllers/search.js`, app/legacy line | §5.4; inject the three models; keep behaviour; `{data}` envelope | C8/search re-expressed green | |
| **T3.7 media** | SECURITY & QA | `src/modules/media/**`, `tests/**/{uploads,multipart-scope,image-replacement}*`, `routes/uploads.js`, `controllers/uploads.js`, `helpers/upload-file.js`, `middlewares/file-valid.js`, `assets/`, `uploads/`, app/legacy line | §5.5/ADR-030; remove POST#20; GET 302; MIME sniff; C10/C11; 400/413 JSON | C10/C11/SEC-04 re-expressed; MIME + redirect + 413 tests green | |
| **T3.8 legacy removal** | BACKEND | `src/legacy.ts` (delete), `tests/helpers/legacy.ts` (delete), `tests/helpers/factories.ts` (→ TS models), `models/index.js`, `models/role.js`, `helpers/**`, `middlewares/{index,validar-*}.js`, `eslint.config.mjs` (legacy block), `package.json` (`express-validator`), `vitest.config.mts` (legacy coverage globs) | delete all legacy dirs/seam; remove `express-validator`; drop the legacy ESLint block | `grep -r legacy src` empty; no `require(` of legacy; `express-validator` has 0 importers; full suite green; cold `pnpm install --frozen-lockfile` (ADR-025) | `refactor!: remove the legacy strangler seam` |
| **T3.9 review** | ARCHITECT (read-only) | — | adversarial review vs this design | per-task ACCEPT/RETURN | — |
| **T3.10 close** | Orchestrator | docs | ledger, CHANGELOG 3.0.0-pending, ARCHITECTURE §1.10, TECH_DEBT statuses | — | — |

**DATABASE AGENT (DeepSeek) scope** is strictly the mechanical mirror tasks (T3.5 products against the categories template; T3.6 search — small, behaviour-preserving), each with the reference module as the exact pattern and a contract table row set to hit. No cross-cutting or security-judgement work.

---

## 9. Risks and rollback

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Contract drift across parallel agents.** | The reference module (T3.2, review-gated) is the template; the §6 contract table is the single source of truth; §7.2 fixes the exact assertion changes; T3.9 re-runs the whole suite for un-mapped drift. |
| R2 | **`src/app.ts`/`src/legacy.ts` merge contention** (the one shared surface). | One-line edits, serialized through the integration branch (rebase-before-add) or applied by the Orchestrator at merge. Everything else disjoint. |
| R3 | **Registry seam load order** (`MissingSchemaError`/`OverwriteModelError`). | ADR-027, proven: legacy model file → registry re-export; TS model sole registrant + guard; cross-module resolution lazy/from owner. T3.9 runs all four legacy entry orders (as T1.5/T2.8 did). |
| R4 | **Security regression under re-expression.** | Every C1–C11/SEC assertion is re-expressed, never dropped (§7.2); status codes for authz/limit/SEC-04 unchanged; T3.9 re-attempts the M1 bypasses against the TS routes (any success = RETURN). |
| R5 | **M4 coupling** (toJSON/models). | §1.2 reconciliation: M3 authors `toJsonPlugin` with M4's exact signature and the models at M4's exact paths with the legacy stored shape; M4 adds timestamps/indexes/enum to the same files. No double authoring. |
| R6 | **Media behaviour change** (302, MIME, no local disk). | ADR-030 preserves C10/C11; MIME by magic bytes (no dep); explicit ledger + CHANGELOG rows; the demo-page local-image expectation is CQ-07/M8. |

**Rollback — revert units.** Each module is one feature commit + one legacy-removal commit; reverting both restores that route to legacy (its `src/legacy.ts` entry and legacy files return). The **core envelope switch (T3.1)** is the one global commit; reverting it restores `{ msg }` bodies but breaks migrated modules that emit `details`, so the practical rollback of a released 3.0.0-line integration is reverting the milestone merge on `next` (ADR-026 keeps `master`/2.x untouched). T3.8 (legacy removal) is the point of no return for the strangler; it lands only after every module is green.

---

## Appendix A: Debt closed / advanced by M3

**Closed:** ARC-01 (service layer), DUP-01 (pagination/find-active-or-404/soft-delete shared where proven), VAL-01 (existence in service, not validator), VAL-02 (DTOs, no mass-assignment), HTTP-01 (status codes + envelope), HTTP-02 (parser errors → 400), FUNC-01 (GET redirect), CQ-01 (English identifiers), CQ-02 (`/hello`, PATCH stub, `updateImage` already gone), CQ-05 (delete-user body), LOG-02 (thin controllers, service logging via injected logger where needed), SEC-08 MIME, F3 (non-string → 422), F4 (413 JSON). **Advanced:** none deferred that M3 owns. **Explicitly not M3:** timestamps/indexes/email/enum-migration/`toJSON`-application-to-M4-schemas (M4), Bearer/tokenVersion/async-bcrypt/SEC-11/SEC-12 (M5), `authorize(policy)`/SEC-13 (M6).

## Appendix B: Express 5 / Mongoose 9 notes relevant to M3
- `req.query`/`req.params` are getter-only → `validate` writes with `Object.defineProperty` (verified).
- Async controllers/middleware: Express 5 forwards rejected promises → no `asyncHandler` (verified).
- `findOneAndUpdate(..., { returnDocument:'after' })` (Mongoose 9, from M2) used in services.
- `mongoose.models.X ?? mongoose.model('X', schema)` guard is required under Vitest/tsx re-import (verified: without it, `OverwriteModelError`).

## Appendix C: Prototype evidence
Throw-away clone of `m3/design`, scratchpad, removed after. All green:
- `tsc -p tsconfig.json` and `tsc -p tsconfig.build.json`: clean (after fixing 3 issues the prototype surfaced — `@types/jsonwebtoken` needed; `req.params` read via cast; lazy `User` lookup).
- `eslint src`: clean; the categories module satisfies every §2.3 layer rule.
- `tests/integration/modules/categories.test.ts`: 3/3 (full 3.0.0 contract, envelope, id, 200/201/204/422/409/404-incl-soft-deleted/403/401).
- `tests/unit/modules/category.service.test.ts`: 3/3 (hand-written fake, no DB, no `vi.mock`).
- Registry seam: reproduced `OverwriteModelError` (naïve) → fixed (re-export + guard); reproduced `MissingSchemaError` (eager `User`) → fixed (lazy).
- Error-envelope switch across the existing 248-case suite: **exactly 23 failures, all old-`{msg}`/`_id` assertions** (7 INTERNAL, 6 BAD_REQUEST, 4 NOT_FOUND, 2 CONFLICT, 2 key-shape, 1 legacy-body-parity on the migrated category route, 1 search `_id`) — zero crashes/schema errors. This is the §7.2 mapping, measured.
- New deps: `@types/jsonwebtoken` 9.0.10 (dev, pinned). No new runtime dependency (MIME by magic bytes).
