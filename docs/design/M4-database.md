# M4 — Database Design

> Milestone **M4 (Database Improvements)** · Design only — no code in this document is executed by the M4 design task.
> Owner: CarlosH / SH1FT3R · Prepared by the DATABASE AGENT · 2026-09-23
> Governing ADRs: **ADR-002** (TypeScript strict), **ADR-004** (no repository layer), **ADR-005** (DI factories + one composition root), **ADR-006** (zod DTOs), **ADR-007** (roles are a code enum; `Role` collection removed), **ADR-008** (Cloudinary-only media), **ADR-013/016** (tests are a gate; strangler migration), **ADR-014** (Node 24), **ADR-015** (SemVer versioning), **ADR-024** (release mapping: the `uid` alias lives **until 4.0.0**), **ADR-025** (supply-chain age gate: no new dependency), **ADR-027** (registry seam: the TS model is the sole guarded registrant).
>
> **Reconciled with M3 as built (2026-09-25, ARCHITECT, D4R).** This document was written on 2026-09-23, before M3 existed. The D4 body (§0–§8, Appendices A–B) is kept as the accepted record; **§9–§14 below are the as-built reconciliation, the corrections, the 3.0.0 contract impact, the task breakdown, the risks and the open questions, and they override the D4 text they name** (as M3's §10 overrides its own body). Start from §9.
> Debt closed or advanced: **DB-01, DB-02, PERF-02, PERF-03** (M4) · **SEC-14** is an M2 prerequisite restated here · **SEC-04** image shape and **C1** duplicate-key → 409 are respected.

---

## 0. Scope, assumptions, non-goals

**Assumes M3 has landed.** By M4 the feature modules exist at `src/modules/<feature>/` with the ARCHITECTURE §2.2 anatomy, controllers are thin, services own persistence, zod schemas are the DTOs, and the app is Express 5 + TypeScript strict + Mongoose 9. Nothing in this design re-derives those decisions; it only changes the schemas, the indexes, serialization, migrations and seed that live *under* those modules.

**In scope (M4 deliverables):** timestamps on every schema; normalized + uniquely indexed email; role enum with the `Role` collection removed; `price ≥ 0`; partial unique indexes on `name` where `state: true`; indexes on `state`/`category`/`user`; a search strategy that keeps substring semantics at current volume with a documented revisit trigger; a shared `toJSON` plugin; a migration runner with up/down and a reversible-where-possible migration set; an idempotent first-admin seed; a `tokenVersion` field for M5; the operational checklist and test plan that prove all of it.

**Out of scope:** bearer-token transport, `tokenVersion` enforcement, refresh tokens and password policy (M5); the `authorize(policy)` middleware and the ownership matrix (M6); Docker and graceful shutdown (M9); the zod `image` DTO itself (M3 — M4 only adds the schema-level guard); `sanitizeFilter`/`strictQuery` (M2, restated as an assumption).

**Principles applied (ARCHITECTURE §2.1):** every index added here must be traced to a real query in the codebase (no speculative indexes); the migration runner is chosen by YAGNI, not by familiarity; the design adds **no new dependency** beyond the existing Mongoose.

---

## 1. Where the code lives after M3

| Concern | Path |
|---|---|
| Models | `src/modules/users/user.model.ts` · `src/modules/categories/category.model.ts` · `src/modules/products/product.model.ts` |
| Serialization plugin | `src/core/database/to-json.plugin.ts` |
| Roles enum | `src/core/security/roles.ts` |
| Connection | `src/database/connection.ts` (from M2) |
| Migration runner + migrations | `src/database/migrate.ts` · `src/database/migrations/M001-*.ts` … |
| Seed | `src/database/seed.ts` |
| CLI | `src/database/cli.ts` (`migrate up|down|status`, `seed`) |

`Role` is removed entirely (ADR-007): no `role.model.ts`, no `roles` module, no `esRoleValido` helper. Any remaining reference to the `roles` collection is a bug by the time M4 starts.

---

## 2. Schema design

### 2.0 Shared conventions

| Convention | Decision | Rationale |
|---|---|---|
| `timestamps` | `{ timestamps: true }` on **all three** schemas → `createdAt`, `updatedAt` (`Date`). | DB-02; enables "newest first" lists and the createdAt backfill. |
| `_id` | Keep the default `ObjectId`. Never expose it as `_id`. | M0 contract already maps `_id → uid` for users; §4 generalizes it to `id`. |
| `versionKey` | Leave Mongoose's `__v` in the database, remove it in `toJSON` (the plugin sets `versionKey: false`). | Dropping it from the DB (`versionKey: false`) is an unrelated change; the plugin is the single place that shapes the API. |
| Field-level `unique`/`index` | **None.** All indexes are declared with explicit `schema.index(...)` and explicit names. | Avoids automatically-named duplicate indexes and keeps the catalogue in §3 as the single source of truth. |
| Soft delete | `state: Boolean, required, default true` stays on all three schemas. | Soft delete is an M3 service rule; M4 only makes the name unique index *respect* it. |
| Secrets | `password` is `select: false` **and** hidden by the plugin; `tokenVersion` is hidden by the plugin. | Defense in depth; see §4. |

### 2.1 Users — `src/modules/users/user.model.ts`

| Field | Type | Required | Validation | Default | Index | Notes |
|---|---|---|---|---|---|---|
| `name` | `String` | yes | `trim: true`, `maxlength: 120` | — | — | Trims accidental whitespace; length cap guards junk. No search index: user search is admin-only and low volume (§3.2). |
| `email` | `String` | yes | `trim: true`, **`lowercase: true`**, `maxlength: 254`, `match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/` | — | **`email_1` unique** | Normalization (DB-02) makes the plain unique index case-insensitive; it serves login/Google lookup and sign-up uniqueness. Legacy `unique: true` field option removed. |
| `password` | `String` | yes | `select: false` | — | — | bcrypt hash. Google users will get a real secret in M5 (SEC-12); for now required. **Any service that authenticates must `.select('+password')`.** |
| `image` | `String` | no | `trim: true`, `validate`: bare filename **or** a `https://res.cloudinary.com/...` URL | — | — | Preserves the M1 SEC-04 policy; the DB now rejects traversal-looking values that a rogue client could store. |
| `role` | `String` | yes | `enum: ['ADMIN_ROLE','USER_ROLE','VENTAS_ROLE']` | `'USER_ROLE'` | — | ADR-007, preserves existing stored strings (incl. `VENTAS_ROLE`, referenced today but undefined — SEC-13). |
| `state` | `Boolean` | yes | — | `true` | `state_1` | Soft-delete flag; serves `{ state: true }` list/count. |
| `google` | `Boolean` | yes | — | `false` | — | — |
| `tokenVersion` | `Number` | yes | `min: 0` | `0` | — | M5 revocation counter (ADR-010). Hidden from JSON (§4). |
| `createdAt` / `updatedAt` | `Date` | auto | — | now | — | `timestamps: true`. |

```ts
// src/modules/users/user.model.ts
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ROLES, DEFAULT_ROLE } from '../../core/security/roles';
import { toJsonPlugin } from '../../core/database/to-json.plugin';

const IMAGE_PATTERN = /^([A-Za-z0-9._-]+|https:\/\/res\.cloudinary\.com\/.+)$/;

export const userSchema = new Schema(
  {
    name:         { type: String, required: true, trim: true, maxlength: 120 },
    email:        { type: String, required: true, trim: true, lowercase: true, maxlength: 254,
                    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    password:     { type: String, required: true, select: false },
    image:        { type: String, trim: true,
                    validate: { validator: (v?: string) => v == null || IMAGE_PATTERN.test(v),
                                message: 'image must be a bare filename or a Cloudinary URL' } },
    role:         { type: String, required: true, enum: ROLES, default: DEFAULT_ROLE },
    state:        { type: Boolean, required: true, default: true },
    google:       { type: Boolean, required: true, default: false },
    tokenVersion: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { name: 'email_1', unique: true });
userSchema.index({ state: 1 }, { name: 'state_1' });

toJsonPlugin(userSchema, { hidden: ['password', 'tokenVersion'], uidAlias: true });

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;
export const UserModel = model('User', userSchema);
```

### 2.2 Categories — `src/modules/categories/category.model.ts`

| Field | Type | Required | Validation | Default | Index | Notes |
|---|---|---|---|---|---|---|
| `name` | `String` | yes | `trim: true`, `uppercase: true`, `maxlength: 120` | — | **`name_active_unique`** (partial unique, collated) | Existing controller uppercases; schema makes it authoritative. The collation is for the *duplicate check*, not for search (§3.2). |
| `state` | `Boolean` | yes | — | `true` | `state_1` | — |
| `user` | `ObjectId` ref `User` | yes | — | — | `user_1` | Creator; M6 ownership. |
| `createdAt` / `updatedAt` | `Date` | auto | — | now | — | `timestamps: true`. |

```ts
// src/modules/categories/category.model.ts
import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJsonPlugin } from '../../core/database/to-json.plugin';

export const categorySchema = new Schema(
  {
    name:  { type: String, required: true, trim: true, uppercase: true, maxlength: 120 },
    state: { type: Boolean, required: true, default: true },
    user:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

categorySchema.index(
  { name: 1 },
  { name: 'name_active_unique', unique: true,
    collation: { locale: 'en', strength: 2 },
    partialFilterExpression: { state: true } },
);
categorySchema.index({ state: 1 }, { name: 'state_1' });
categorySchema.index({ user: 1 },  { name: 'user_1' });

toJsonPlugin(categorySchema);

export type Category = InferSchemaType<typeof categorySchema>;
export const CategoryModel = model('Category', categorySchema);
```

### 2.3 Products — `src/modules/products/product.model.ts`

| Field | Type | Required | Validation | Default | Index | Notes |
|---|---|---|---|---|---|---|
| `name` | `String` | yes | `trim: true`, `uppercase: true`, `maxlength: 120` | — | **`name_active_unique`** (partial unique, collated) | Duplicate check only; search is a substring scan (§3.2). |
| `state` | `Boolean` | yes | — | `true` | `state_1` | — |
| `user` | `ObjectId` ref `User` | yes | — | — | `user_1` | Creator. |
| `price` | `Number` | no | **`min: 0`** | `0` | — | DB-02 (`min` added). No upper bound (out of scope). |
| `category` | `ObjectId` ref `Category` | yes | — | — | `category_1` | Adds the missing index (PERF-03). M3 validates existence; M4 indexes the FK. |
| `description` | `String` | no | `trim: true`, `maxlength: 2000` | — | — | Searchable by substring (C8); no search index at current volume (§3.2). |
| `available` | `Boolean` | yes | — | `true` | — | — |
| `image` | `String` | no | bare filename or Cloudinary URL (same validator as User) | — | — | M3 stores a Cloudinary `secure_url`. |
| `createdAt` / `updatedAt` | `Date` | auto | — | now | — | `timestamps: true`. |

```ts
// src/modules/products/product.model.ts
import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJsonPlugin } from '../../core/database/to-json.plugin';

const IMAGE_PATTERN = /^([A-Za-z0-9._-]+|https:\/\/res\.cloudinary\.com\/.+)$/;

export const productSchema = new Schema(
  {
    name:        { type: String, required: true, trim: true, uppercase: true, maxlength: 120 },
    state:       { type: Boolean, required: true, default: true },
    user:        { type: Schema.Types.ObjectId, ref: 'User', required: true },
    price:       { type: Number, default: 0, min: 0 },
    category:    { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    description: { type: String, trim: true, maxlength: 2000 },
    available:   { type: Boolean, required: true, default: true },
    image:       { type: String, trim: true,
                   validate: { validator: (v?: string) => v == null || IMAGE_PATTERN.test(v),
                               message: 'image must be a bare filename or a Cloudinary URL' } },
  },
  { timestamps: true },
);

productSchema.index(
  { name: 1 },
  { name: 'name_active_unique', unique: true,
    collation: { locale: 'en', strength: 2 },
    partialFilterExpression: { state: true } },
);
productSchema.index({ state: 1 },    { name: 'state_1' });
productSchema.index({ category: 1 }, { name: 'category_1' });
productSchema.index({ user: 1 },     { name: 'user_1' });

toJsonPlugin(productSchema);

export type Product = InferSchemaType<typeof productSchema>;
export const ProductModel = model('Product', productSchema);
```

### 2.4 Role — removed (ADR-007)

The `Role` schema, the `roles` collection and the `role` existence validator are deleted. Roles become:

```ts
// src/core/security/roles.ts
export const ROLES = ['ADMIN_ROLE', 'USER_ROLE', 'VENTAS_ROLE'] as const;
export type Role = (typeof ROLES)[number];
export const DEFAULT_ROLE: Role = 'USER_ROLE';
export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);
```

Consequences: sign-up no longer needs a seeded collection (closes the onboarding half of **DB-01**); the role validator is `z.enum(ROLES)` in the DTO (M3) and `enum: ROLES` at the schema (M4), so a write can never store a role outside the list. The migration that drops the collection is M004 (§5.3), gated on a data check.

### 2.5 Relationships (updated ER diagram)

```mermaid
erDiagram
    USER ||--o{ CATEGORY : "creates (category.user)"
    USER ||--o{ PRODUCT  : "creates (product.user)"
    CATEGORY ||--o{ PRODUCT : "classifies (product.category)"

    USER {
        ObjectId _id
        string   name      "required, trim, <=120"
        string   email     "required, lowercase+trim, unique, <=254"
        string   password  "required, select:false, secret"
        string   image     "optional, bare filename or Cloudinary URL"
        string   role      "required, enum ADMIN_ROLE|USER_ROLE|VENTAS_ROLE, default USER_ROLE"
        boolean  state     "required, default true, soft delete"
        boolean  google    "required, default false"
        number   tokenVersion "required, min 0, default 0, hidden (M5)"
        date     createdAt
        date     updatedAt
    }
    CATEGORY {
        ObjectId _id
        string   name   "required, trim+uppercase, partial-unique(ci) where state:true"
        boolean  state  "required, default true"
        ObjectId user   "required, ref User, indexed"
        date     createdAt
        date     updatedAt
    }
    PRODUCT {
        ObjectId _id
        string   name        "required, trim+uppercase, partial-unique(ci) where state:true"
        boolean  state       "required, default true"
        ObjectId user        "required, ref User, indexed"
        number   price       "default 0, min 0"
        ObjectId category    "required, ref Category, indexed"
        string   description "optional, <=2000, substring-searchable"
        boolean  available   "required, default true"
        string   image       "optional, bare filename or Cloudinary URL"
        date     createdAt
        date     updatedAt
    }
```

---

## 3. Indexes

### 3.1 Index catalogue (exact definitions + the query each serves)

Collections and index names are exact; every index maps to a query that exists after M3.

**`users`**

| Index | Definition | Query served |
|---|---|---|
| `email_1` | `{ email: 1 }`, `unique: true` | Login/Google lookup `UserModel.findOne({ email })` and sign-up uniqueness. The field's `lowercase: true` is what makes it effectively case-insensitive; the index itself needs no collation. |
| `state_1` | `{ state: 1 }` | `GET /api/user` list/count `{ state: true }` (PERF-03). |

> There is deliberately **no index for user search**: it is admin-only and low volume, and search is a substring scan by decision (§3.2).

**`categories`**

| Index | Definition | Query served |
|---|---|---|
| `name_active_unique` | `{ name: 1 }`, `unique: true`, `collation: { locale: 'en', strength: 2 }`, `partialFilterExpression: { state: true }` | The create/rename duplicate check `findOne({ name }).collation(en@2)`, so a soft-deleted name is reusable (DB-02) and case variants (`Phone`/`PHONE`) collide. Not a search index (§3.2). |
| `state_1` | `{ state: 1 }` | `GET /api/category` list/count `{ state: true }` (PERF-03). |
| `user_1` | `{ user: 1 }` | "Categories created by this user" (M6 ownership) and joins on `user`. |

**`products`**

| Index | Definition | Query served |
|---|---|---|
| `name_active_unique` | `{ name: 1 }`, `unique: true`, `collation: { locale: 'en', strength: 2 }`, `partialFilterExpression: { state: true }` | Duplicate check, so a soft-deleted product name is reusable and case variants collide. Not a search index (§3.2). |
| `state_1` | `{ state: 1 }` | `GET /api/product` list/count `{ state: true }` (PERF-03). |
| `category_1` | `{ category: 1 }` | Filter/populate by category, and "products in a category". |
| `user_1` | `{ user: 1 }` | "Products created by this user" (M6). |

Notes:
- ObjectId lookups use the built-in `_id_` index — no extra index.
- Production must run with `autoIndex: false` (M2/M9): indexes are created by these migrations, not at boot, so a deploy never triggers an unbudgeted index build. Dev/test may keep `autoIndex: true` so a fresh in-memory DB gets the schema.
- `collation` and `partialFilterExpression` compose (both supported since MongoDB 3.2/3.4; the baseline is mongod 8.x). `unique` + `partialFilterExpression` + `collation` is a supported combination.
- Only the two partial unique `name` indexes carry a collation (`en@strength 2`), and it is there for the **duplicate check**, not for search. The duplicate-check query must pass the same collation (`.collation({ locale: 'en', strength: 2 })`); otherwise it uses the default collation and case variants slip through.

### 3.2 Search strategy decision (PERF-02, C8)

The endpoint after M3 is unchanged in contract: `GET /api/search/:collection/:term`. Its three query shapes are taken directly from the legacy `controllers/search.js` (`SearchUser` / `SearchCategory` / `SearchProduct`), which M3 moves into `src/modules/search/search.service.ts`:
- `category` → `name`; `product` → `name` **or** `description`; `user` → `name` **or** `email` (admin only);
- a term that is a valid `ObjectId` is an id lookup (`findById`, active only);
- terms match **literally** (regex metacharacters escaped), case-insensitively, at most **20** results;
- `role` is not an allowed collection.

**Decision (as amended in D4 review): keep case-insensitive SUBSTRING (`contains`) matching with escaped terms and the 20-result cap. Add no search-specific index.**

Rationale — YAGNI, no volume evidence:
- The existing contract is a substring match. Switching to prefix matching to make the query indexable is a behaviour change the data does not justify: there is no measure showing search is a bottleneck. It was **rejected** in the D4 review.
- The collections are small and the only non-admin search surface on real traffic is category/product. A collection scan over a few thousand documents is well within the current SLO; a search index would optimise a query nobody has measured.
- A `$text` index is not a drop-in either: word/stem semantics (so `"lap"` would not match `"LAPTOP"`), no support for the ObjectId branch, per-collection limits, and it cannot express the C8 "literal, escaped term" rule.
- Safety is already covered by M1 (C8): `escapeRegex` makes any term literal, the result is capped at **20**, and `state: true` is preserved. Only the index is deferred — not the correctness work.

Query (products; categories/users analogous):

```ts
// src/modules/search/search.service.ts
const escapeRegex = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LIMIT = 20;

// non-ObjectId term: case-insensitive substring, literal (escaped), capped
const contains = new RegExp(escapeRegex(term), 'i');
return ProductModel.find({ state: true, $or: [{ name: contains }, { description: contains }] })
  .limit(LIMIT);
  // no `.lean()`: hydrating lets the shared `toJSON` plugin shape the response
  // (id, no _id/__v). If a `.lean()` projection is ever preferred, it MUST be
  // paired with an explicit DTO mapper, because `.lean()` bypasses the plugin.
```

- No `.collation()` and no `^` anchor: the term is escaped first, so the regex `i` flag is the simple case-insensitive form, and the term is never interpreted as a regex operator.
- **`sanitizeFilter` (M2, SEC-14) must not reject the service-built `$or`.** The service builds the filter from a zod-validated `string` term and a fixed structure; the term is escaped, never a raw `req.query` object. The test plan asserts the `$or` substring query still returns the expected rows with `sanitizeFilter` on.

**Revisit trigger (documented, not automatic).** Open a performance task when *either* holds for the searched collection:
- documents > **50,000**, or
- p95 latency of `GET /api/search/*` > **200 ms** (measured, not estimated).

At that point evaluate a MongoDB **text index** on `{ name, description }` (and `{ name, email }` for users), together with an explicit contract decision to move from substring to word/prefix semantics and the matching CHANGELOG entry. An anchored prefix + collation index is the alternative if the contract must stay literal. Until the trigger fires, substring search with the 20-cap stays, and no search-specific index is added.

### 3.3 Rollout notes

- Build indexes with the app draining writes where practical; MongoDB 4.2+ uses an optimized build that only briefly holds an exclusive lock. On a large collection, schedule a maintenance window anyway (M4 risk).
- The partial **unique** name index fails to build if duplicates exist among active rows. The pre-check (§7.2) and migration M002 abort with the offending ids rather than letting `createIndex` fail opaquely.
- Verify after deploy with `db.<coll>.getIndexes()` and `explain('executionStats')` (see §8). Every **list** query must show `IXSCAN` and a bounded `docsExamined`. Search is intentionally a scan at current volume (§3.2); it is not part of this check until the revisit trigger fires.

---

## 4. Serialization — shared `toJSON` plugin

### 4.1 Plugin — `src/core/database/to-json.plugin.ts`

```ts
import type { Schema } from 'mongoose';

export interface ToJsonOptions {
  /** Field paths that must never reach a client (secrets / internals). */
  readonly hidden?: readonly string[];
  /** Add the legacy `uid` alias for `_id` (ADR-015; removed in 4.0.0, ADR-024). */
  readonly uidAlias?: boolean;
}

export function toJsonPlugin(schema: Schema, { hidden = [], uidAlias = false }: ToJsonOptions = {}): void {
  const drop = new Set<string>(['_id', '__v', ...hidden]);

  schema.set('toJSON', {
    versionKey: false,
    transform(_doc, ret: Record<string, unknown>) {
      const id = String(ret._id);
      ret.id = id;                       // canonical id
      if (uidAlias) ret.uid = id;        // deprecated alias, same value
      drop.forEach((path) => delete ret[path]);
      return ret;
    },
  });
}
```

Wiring: `UserModel` gets `{ hidden: ['password', 'tokenVersion'], uidAlias: true }`; Category and Product get the default (`hidden: []`, no `uid`). Every future model must call the plugin — add a lint/unit test that asserts each exported schema has a `toJSON` transform (§8).

### 4.2 What the API sees

| Before | After |
|---|---|
| User JSON: `{ uid, name, email, image, role, state, google }` (`_id`/`__v`/`password` removed ad hoc) | `{ id, uid, name, email, image, role, state, google, createdAt, updatedAt }` |
| Category JSON: `{ _id, name, state, user }` (only `__v` disabled) | `{ id, name, state, user, createdAt, updatedAt }` |
| Product JSON: `{ _id, name, user, price, category, description, available, image }` (`state`/`__v` hidden) | `{ id, name, state, user, price, category, description, available, image, createdAt, updatedAt }` |
| Secrets | `password` never serialized (also `select: false`); `tokenVersion` hidden |

### 4.3 Legacy `uid` policy (ADR-015)

- `uid` is kept as an **alias of `id`** on users until **4.0.0** (ADR-024), then removed. Until then every user payload carries both keys with the same value, so existing clients keep working.
- The alias is declared in the plugin (`uidAlias`), not in a model, so removing it in 4.0.0 is a one-line change and a search for `uidAlias`.
- New code must use `id`. The CHANGELOG marks `uid` deprecated at the release that introduces `id` (3.0.0, ADR-024) and removed at 4.0.0.

### 4.4 Breaking API-shape changes to record (ADR-015)

1. `_id` is gone from every payload; `id` is the canonical key (`uid` still present **on users only**).
2. Product now exposes `state` (previously hidden).
3. Every payload gains `createdAt`/`updatedAt`.
4. Email is returned lowercased/trimmed.

All four go in the CHANGELOG **Breaking** section and the API_PROGRESS ledger for the release that ships M3+M4; none of them is silently introduced. (Search semantics do **not** change — §3.2 keeps substring matching.)

---

## 5. Migrations

### 5.1 Runner choice — `migrate-mongo` vs a ~50-line in-repo runner

| Criterion | `migrate-mongo` | In-repo runner (**chosen**) |
|---|---|---|
| Footprint | New runtime dependency + its config file + CLI | 0 dependencies; ~50 lines using the existing Mongoose client |
| Config | Its own `migrate-mongo-config.js`, separate from `src/config` (M2) | Reads the typed config object and the existing connection; no second source of truth |
| TypeScript | Works with a loader/compiled migrations; extra wiring | Native TS, shares types, compile-checked in `tsc` |
| Dry run / verification | Not built in | First-class: `--dry-run` prints the plan; migrations can abort on a data check (M001/M002/M004 need this) |
| Observability | Its log output | Uses the M2 pino logger with the same redaction/levels |
| M4's actual need | 4 one-shot, environment-specific migrations, each with a mandatory pre-check | Exactly what a small runner is for |
| Locking / concurrency | Not guaranteed in all versions | Documented limitation: M4 assumes a single app instance during migration; a lock is an M9 item |

**Recommendation: the in-repo runner.** It honors "no new dependency unless it removes real duplication" (ARCHITECTURE §2.1): a dependency would buy tracking + CLI, which ~50 lines already give, while costing a config file and a second connection path. Revisit `migrate-mongo` only if migrations become many and cross-environment orchestration is needed (post-M9).

### 5.2 Runner — `src/database/migrate.ts` (~50 lines)

```ts
import type { Db } from 'mongodb';
import type { Logger } from 'pino';

export interface Migration {
  readonly id: string;                                   // e.g. 'M001-normalize-email'
  up(db: Db, log: Logger): Promise<void>;
  down(db: Db, log: Logger): Promise<void>;
}

interface RunOptions { direction: 'up' | 'down'; dryRun?: boolean; log: Logger; }

export async function runMigrations(db: Db, migrations: Migration[], { direction, dryRun = false, log }: RunOptions) {
  const ledger = db.collection<{ id: string; appliedAt: Date }>('migrations');
  await ledger.createIndex({ id: 1 }, { unique: true });

  const applied = new Set((await ledger.find({}, { projection: { id: 1 } }).toArray()).map((d) => d.id));
  const plan = direction === 'up'
    ? migrations.filter((m) => !applied.has(m.id))
    : [...migrations].reverse().filter((m) => applied.has(m.id));

  for (const migration of plan) {
    log.info({ migration: migration.id, direction, dryRun }, 'migration');
    if (dryRun) continue;
    await migration[direction](db, log);                 // throws → abort, nothing recorded
    if (direction === 'up') await ledger.insertOne({ id: migration.id, appliedAt: new Date() });
    else await ledger.deleteOne({ id: migration.id });
  }
  return plan.map((m) => m.id);
}
```

- CLI (`src/database/cli.ts`): `migrate up`, `migrate down`, `migrate status`, `--dry-run`, `seed`.
- Ordering is by the `M0NN-` prefix in the filename; the runner refuses to run if ids are not sorted/unique.
- A migration that throws is **not** recorded → it will retry on the next run; each migration is written to be idempotent on retry (the `$exists`/`dropIndex` guards below).
- Single-instance assumption; a distributed lock is deferred to M9 (ARCHITECTURE §M9 graceful shutdown / operability).

### 5.3 Migration list (pseudo-code, up + down)

Each `up` starts with a **verification step that aborts** (throws) before any write, and each `down` documents whether it is reversible.

#### `M001-normalize-email`

```ts
async up(db, log) {
  const users = db.collection('users');

  // 1. ABORT on case-insensitive duplicates (no partial writes).
  const duplicates = await users.aggregate([
    { $group: {
        _id: { $toLower: { $trim: { input: { $ifNull: ['$email', ''] } } } },
        ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  if (duplicates.length > 0) {
    throw new Error(`M001 aborted: ${duplicates.length} duplicate email group(s). Resolve these first: ` +
      JSON.stringify(duplicates.map((d) => ({ email: d._id, ids: d.ids }))));
  }

  // 2. Lowercase + trim every email (pipeline update, one round trip).
  await users.updateMany({}, [
    { $set: { email: { $toLower: { $trim: { input: { $ifNull: ['$email', ''] } } } } } },
  ]);

  // 3. Rebuild the unique index on the normalized (lowercased) field.
  const indexes = await users.indexes();
  if (indexes.some((i) => i.name === 'email_1')) await users.dropIndex('email_1');
  await users.createIndex({ email: 1 }, { name: 'email_1', unique: true });
  log.info('M001: emails normalized, email_1 rebuilt (unique on lowercased email)');
}

async down(db, log) {
  const users = db.collection('users');
  const indexes = await users.indexes();
  if (indexes.some((i) => i.name === 'email_1')) await users.dropIndex('email_1');
  await users.createIndex({ email: 1 }, { name: 'email_1', unique: true }); // non-collated unique index
  log.warn('M001 down: casing is NOT restored (lossy). Restore from backup to recover original emails.');
}
```

#### `M002-rebuild-name-indexes`

```ts
async up(db, log) {
  for (const coll of ['categories', 'products'] as const) {
    const c = db.collection(coll);

    // 1. ABORT on duplicate ACTIVE names (case-insensitive).
    const duplicates = await c.aggregate([
      { $match: { state: true } },
      { $group: { _id: { $toUpper: { $trim: { input: '$name' } } }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();
    if (duplicates.length > 0) {
      throw new Error(`M002 aborted for ${coll}: duplicate active names ${JSON.stringify(duplicates)}`);
    }

    // 2. Drop the legacy all-states unique index.
    const indexes = await c.indexes();
    if (indexes.some((i) => i.name === 'name_1' && i.unique)) await c.dropIndex('name_1');

    // 3. Partial unique name (reusable after soft delete) + supporting indexes.
    await c.createIndex({ name: 1 }, {
      name: 'name_active_unique', unique: true,
      collation: { locale: 'en', strength: 2 },
      partialFilterExpression: { state: true },
    });
    await c.createIndex({ state: 1 }, { name: 'state_1' });
    await c.createIndex({ user: 1 },  { name: 'user_1' });
    if (coll === 'products') {
      await c.createIndex({ category: 1 }, { name: 'category_1' });
    }
    log.info({ coll }, 'M002: partial unique name + supporting indexes built');
  }
}

async down(db) {
  for (const coll of ['categories', 'products'] as const) {
    const c = db.collection(coll);
    for (const name of ['name_active_unique', 'state_1', 'user_1', 'category_1']) {
      try { await c.dropIndex(name); } catch (err: any) { if (err.codeName !== 'IndexNotFound') throw err; }
    }
    await c.createIndex({ name: 1 }, { name: 'name_1', unique: true }); // fails if case/state duplicates exist
  }
}
```

#### `M003-backfill-created-at`

```ts
async up(db, log) {
  for (const coll of ['users', 'categories', 'products'] as const) {
    const result = await db.collection(coll).updateMany(
      { $or: [{ createdAt: { $exists: false } }, { updatedAt: { $exists: false } }] },
      [{ $set: {
          createdAt: { $ifNull: ['$createdAt', { $toDate: '$_id' }] },
          updatedAt: { $ifNull: ['$updatedAt', { $toDate: '$_id' }] },
      } }],
    );
    log.info({ coll, matched: result.matchedCount }, 'M003: timestamps backfilled from ObjectId');
  }
}

async down(db) {
  // Reversible only because no document carried timestamps before M4.
  for (const coll of ['users', 'categories', 'products'] as const) {
    await db.collection(coll).updateMany({}, { $unset: { createdAt: '', updatedAt: '' } });
  }
}
```

> `$toDate` on an `ObjectId` yields the timestamp embedded in the `_id` — the closest possible "creation time" for pre-M4 data (all pre-M4 docs were created at that instant by the driver).

#### `M004-drop-roles-collection`

```ts
async up(db, log) {
  // 1. Verify: every stored role is a member of the code enum, or abort.
  const unknown = await db.collection('users').distinct('role', { role: { $nin: ['ADMIN_ROLE', 'USER_ROLE', 'VENTAS_ROLE'] } });
  if (unknown.length > 0) {
    throw new Error(`M004 aborted: unknown role value(s) ${JSON.stringify(unknown)}. Map them before dropping roles.`);
  }

  // 2. Verify the code no longer reads the collection (manual/CI gate, §7.3), then drop.
  try {
    await db.collection('roles').drop();
    log.info('M004: roles collection dropped (roles are a code enum, ADR-007)');
  } catch (err: any) {
    if (err.codeName !== 'NamespaceNotFound') throw err;
    log.info('M004: roles collection already absent');
  }
}

async down(db) {
  await db.collection('roles').insertMany(
    [{ role: 'ADMIN_ROLE' }, { role: 'USER_ROLE' }, { role: 'VENTAS_ROLE' }],
    { ordered: false },
  ).catch((err) => { if (err.code !== 11000) throw err; }); // idempotent
}
```

> M004 is the only destructive migration and runs last, after M001–M003 are green and after the verification in §7.3. `down` restores the three constant documents (they carry no data beyond their names).

---

## 6. Seed — first-admin bootstrap

`src/database/seed.ts`, run **only** by the explicit `pnpm seed` command (never on boot — confirmed in D4 review). New env: `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` (optional; added to `.example.env` and the M2 zod config).

```ts
export async function seedFirstAdmin({ UserModel, passwordHasher, config, logger }: SeedDeps) {
  const email = config.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = config.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    logger.info('seed: SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD not set — skipped');
    return { created: false, reason: 'not-configured' as const };
  }
  if (password.length < 8) {
    logger.error('seed: SEED_ADMIN_PASSWORD is shorter than 8 characters — refusing to create an admin');
    return { created: false, reason: 'weak-password' as const };
  }

  // Idempotent + never overwrite:
  const existingAdmin = await UserModel.findOne({ role: 'ADMIN_ROLE', state: true }).lean();
  if (existingAdmin) {
    logger.info({ id: String(existingAdmin._id) }, 'seed: an active admin already exists — skipped');
    return { created: false, reason: 'admin-exists' as const };
  }
  const emailTaken = await UserModel.findOne({ email }).lean();
  if (emailTaken) {
    logger.info('seed: the configured email already exists — skipped, untouched');
    return { created: false, reason: 'email-exists' as const };
  }

  try {
    const passwordHash = await passwordHasher.hash(password);
    const doc = await UserModel.create({
      name: 'Administrator', email, password: passwordHash, role: 'ADMIN_ROLE', state: true, google: false, tokenVersion: 0,
    });
    logger.info({ id: doc.id }, 'seed: first admin created');
    return { created: true, id: doc.id };
  } catch (err) {
    if (isDuplicateKeyError(err)) {                      // concurrent run or case-variant email
      logger.info('seed: user already exists — skipped');
      return { created: false, reason: 'email-exists' as const };
    }
    throw err;
  }
}
```

Guarantees: **create-only** (no `upsert`, no `$set`), so an existing user's password/role/state is never modified; safe to run repeatedly (it is never wired into boot); refuses a weak password; refuses when any active admin exists (true *first*-admin bootstrap). A recovery admin for a locked-out instance is a manual break-glass procedure (documented, not automated).

---

## 7. Production safety checklist

### 7.1 Before touching data

1. **Owner approves the window.** M4 is a one-way step for email casing (see rollback); schedule a maintenance window and freeze writes.
2. **Backup** (verify it restores):
   ```bash
   mongodump --uri="$MONGO_CLOUD" --archive="m4-backup-$(date +%F-%H%M).archive" --gzip
   mongorestore --uri="$SCRATCH_URI" --archive="m4-backup-*.archive" --gzip --nsFrom='*' --nsTo='scratch_*'
   ```
   On Atlas, also take a snapshot.
3. **Dry run:** `pnpm migrate up --dry-run` — prints the ordered list and touches nothing.
4. **CI gate:** grep the branch for the removed references (`Role`, `roles`, `esRoleValido`) — must be zero before M004.

### 7.2 Pre-migration data checks (`mongosh "$MONGO_CLOUD"`)

```js
// 1. Duplicate emails ignoring case/whitespace  -> M001 will abort if non-empty
db.users.aggregate([
  { $group: { _id: { $toLower: { $trim: { input: { $ifNull: ['$email', ''] } } } },
              ids: { $push: '$_id' }, count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } },
]).forEach(printjson);

// 2. Duplicate ACTIVE names (case-insensitive)  -> M002 will abort if non-empty
['categories', 'products'].forEach((c) => {
  print('--- ' + c);
  db.getCollection(c).aggregate([
    { $match: { state: true } },
    { $group: { _id: { $toUpper: { $trim: { input: '$name' } } }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).forEach(printjson);
});

// 3. Unknown role values  -> M004 will abort if non-empty
db.users.find({ role: { $nin: ['ADMIN_ROLE', 'USER_ROLE', 'VENTAS_ROLE'] } },
              { name: 1, email: 1, role: 1 }).forEach(printjson);

// 4. image is neither a bare filename nor a Cloudinary URL  -> manual cleanup list
db.users.find(
  { image: { $exists: true, $nin: [null, ''] },
    $nor: [{ image: /^[A-Za-z0-9._-]+$/ }, { image: /^https:\/\/res\.cloudinary\.com\// }] },
  { name: 1, email: 1, image: 1 }).forEach(printjson);
db.products.find(
  { image: { $exists: true, $nin: [null, ''] },
    $nor: [{ image: /^[A-Za-z0-9._-]+$/ }, { image: /^https:\/\/res\.cloudinary\.com\// }] },
  { name: 1, image: 1 }).forEach(printjson);

// 5. Referential integrity (Mongo will not enforce it; the new FK indexes assume valid refs)
db.products.aggregate([
  { $lookup: { from: 'categories', localField: 'category', foreignField: '_id', as: 'c' } },
  { $match: { 'c.0': { $exists: false } } },
  { $project: { name: 1, category: 1 } },
]).forEach(printjson);
['categories', 'products'].forEach((c) => db.getCollection(c).aggregate([
  { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'u' } },
  { $match: { 'u.0': { $exists: false } } },
  { $project: { name: 1, user: 1 } },
]).forEach(printjson));
```

Expected results: checks 1–3 must be empty before the run (otherwise fix the data and re-run); check 4 is a review list (null/blank the bad values or move them to Cloudinary); check 5 decides whether orphan rows are deleted or re-parented.

### 7.3 Run, then verify

```bash
pnpm migrate up          # M001 -> M002 -> M003 -> M004, in order
```

Verify (all must pass before declaring success):
- `db.users.getIndexes()` shows `email_1` unique (plain, non-collated); `db.categories.getIndexes()` / `db.products.getIndexes()` show `name_active_unique` partial collated plus the supporting indexes.
- `db.users.countDocuments()`, `db.categories.countDocuments()`, `db.products.countDocuments()` are unchanged from the pre-run counts.
- `db.users.aggregate([{ $match: { $expr: { $ne: ['$email', { $toLower: { $ifNull: ['$email', ''] } }] } } }, { $count: 'notNormalized' }])` returns no rows (every email already lowercase/trimmed).
- `db.products.countDocuments({ price: { $lt: 0 } })` is `0` (schema guard; migrate any legacy negatives beforehand).
- `db.roles` no longer exists (`db.getCollectionNames()` excludes it).
- `pnpm seed` creates the first admin (or reports one exists), and login with it succeeds.
- Spot-check the app: list, search, sign-up, login, media.
- `explain('executionStats')` on the **list** queries shows `IXSCAN` (search scans by decision, §3.2).

### 7.4 Rollback

| Situation | Action |
|---|---|
| Before M004, a check fails or the app misbehaves | `pnpm migrate down` reverses M003 → M002 → M001 (M001's casing is not restored — see below), or restore the backup for an exact revert. |
| After M004 (roles dropped) | `pnpm migrate down` recreates the three constant `roles` documents; no other data is affected. |
| Email casing must be recovered exactly | **Only** the archive/snapshot restores it; the down migration cannot (documented in M001.down). |
| Index built but app not deployed | `pnpm migrate down` drops the new indexes and restores the legacy `name_1` unique index (fails if duplicates now exist). |

Emergency rule: if anything is unclear, stop the app, `mongorestore --drop` the archive, redeploy the previous image, and investigate offline.

---

## 8. Test plan (integration, in-memory Mongo harness)

Harness: the M2 **Vitest + supertest + `mongodb-memory-server`** integration suite (`tests/integration`, helpers in `tests/helpers/db.ts` — one memory server per worker, unique database per file, `clearDatabase()` per test). The ported M1 security suite (formerly Jest `e2e/`) remains the regression gate. All tests below run against `createApp()` and real MongoDB instances (no mocks of the DB).

| # | File | Proves |
|---|---|---|
| 1 | `tests/integration/models/user.model.spec.ts` | `email` is lowercased+trimmed on create **and** update; invalid email rejected; `role` accepts all three enum values and rejects anything else; `price`-style bounds are out of this file; `password` has `select: false` (a plain `findOne` omits it, `+password` returns it); `tokenVersion` defaults to `0` and rejects negatives; `createdAt`/`updatedAt` exist; duplicate email (any case) → `MongoServerError` 11000. |
| 2 | `tests/integration/models/category.model.spec.ts` | `name` is trimmed+uppercased; two **active** categories with the same name (incl. different case) → 11000; soft-delete one (`state: false`) then creating the same name **succeeds** (DB-02, partial unique); `user` is required. |
| 3 | `tests/integration/models/product.model.spec.ts` | `price: -1` → `ValidationError`, `price: 0` allowed; `category`/`user` required; `name` partial-unique behavior as categories; `image` validator accepts a bare filename and a Cloudinary URL and rejects `../../package.json`. |
| 4 | `tests/integration/models/serialization.spec.ts` | `toJSON` for all three models exposes `id`, removes `_id`/`__v`; User never exposes `password`/`tokenVersion` and exposes `uid === id`; Category/Product expose `state`; a schema-coverage test asserts every exported model has a `toJSON` transform. |
| 5 | `tests/integration/database/indexes.spec.ts` | `getIndexes()` returns exactly the catalogue names/options from §3.1 (no `name_1` legacy unique, no field-level auto index, no `description_prefix_ci`, no `name_prefix_ci`). `explain('executionStats')` shows `IXSCAN` (not `COLLSCAN`) for: user by email; `{ state: true }` list/count; product by `category`; category/product by `user`. |
| 6 | `tests/integration/search/search.spec.ts` | C8 contract re-proved on the unchanged substring query: category/product public, user admin-only (401/403), `role` → 400; **substring (contains)** case-insensitive matching (`"top"` matches `"LAPTOP"`); regex metacharacters (`.*`, `(`, `[`) are literal; ≤20 results with 25 matches; non-existent id → `{ results: [] }`; soft-deleted docs excluded; **`$or` substring query still works with `sanitizeFilter` on** (SEC-14). |
| 7 | `tests/integration/database/migrations.spec.ts` | Runner applies M001–M004 in order once and records them; a second run is a **no-op**; `--dry-run` plans but writes nothing. M001 **aborts** on seeded case-duplicate emails and leaves data untouched; M002 aborts on duplicate active names; M003 backfills `createdAt` from the `ObjectId` timestamp (insert raw docs without timestamps, then assert equality to `_id.getTimestamp()`); M004 aborts on an unknown role value and drops `roles` when clean; `down` reverses M003, M002 (index set back to legacy) and M004 (roles recreated), and M001 reports the lossy-casing warning. |
| 8 | `tests/integration/database/seed.spec.ts` | With env set and an empty DB → creates exactly one active `ADMIN_ROLE`; run twice → still one, second call reports `admin-exists`; with an existing admin → no write; configured email belonging to a non-admin → no write and that user's password/role unchanged; weak/missing password → refuses, creates nothing; email is lowercased. |
| 9 | `tests/integration/users/*.spec.ts` (existing, updated) | Sign-up stores `USER_ROLE` and lowercased email; the M1 assertions still hold with the new JSON shape (`id`, `uid`, no `password`, `state` visible). |
| 10 | `tests/integration/media/*.spec.ts` (existing, updated) | The `image` validator + the M1 SEC-04 policy still hold; a Cloudinary URL round-trips; a traversal value is rejected at the schema for direct writes and yields the placeholder at the API. |

Determinism: the harness starts one memory server per worker and gives each file its own database (the pattern proven by the M1 T1.4 suite), so index builds and migrations never leak across files. Index tests must call `Model.init()` (or the explicit `createIndexes`) before asserting, and `explain` assertions must run after `syncIndexes()`.

### Traceability (debt → design → test)

| Debt | Design section | Test |
|---|---|---|
| DB-01 | §2.4 (no Role collection), §6 (seed) | 8, 9 |
| DB-02 | §2.1–§2.3 (timestamps, email, enum, min, partial name, serialization) | 1–4 |
| PERF-02 | §3.1 (list/fk indexes), §3.2 (substring kept, revisit trigger) | 5, 6 |
| PERF-03 | §3.1 (`state`, `category`, `user`) | 5 |
| SEC-14 | §3.2 note (sanitizeFilter + service-built `$or`) | 6 |
| ADR-007 | §2.4, M004 | 3, 7 |
| ADR-010 | §2.1 `tokenVersion` | 1 |
| ADR-015 | §4.3 `uid` alias | 4 |

---

## Appendix A — Config / env additions

| Name | Where | Required | Notes |
|---|---|---|---|
| `SEED_ADMIN_EMAIL` | `src/config` (zod), `.example.env` | no | Lowercased/trimmed by the seed. |
| `SEED_ADMIN_PASSWORD` | `src/config` (zod), `.example.env` | no | Refuse < 8 chars; never logged (pino redaction). |
| `NODE_ENV` | existing | yes | Drives `autoIndex: false` in production. |

Scripts to add (M4 implementation): `"migrate": "tsx src/database/cli.ts migrate"`, `"seed": "tsx src/database/cli.ts seed"`.

## Appendix B — Resolutions from the D4 review

1. **Search keeps case-insensitive substring matching** with escaped terms and the 20-result cap; **no search-specific index** is added, and the prefix/substring behaviour change is dropped (the only revisit path is the documented trigger in §3.2).
2. **`VENTAS_ROLE` stays** in the enum; M6 defines its permissions.
3. **Product `description` stays searchable by substring** (not `$text`).
4. **`tokenVersion` stays hidden** from JSON.
5. **The seed runs only via the explicit `pnpm seed` command**, never on boot.
6. **Migration lock** for multi-instance deploys is deferred to M9; M4 assumes a single app instance during migration.

---

# Part II — Reconciliation with M3 as built (D4R, ARCHITECT, 2026-09-25)

> Everything below is written against **`next` @ `98ea113`** (M3 merged, 746 tests, TypeScript only, the legacy seam gone). Where a statement here names a D4 section, it **overrides** it. Evidence was measured in a scratchpad clone (mongod **8.2.6** via `mongodb-memory-server@11.3.0`); the prototype results are cited inline as **[P#]**.

## 9. As-built delta after M3

M3 built the models, the plugin and the harness that D4 assumed it would only *describe*. The table below is every D4 statement M3 made stale, with the fix. Files are the real paths.

| # | D4 said | As built in M3 (evidence) | Fix for M4 |
|---|---|---|---|
| D-1 | Header: "`uid` alias until **3.0.0** (ADR-015)". | ADR-024 maps `uid` removal to **4.0.0**; `to-json.plugin.ts:9` and D4 §4.3 already say 4.0.0. | **Fixed inline** in the header. `uid` (users only) stays until 4.0.0. |
| D-2 | §4.1 presents the `toJSON` plugin as an M4 deliverable ("Plugin — `src/core/database/to-json.plugin.ts`"). | The plugin **already exists** (`src/core/database/to-json.plugin.ts`, authored in M3/D3), signature `toJsonPlugin(schema, { hidden?, uidAlias? })`, already `versionKey:false` + `virtuals:false`, already emits `id`, drops `_id`/`__v`/hidden, and adds `uid` when asked. | **M4 does not create or rewrite the plugin.** M4's only plugin-related change is adding `'tokenVersion'` to the **user** model's `hidden` list once that field exists: `toJsonPlugin(userSchema, { hidden: ['password', 'tokenVersion'], uidAlias: true })`. Do not touch the plugin body. |
| D-3 | §2.1–§2.3 model snippets register with `export const UserModel = model('User', userSchema)`. | M3 registers behind the **ADR-027 guard**: `export const UserModel: Model<User> = (mongoose.models.User as Model<User> \| undefined) ?? mongoose.model<User>('User', userSchema)` (`user.model.ts:29`, and the same for Category/Product). The guard stays after T3.8b (Vitest/tsx load a file twice). | **M4 changes only the schema body, the `schema.index(...)` calls and the plugin options. It keeps the guarded sole-registrant block verbatim.** The `Model<T>` return-type annotation stays. |
| D-4 | §2.0: "Field-level `unique`/`index`: **None**." | M3 ships field-level `unique: true` on `user.email` (`user.model.ts:10`), `category.name` and `product.name`. With `autoIndex` on (see D-10) these already build `email_1`/`name_1` plain unique indexes in dev/test. | Correct end state; M4 **removes the field-level `unique: true`** and declares the indexes explicitly (D4 §2.0/§3.1). The change of `name_1`→`name_active_unique` and the email rebuild are what migrations **M002**/**M001** do on existing data. |
| D-5 | §2.1 user schema has no `cast` message. | M3 sets `password: { …, cast: 'The password must be a string' }` for LOG-02/AM-M3-2 (`user.model.ts:13-17`); `tests/unit/modules/user.model.test.ts` and an AM-M3-2 test assert a rejected password never leaks into the error. | **M4 preserves the `cast` message** and the LOG-02 guarantee. `password` gains `select: false` on top of it (D-9). |
| D-6 | §2.x uses `required: true`. | M3 uses custom messages: `required: [true, 'The name is required']`, `'The email is required'`, `'The password is required'`. | **M4 keeps the custom `required` messages** (they are part of the validation surface the model tests assert). |
| D-7 | §2.0: "Leave Mongoose's `__v` in the database, remove it in `toJSON`." | Inconsistent in M3: `category`/`product` set `{ versionKey: false }` (no `__v` stored); `user` has no options object, so `__v` **is** stored (`user.model.ts:8`, `category.model.ts:12`, `product.model.ts:18`). `user.model.test.ts` asserts `__v` in the user paths. | **Decision (§10.6): standardize on `versionKey: false` for all three** (the schema options become `{ versionKey: false, timestamps: true }`). No consumer uses OCC; the plugin drops `__v` from JSON regardless, so the API is identical. This makes the three schemas uniform. See the Question if the Orchestrator prefers D4's keep-`__v`. |
| D-8 | §2.4 / §1: "delete the `Role` schema, the `roles` collection and the validator" as M4 work; "any remaining reference to the `roles` collection is a bug by the time M4 starts." | **Already done in M3** (T3.8b): `models/role.js` is gone, `ROLES` in `src/core/security/roles.ts` is the source of truth (ADR-007), and there is no `roles` code reference. | **M4's only Role work is the DATA migration M004** that drops the leftover **2.x `roles` collection** in *existing* databases. The code-deletion half of §2.4 is a no-op. |
| D-9 | §2.1: `password: { select: false }`, with the note "Any service that authenticates must `.select('+password')`." | M3's `auth.service.login` reads `user.password` from a plain `User.findOne({ email })` with **no projection** (`auth.service.ts`), and `SignInUserModel.findOne` returns a `SignInUser` **including** `password`. The seed (D4 §6) also reads nothing that needs password, but any auth path does. | **`select: false` is a cross-module change, not a model-only one.** M4 must, in the same wave: add `.select('+password')` (or `+password`) to the auth login lookup and to the `SignInUserModel` projection, and prove login still works. This is owned by the SECURITY task (T4.3), not the mechanical schema task. See the Question about deferring `select:false` to M5. |
| D-10 | §3.1: "Production must run with `autoIndex: false` (M2/M9)." | **False as built.** `src/database/connection.ts` never sets `autoIndex`; it is Mongoose's default (**true**) in every environment (`grep autoIndex src` → none). | **M4 corrects this** (§10.1): `connectDatabase(uri, { autoIndex })` with `autoIndex: config.env !== 'production'`. Dev/test build indexes from the schema; production builds them through the migrations, so a deploy never triggers an unbudgeted build. |
| D-11 | §8 harness: `tests/helpers/db.ts`, one memory server **per worker**, `tests/integration/models/*.spec.ts`, `*.spec.ts` naming, `createApp()`-only. | M3 harness: `tests/helpers/app.ts` (`startTestApp`/`stopTestApp`/`clearDatabase`) + `tests/helpers/factories.ts`; **one mongod per run** via `tests/setup/global-setup.ts` (`project.provide('mongoUri', …)`), a **unique DB per file** (`app.ts:15`); files are `*.test.ts`; forks pool, `isolate: true`, `restoreMocks: true`. Model tests live in `tests/unit/modules/*.model.test.ts`. | **M4 test files are `*.test.ts`** and use the M3 harness. Extend `tests/unit/modules/{user,category,product}.model.test.ts`; add `tests/integration/database/{indexes,migrations,seed}.test.ts` and `tests/integration/modules/*.model.test.ts` for the DB-backed model behaviour (they connect through the harness, not `createApp` alone). No new `db.ts`. |
| D-12 | §8 test #6 / §3.2: search returns `{ results: [] }`; the query "returns" raw `find`. | M3 search returns the **envelope**: the controller wraps the service result as `{ data: [...] }` (search), and **list** endpoints use `pageEnvelope` `{ data, meta: { total, limit, offset } }`. Collections are the singular allowlist `['user','category','product']` (`search.service.ts:20`), escaped, `.limit(20)`, `state:true`. | **M4 keeps the M3 shape.** Test #6 asserts `{ data: [] }` (not `{ results: [] }`). The §3.2 search-index decision (no index) is sound and unchanged; the query already lives in `search.service.ts` — M4 adds no index and no `.collation()` there. |
| D-13 | Appendix A: `"migrate": "tsx src/database/cli.ts migrate"`, `"seed": "tsx …"`. | `tsx` is a **devDependency** (`package.json:57`); production runs compiled TS: `start` is `node --enable-source-maps --env-file-if-exists=.env dist/server.js`. `tsconfig.build.json` compiles `src`→`dist` (`rootDir: src`), so `src/database/cli.ts` → `dist/database/cli.js`. | **Production migrate/seed run compiled** (§10.2): `"migrate": "node --enable-source-maps --env-file-if-exists=.env dist/database/cli.js"`, `"seed": "… dist/database/cli.js seed"`. Optional dev conveniences may use `tsx` (`"migrate:dev": "tsx …"`). **No new dependency** (ADR-025 → nothing to pin). |
| D-14 | §6 seed reads flat config: `config.SEED_ADMIN_EMAIL`, `config.SEED_ADMIN_PASSWORD`. | M3 config is **nested and frozen** (`src/config/index.ts`): `config.auth.jwtSecret`, `config.media.cloudinaryUrl`, `config.mongoUri`, `config.trustProxy`, `config.cors.origins`. `envSchema` (`src/config/env.ts`) has no seed vars. | **M4 adds a nested block** `config.seed: { adminEmail?: string; adminPassword?: string }` and the env vars `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (optional strings) to `envSchema` and `.example.env`. The seed reads `config.seed.adminEmail`. |
| D-15 | §5.2 runner imports `type { Logger } from 'pino'`. | `src/core/logger.ts` re-exports pino's `Logger` (`export type { Logger }`) and owns `REDACT_PATHS`. | Compatible; **prefer importing `Logger` from `src/core/logger`** for one source of truth. The CLI builds a logger with `createLogger(config)` and obtains the native `Db` from `mongoose.connection.db` after `connectDatabase`. |
| D-16 | §8 "The ported M1 security suite (formerly Jest `e2e/`) remains the regression gate … `createApp()` and real MongoDB." | The M1 suite is fully ported to Vitest under `tests/integration/security/*.test.ts` (T2.6/M3); there is no Jest/`e2e/`. | Cosmetic; M4 test-plan wording uses the current paths. The regression gate is the whole `pnpm test` (746 on `next`). |

## 10. Corrections (design errors found, with evidence)

Appendix B's six resolutions are **kept**; I found no defect in them. The corrections below are new, from measuring M3 as built.

### 10.1 `autoIndex` is not off in production (D-10) — corrected
`connection.ts` must gate index auto-building: production relies on the migrations, dev/test on the schema. Concretely:
```ts
export async function connectDatabase(uri: string, options: { autoIndex?: boolean } = {}): Promise<typeof mongoose> {
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: options.autoIndex ?? true });
}
```
`src/server.ts` passes `{ autoIndex: config.env !== 'production' }`; `tests/helpers/app.ts` keeps the default (`true`) so a fresh in-memory DB gets the schema indexes. **Consequence:** a brand-new production database has **no** collection indexes until `pnpm migrate up` runs — this is added to the deploy runbook (§7.3) and the rollout risk (§13).

### 10.2 Runtime for migrate/seed (D-13) — corrected
Production commands run `node dist/database/cli.js` (compiled), never `tsx`. The CLI is `dist/database/cli.js` after `pnpm build`. `--env-file-if-exists=.env` matches `start`. This is the "prefer what the repo already uses" instruction and keeps `tsx` a dev-only tool. **No package is added** (ADR-025).

### 10.3 Duplicate **message** consistency under normalization — corrected
The M3 services pre-check uniqueness with an **exact-match, case-sensitive** query and rely on the unique index as the race backstop:
- users: `if (await User.exists({ email: dto.email })) throw new ConflictError('Email already registered')` (`user.service.ts:40`);
- categories/products: `exists({ name, state: true })` → `ConflictError('X already exists')`.

Once M4 normalizes (`email` `lowercase`, `name` `uppercase`) and adds the **collated** partial-unique name index, a **case-variant** duplicate slips past the pre-check and is caught by the DB as `11000`, which `toAppError` maps to `ConflictError` with the **generic** message `'Resource already exists'` (`to-app-error.ts`: `code === 11000 → ConflictError(undefined)`), not the specific one. Both are 409, so C7/C1 hold — but the message differs.

**Fix (owned by T4.3):** make the pre-check case-insensitive so the specific message wins in the common case, with the index as the true race backstop:
- **email:** normalize in the DTO — `email: z.email().trim().toLowerCase()` (a zod transform) in **both** `createUserBody` (users) and `loginBody` (auth) — so the service's `exists({ email })` and the login `findOne({ email })` are consistent, and the stored value matches. Schema `lowercase: true` stays as defense in depth.
- **name:** the service passes the term through the same normalization the schema applies (`name.trim().toUpperCase()`) before `exists({ name, state: true })`, **and** the pre-check adds `.collation({ locale: 'en', strength: 2 })` so it matches the index (D4 §3.1 note). Measured: without the collation the pre-check misses case variants; the index still refuses them **[P2]**.

### 10.4 `select: false` breaks auth unless coordinated (D-9) — corrected
`password: { select: false }` means `User.findOne({ email })` no longer returns `password`, so `auth.service.login`'s `bcrypt.compareSync(password, user.password)` would compare against `undefined` and **every login would fail**. M4 must, in T4.3: change the auth lookup to `.select('+password')` (or add `+password` to the `SignInUserModel` projection type), keep the F1 constant-time guarantee (the dummy-hash path is unaffected), and add a test that a correct password still returns a token. The seed's create path is unaffected (it sets `password`); its `findOne({ email }).lean()` existence checks read no password. **See the Question** on whether to defer `select:false` to M5 (auth is reworked there anyway).

### 10.5 Email normalization changes the **login** contract — recorded, not a defect
Because stored emails become lowercase (M001) and both DTOs lowercase the input (§10.3), **login and sign-up become case-insensitive on email** (`Foo@X.com` logs in the `foo@x.com` account). M3's auth review explicitly noted "an uppercase email → 401 … M4 normalises". This is a deliberate 3.0.0 improvement; it is recorded in §11 (contract impact) and the CHANGELOG, and re-proved by a security test (T4.3).

### 10.6 `versionKey` standardized (D-7) — decision
All three schemas take `{ versionKey: false, timestamps: true }`. This removes the M3 inconsistency (user stored `__v`, the others did not) at no API cost. `tests/unit/modules/user.model.test.ts` currently asserts `__v` in the user paths and the absence of timestamps — T4.2 updates it to the new shape (mapped drift, §11).

### 10.7 Confirmed sound in D4 (no change needed), verified in the prototype
- Partial-unique + collation + unique **compose** and build on mongod 8.2.6; a soft-deleted name is reusable, an active case-variant collides **[P1, P2, P3]**.
- Case-variant email → `11000`, stored normalized **[P4]**.
- `$toDate` on `_id` backfills `createdAt` exactly to `_id.getTimestamp()` **[P5]** (M003).
- `sanitizeFilter` (global, on) does **not** reject the service-built `$or` substring query — it returns the expected rows **[P6]** (SEC-14 holds).
- A unique index build over **pre-existing active duplicates** is refused with `11000` **[P7]** — which is exactly why M001/M002 abort on a data pre-check before `createIndex` (§13).

## 11. 3.0.0 contract impact of M4

M4 rides the same 3.0.0 release as M3 (ADR-024/026); it does not cut its own version. Contract deltas **added by M4** (product `state` and `id`/no-`_id` were **M3**, not M4 — this corrects D4 §4.4 items 1–2):

| Change | Endpoints | Note |
|---|---|---|
| `createdAt` / `updatedAt` appear on every resource | all list/get/create/update responses | additive; `Date` (ISO string in JSON). |
| `email` returned **lowercased + trimmed** | user create/get/list, auth login user | DB-02; existing mixed-case emails are normalized by M001. |
| Login & sign-up become **case-insensitive on email** | `POST /api/auth/login`, `POST /api/auth/google`, `POST /api/user` | §10.5; a deliberate improvement. |
| Duplicate email is now **case-insensitive → 409** | `POST /api/user` | M3 could store `Foo@x`/`foo@x` twice; M4's unique index makes them collide (C7). |
| `price` rejects negatives (`min: 0`) → **422** on the DTO / `ValidationError` at the schema | `POST/PUT /api/product` | DB-02; the DTO already bounds it (M3), the schema is the backstop. |
| `name`/`email`/`description`/`image` gain length caps and the `image` schema validator | user/category/product writes | oversize or a non-{filename,Cloudinary-URL} `image` → 422/`ValidationError`. |
| `tokenVersion` added to the user document, **hidden** from JSON | — | M5 uses it; invisible in 3.0.0. |

**API_PROGRESS ledger rows (M3 format), append under "Planned contract changes":**
- `all` — responses now include `createdAt`/`updatedAt` (M4, DB-02).
- `user` — `email` is stored and returned lowercased/trimmed; duplicate email is case-insensitive → 409 (M4, DB-02).
- `auth` — login/Google match email case-insensitively (M4).
- `product` — `price` must be ≥ 0 (422) (M4, DB-02).

**CHANGELOG (3.0.0, `next`) rows — under Changed:** timestamps on every resource; email normalized and matched case-insensitively; product `price ≥ 0`. Under Added: `tokenVersion` (hidden, M5 prep); first-admin seed (`pnpm seed`); DB migration runner (`pnpm migrate`). Under Removed (data): the 2.x `roles` collection (M004). (`_id`→`id`, product `state`, envelope, status codes were **M3** and are already listed there.)

**C1–C11 / SEC suite — nothing breaks (verified against as-built):**
- **C1** duplicate-key `11000` → 409: preserved (`to-app-error.ts`); the new partial-unique indexes only add *more* 11000 sources, all mapped to 409 **[P2, P4]**.
- **C7 / duplicate → 409:** the case-insensitive email/name duplicate → 409 (message via §10.3); soft-deleted name is reusable (partial index) **[P1, P3]**.
- **C8 / search:** substring semantics, escaping, 20-cap and `state:true` unchanged; `sanitizeFilter`+`$or` still returns rows **[P6]**; envelope shape kept (D-12).
- **SEC-14:** `strictQuery`/`sanitizeFilter` stay global; M4 adds no raw-object filter.
- **F1 (auth timing):** the `select('+password')` change keeps one bcrypt compare per path and the dummy-hash branch (§10.4); a T4.3 timing test re-proves it.
- **LOG-02 / redaction:** `password` stays `cast`-guarded and redacted; `SEED_ADMIN_PASSWORD` is added to the seed's no-log rule and, if ever attached to a log object, to `REDACT_PATHS` (T4.3).

## 12. Task breakdown (parallel wave, M3 format)

Integration branch **`m4/database`**, cut from `next` @ `98ea113`. Shared contracts continue the P-series from M3 (**P16+**). Each task branches from `m4/database` after the merge it depends on; the Orchestrator merges each task and resolves any `src/app.ts`/`src/config`/`connection.ts` one-line contention.

**Shared contracts (P16–P20):**
- **P16** — Models keep the ADR-027 guarded sole-registrant block and the `Model<T>` annotation; only the schema body, `schema.index(...)` and plugin options change (D-3).
- **P17** — Index names and options are **exactly** §3.1 (the single source of truth); no field-level `unique`/`index`; every index traces to a real query (ARCHITECTURE §2.1).
- **P18** — The migration runner is idempotent: a migration that throws records nothing and retries; every `up` starts with an **abort-on-data-check**; every `down` states its reversibility (§5.3).
- **P19** — Production migrate/seed run compiled (`node dist/database/cli.js`); no new dependency (ADR-025); `autoIndex` off in production (§10.1).
- **P20** — Secrets (`password`, `SEED_ADMIN_PASSWORD`) are never logged; `password` is `select:false` and every authenticating read uses `+password` (§10.4).

| Task | Agent | Files allowed | Forbidden | Required | Acceptance | Commits |
|---|---|---|---|---|---|---|
| **T4.1 core DB plumbing** | BACKEND | `src/database/migrate.ts` (new), `src/database/cli.ts` (new), `src/database/connection.ts`, `src/config/env.ts`, `src/config/index.ts`, `src/server.ts` (pass `autoIndex`), `.example.env`, `package.json` (scripts only), `tests/unit/database/migrate.test.ts` (new) | any `*.model.ts`, any service, the migration/seed **files** (T4.4) | The ~50-line runner (§5.2) using `mongoose.connection.db` and `createLogger`; the CLI `migrate up\|down\|status [--dry-run] \| seed`; `connectDatabase(uri,{autoIndex})` with prod=false (§10.1); nested `config.seed` + `SEED_ADMIN_*` env (§10.2/D-14); compiled scripts (D-13). | typecheck/lint/format/build green; runner unit tests (apply-once, dry-run no-op, retry-after-throw, ledger); `pnpm build` emits `dist/database/cli.js`; cold frozen install unchanged (ADR-025); full suite still green. | `feat(db): migration runner + CLI (in-repo, no dep)`; `feat(config): seed env + autoIndex off in production` |
| **T4.2 schemas + indexes (GATE)** | DATABASE AGENT | `src/modules/{users,categories,products}/*.model.ts`, `src/core/database/to-json.plugin.ts` (**only** add `'tokenVersion'` to the user hidden list — no body change), `tests/unit/modules/{user,category,product}.model.test.ts`, `tests/integration/modules/{user,category,product}.model.test.ts` (new) | services, controllers, routes, `app.ts`, migrations, the plugin **body** | Apply §2.1–§2.3 to each schema body (timestamps, caps, `enum: ROLES`, `min:0`, `lowercase/uppercase/trim`, `image` validator, `tokenVersion`), **remove field-level `unique`**, add explicit `schema.index(...)` per §3.1, `{ versionKey:false, timestamps:true }` (§10.6); **keep** the ADR-027 guard (P16), the `cast` message (D-5) and `required` messages (D-6); update the model unit tests to the new shape (mapped drift). | `Model.init()`/`syncIndexes()` then `getIndexes()` equals §3.1 exactly; active case-variant dup → 11000, soft-delete reuse ok, email case dup → 11000 (model integration tests); toJSON hides `password`+`tokenVersion`, exposes `id`/`uid` (user) and `state` (all); no `OverwriteModelError`; full suite green; layer lint clean. | `feat(db): timestamps, enum, caps, image guard on schemas`; `feat(db): explicit index catalogue (§3.1); drop field-level unique` |
| **T4.3 normalization, uniqueness & secret safety** | SECURITY & QA | `src/modules/users/user.schemas.ts` (email transform), `src/modules/auth/auth.schemas.ts` (email transform), `src/modules/auth/auth.service.ts` (`+password`), `src/modules/{categories,products}/*.service.ts` (collated/normalized dup pre-check), `src/modules/users/user.service.ts` (normalized email pre-check), `src/database/seed.ts` **redaction only if present**, `src/core/logger.ts` (add `SEED_ADMIN_PASSWORD` redaction path), `tests/integration/security/*.test.ts` (email-dup, login-ci, password-not-leaked, seed-secret) | model schema bodies (T4.2), the runner (T4.1), migration files (T4.4) | §10.3 (case-insensitive pre-checks with the collation/normalization), §10.4 (`select:'+password'` in auth; login still works; F1 timing preserved), §10.5 (login case-insensitive, recorded + tested), P20 (secret never logged). | case-variant email dup → 409 with `'Email already registered'`; login with a different-case email succeeds; a wrong password still 401 with one bcrypt compare (timing flat); `password` never in any response or log; `SEED_ADMIN_PASSWORD` never logged; full suite green. | `fix(users,auth): normalize email; case-insensitive uniqueness (DB-02)`; `fix(auth): read password with +password under select:false`; `test(security): email normalization, uniqueness, secret redaction` |
| **T4.4 migrations + seed** | BACKEND | `src/database/migrations/M001..M004*.ts` (new), `src/database/seed.ts` (new), `src/database/cli.ts` (wire the list + seed), `tests/integration/database/{migrations,seed,indexes}.test.ts` (new), `docs/*` runbook only if asked | model schemas (T4.2), services (T4.3) | §5.3 M001–M004 (each `up` aborts on its data check; each `down` per §5.3/§7.4), §6 seed (create-only, idempotent, refuses weak/existing-admin, nested config), §7 checklist reflected in the runbook and the index test. | migrations apply once + record, second run no-op, `--dry-run` writes nothing; M001 aborts on case-dup emails, M002 on dup active names, M004 on unknown role and drops `roles`; M003 backfill == `_id.getTimestamp()` **[P5]**; `down` reverses per §7.4; seed tests per D4 §8 #8; `getIndexes()` == §3.1 after a fresh `migrate up`; full suite green. | `feat(db): M001–M004 migrations (up/down, abort-on-check)`; `feat(db): first-admin seed (create-only, idempotent)` |
| **T4.5 final review** | ARCHITECT | — (read-only) | — | Adversarial review vs this design + P16–P20; C1–C11/SEC re-attempt; index catalogue vs §3.1; migration up/down + abort paths; seed idempotency + secret safety; cold frozen install; contract-impact ledger. | ACCEPT/RETURN per task; findings + reproduction; docs-for-close list. | — |

**Dependency sequence:** `T4.1` → **`T4.2` (GATE — reviewed before T4.3/T4.4 start, as T3.2 was)** → { `T4.3`, `T4.4` } in parallel → `T4.5`. T4.3 needs T4.2's normalized schema; T4.4 needs T4.1's runner and T4.2's final index defs. The Orchestrator applies the one-line `server.ts`/`config`/`connection.ts` edits at merge.

**Revert units.** Each commit above is an independent revert unit. T4.1/T4.2/T4.3 are code reverts (schema/index/service). T4.4's migrations are **data** revert units via `down` (run `pnpm migrate down` before reverting the code that defines them; §13). Reverting the whole M4 merge on `next` (ADR-026) is the milestone-level rollback and leaves `master`/2.x untouched.

## 13. Risks and rollback (per task and for data)

| Risk | Task | Likelihood | Mitigation / rollback |
|---|---|---|---|
| **Index build fails on existing active duplicates** (a partial-unique `name` or the `email` index) — refused with `11000` **[P7]**. | T4.4 (M001/M002) | Medium on real 2.x data | Each `up` runs the §7.2 abort-on-data-check **before** any `createIndex`, printing the offending ids; fix the data, re-run. The migration records nothing on abort (P18), so retry is safe. |
| **`select:false` breaks every login** if the auth read is not updated. | T4.3 | High if missed | §10.4: `+password` in the auth lookup + a login test in the same task; T4.2 (schema) and T4.3 (auth) both land before T4.5. Question: defer `select:false` to M5. |
| **Fresh production DB has no indexes** until `migrate up` runs (autoIndex off, §10.1). | T4.1 | Medium | Runbook: `pnpm build && pnpm migrate up` is part of the deploy; the `IXSCAN` verification (§7.3) gates "done". A missing index degrades to a COLLSCAN (slow), not incorrect. |
| **Email normalization is lossy** (casing cannot be restored by `down`). | T4.4 (M001) | — | M001.down rebuilds the index but warns casing is not restored; the only exact revert is the `mongodump` archive (§7.1/§7.4). Owner approves the window (§7.1). |
| **M002.down** recreates the legacy all-states `name_1` unique index, which **fails if soft-deleted duplicate names now exist** (allowed by the partial index). | T4.4 (M002) | Medium after use | `down` aborts with the offending ids; resolve or restore from backup. Documented in §5.3/§7.4. |
| **M004 drops `roles`** (destructive). | T4.4 (M004) | Low | Runs last, after the §7.3 code-reference gate; `down` recreates the three constant docs; no app data is in `roles`. |
| **Duplicate 409 message** is generic on the case-variant race path. | T4.3 | Low | §10.3 makes the pre-check case-insensitive so the specific message wins; the generic 409 only appears on a true concurrent race, which is still a correct 409 (C7). |
| **Contract drift** from timestamps/normalization breaking existing tests. | T4.2/T4.3 | Expected | Mapped in §11; the model unit tests are updated in T4.2, the auth/users tests in T4.3; T4.5 confirms no C1–C11/SEC assertion is dropped (the M3 method). |
| **New dependency slips in** (e.g. `migrate-mongo`, or `tsx` promoted to prod). | all | Low | P19 + ADR-025: the runner is in-repo, migrate/seed run `node dist/...`; T4.5 checks `git diff -- package.json pnpm-lock.yaml` is empty and a cold frozen install is green. |

**Emergency rollback (data):** stop the app, `mongorestore --drop` the pre-M4 archive, redeploy the previous image, investigate offline (§7.4). For a code-only problem after a clean migration, revert the M4 merge on `next`; the data changes (normalized email, timestamps, indexes) are forward-compatible with M3 code (M3 ignores the extra fields), so a code revert alone does not require a data down-migration unless the indexes must go too.

## 14. Questions for the Orchestrator

1. **`select: false` on `password` now, or defer to M5?** It is defense-in-depth (the plugin already hides `password`), but it forces an auth-service change this milestone (§10.4). M5 reworks auth (Bearer, async bcrypt) and would absorb it naturally. Recommendation: **keep it in M4** (it closes a real `.lean()`/projection leak class now) with the T4.3 coordination; defer only if M4 must not touch `src/modules/auth`.
2. **`versionKey: false` on all three schemas (§10.6)**, standardizing away the M3 inconsistency, or keep D4's "leave `__v` in the DB"? Recommendation: `versionKey: false` (uniform, no API impact); no code uses OCC.
3. **Login case-insensitivity (§10.5)** is a deliberate 3.0.0 improvement folded into M4. Confirm it should ship in 3.0.0 rather than be held.
