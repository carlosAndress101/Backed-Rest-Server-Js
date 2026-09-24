# M2: Foundation · Technical Design

> Author: ARCHITECT · 2026-09-23, amended 2026-09-24 · Status: **Accepted with amendments AM-1…AM-4** (folded in below; this document is the single source of truth)
> Base: `m1/stabilization` @ `a29c539` (M1 T1.1–T1.4 merged, contracts C1–C11). T1.7 (C9–C11) is reconciled against `m1/t1.7-deploy-hardening` @ `7a932d5`, which is done but not yet merged.
> Governing ADRs: ADR-002…ADR-005, ADR-009, ADR-011…ADR-016, and ADR-017…ADR-024, the last eight accepted on 2026-09-23 and recorded in `ARCHITECTURE.md` §3.

**How this was validated.** Every contract, config file and script in this document was built and run in a throw-away prototype (scratchpad, outside the repo). The prototype combined the dependency set, the platform code below and the real legacy JS.
- **Original design**, run on the T1.3 legacy code: `tsc` typecheck and build, type-aware ESLint (including deliberate boundary violations), Prettier and Vitest all passed. A **mechanical port of T1.4's `reliability.e2e.js` passed 13/13 on the first run**. The build booted from `dist/` against `mongodb-memory-server`, fail-fast paths and SIGTERM included. `pnpm audit` (prod and full) reported 0 advisories.
- **Amendment**, re-run on the T1.7 legacy code (`7a932d5`):
  - the env schema with `TRUST_PROXY`, and `createApp` without the global `fileUpload`;
  - T1.7's C10 suite, ported, with every "other routes ignore multipart" case green;
  - ports of T1.7's three new test files (the two amended mapping rows included), with titles identical to the originals;
  - the platform `TRUST_PROXY` test;
  - **57/57 green on 5 consecutive runs**.

The evidence is summarised in Appendix C.

**Line references.** `file:line` refers to `a29c539` unless it is tagged *(T1.7)*, which means `7a932d5`. Tasks T2.2 onwards start only after T1.7 is merged forward (§7.3), so implementing agents locate each site **by content** on that code. Every site-level acceptance criterion below is a `grep` or lint rule, not a line number.

---

## 1. Decisions summary

### 1.1 ADRs from this design (accepted 2026-09-23; recorded in `ARCHITECTURE.md` §3)

| ID | Decision | Rationale | Consequence |
|---|---|---|---|
| ADR-017 | **CommonJS output; `src/` → `dist/` build; legacy JS stays outside the build.** `package.json` `"type": "commonjs"`, TS `module: nodenext`. `tsconfig.build.json` has `rootDir: src`, `outDir: dist`. Legacy JS is never compiled or moved. TS reaches it only through `require()` in one seam, `src/legacy.ts` (tests: `tests/helpers/legacy.ts`). Legacy JS never requires `src/` (lint-enforced). **M3 seam:** when a TS module takes over a Mongoose model, the legacy file that still needs it reads it from the Mongoose registry (`module.exports = require('mongoose').model('Category')`), never by path. | `src/` and `dist/` are both one level under the root, so `require('../routes/x')` resolves identically under `tsx`, Vitest and `node dist/`. Legacy `__dirname` paths (`../uploads`, `../assets`, `../public`) keep working. `"type": "module"` would reinterpret every legacy `.js` as ESM. Emitting legacy into `dist/` would move those `__dirname`-relative paths inside `dist/`, where neither `assets/notFound.jpg` nor the upload directory exists. | One module instance of every CJS package (Express, Mongoose, Cloudinary SDK) is shared by app, legacy and tests. ESM output stays possible later, as a separate decision after M3. |
| ADR-018 | **Pin TypeScript 6.0.3, not 7.0.2.** The tsconfig uses no option deprecated in 6.0, so moving to 7.x is a version bump. | `typescript-eslint@8.70.1` (required for type-aware lint) declares `typescript: ">=4.8.4 <6.1.0"`. TS 7 (the Go port) is `latest` on npm but unsupported by the linter. | Revisit when typescript-eslint supports 7 (Renovate, M10). |
| ADR-019 | **Configuration:** one zod schema validates the whole environment at boot and exits non-zero on any error. Variable **names stay unchanged** (`MONGO_CLOUD`, `SECRET_KEY`, …). Empty values count as unset. `.env` is loaded by Node's `--env-file-if-exists` (**`dotenv` removed**). **Transition:** until each legacy file is replaced in M3, legacy JS reads only the validated variables `SECRET_KEY`, `GOOGLE_CLIENT_ID` and `CLOUDINARY_URL` directly from `process.env`. That allowlist is lint-enforced; there is no bridge module. `TRUST_PROXY` (C9) is part of the schema; its legacy parse in `models/server.js` moves to config. | Fail-fast covers legacy reads too, since the process never starts with an invalid value. A bridge would make legacy JS require TS, which breaks the compiled build (ADR-017). Renaming variables would break deployments for no gain. | CFG-01 is fixed for platform code in M2 and fully in M3. `GOOGLE_SECRET_ID` (unused) disappears from `.example.env`. |
| ADR-020 | **Logging:** pino + pino-http (ADR-011). pino-http is the first middleware. It assigns `x-request-id` (the inbound value if it matches `^[\w.:-]{1,128}$`, otherwise a UUID v4), echoes it in the response, and writes **one line per request** on completion, carrying the error cause when there is one. **Legacy JS logs only through `req.log`** (child logger bound to `reqId`). Legacy code without `req` in scope does not log: it rejects or throws with the original error, and the platform logs it. `console.*` is a lint error everywhere except the boot-failure path in `src/server.ts`. | Request correlation without AsyncLocalStorage. No legacy file needs a new import. | LOG-01 fixed in M2. M3 services receive the root logger through their factory when they need one. |
| ADR-021 | **Error bodies stay `{ msg }` in M2.** The `AppError` hierarchy, `toAppError()` and the envelope helpers ship in M2. The error handler emits the M1 C1/C2 bodies byte-for-byte. M3 switches the handler to `{ error: { code, message, details? } }` as part of the **3.0.0** contract change (ADR-024: M1 ships as 2.0.0 and M2 as 2.1.0), together with the success envelope. | The M1 suite asserts `toEqual({ msg })` and `Object.keys(body) == ['msg']`, and clients depend on it. Two error shapes in one release would break SemVer. | REL-02 is fixed in M2 (one model, one middleware). HTTP-01 stays in M3. |
| ADR-022 | **CORS:** `CORS_ORIGINS` (comma-separated origins) enables an allowlist. **Unset or `*` keeps today's behaviour (any origin)**, and boot logs a `warn` in production. | Auth is a header token (`x-token`), not a cookie, and `credentials` is never enabled, so an open CORS policy does not expose ambient credentials. API consumers are unknown (ADR-015), so a deny-by-default would be a silent breaking change. | SEC-10 → allowlist available. Kept as written after review (D2 Q3); the M9 production checklist sets `CORS_ORIGINS`. |
| ADR-023 | **Test doubles and isolation:** `vi.mock()` is banned in tests (lint). Legacy JS loads dependencies with Node's `require`, which `vi.mock` does not intercept (verified). Tests therefore stub by spying on the *shared CommonJS instance* exported from `tests/helpers/legacy.ts`. In M3, TS code is tested through DI. Each test file runs in its own process (`pool: forks`, `isolate: true`) against **its own database** on one shared `mongod`. | A `vi.mock('cloudinary')` would silently leave the real SDK in place and hit the network. A per-file database removes the cross-file interference that one shared DB causes with parallel files. | The M1 suite ports mechanically, except two documented rows (env overrides, log assertions; §5.3). Files run in parallel safely. |

### 1.2 Decisions taken inside existing ADRs (no new ADR needed)

- **Express 5.2.1 (ADR-003)** and **Mongoose 9.10.2** land as **separate, individually revertible commits**, each before any TS platform code, so the platform is written once against the final APIs (§7, §8.1).
- **Layer boundaries (ARCHITECTURE §2.3) are enforced with ESLint's own `no-restricted-imports` / `no-restricted-syntax`**, not a plugin (§3.5).
- **`strictQuery: true` and `sanitizeFilter: true`** land as their own commit (SEC-14). Both are verified to work on Mongoose 7 and 9, so that commit reverts independently of the upgrade.
- **Legacy compatibility shim for Express 5:** `req.body ??= {}` in front of legacy routers only (Appendix A, item 18). It is deleted with `src/legacy.ts` at the end of M3.
- **Multipart stays in legacy code (C10).** T1.7 moved multipart parsing onto the two upload write routes, after authentication, authorization and validation. `createApp` therefore has **no** multipart parser. The router-level `fileParser` in `middlewares/file-valid.js` stays until the M3 media module replaces it. The 5 MB limit stays a legacy literal in the meantime (the M3 media module reintroduces it as config).
- **Release mapping (ADR-024):** M2 ships as **2.1.0** (operational and additive). The envelope and error-shape switch belongs to **3.0.0**.

---

## 2. Target tree after M2

```
Backed-Rest-Server-Js/
├── .github/workflows/ci.yml          NEW  (T2.7)
├── src/                              NEW  TypeScript platform (strangler, ADR-016)
│   ├── server.ts                     boot: loadConfig → createLogger → connectDatabase → createApp → listen → shutdown
│   ├── app.ts                        createApp(deps): composition root, middleware order, no side effects beyond construction
│   ├── legacy.ts                     the only TS→JS seam: mounts the legacy routers (deleted at the end of M3)
│   ├── config/
│   │   ├── env.ts                    zod env schema (every variable the process reads)
│   │   └── index.ts                  loadConfig(), Config, ConfigError
│   ├── core/
│   │   ├── errors/
│   │   │   ├── app-error.ts          AppError + 7 subclasses
│   │   │   ├── to-app-error.ts       toAppError(): the C1 mapping
│   │   │   └── index.ts
│   │   ├── http/envelope.ts          envelope(), pageEnvelope(), errorEnvelope()  (consumed from M3)
│   │   └── logger.ts                 createLogger(), REDACT_PATHS
│   ├── middlewares/
│   │   ├── request-logger.ts         pino-http + request id
│   │   ├── not-found.ts              C2
│   │   └── error-handler.ts          C1
│   └── database/
│       └── connection.ts             connectDatabase(), disconnectDatabase(), strictQuery + sanitizeFilter
├── tests/                            NEW  replaces e2e/
│   ├── setup/global-setup.ts         one mongod per run, URI via provide/inject
│   ├── helpers/
│   │   ├── app.ts                    startTestApp(overrides?), stopTestApp(), clearDatabase(), loggedText(), clearLogs()
│   │   ├── legacy.ts                 CJS seam: legacyModels(), LegacyDoc, generarJWT, stubGoogleVerify(), stubCloudinary()
│   │   ├── factories.ts              createUser/createAdmin/createCategory/createProduct/seedRoles/tokenFor/authHeader…
│   │   └── uploads.ts                temp-file and upload-dir helpers (from e2e/helpers/db.js, incl. T1.7's upload-<pid>-* folders)
│   ├── unit/                         config, errors, envelope, logger
│   └── integration/
│       ├── platform/                 app (headers, 404, errors, request id, CORS), trust-proxy, database, server (spawned process)
│       └── security/                 the M1 regression suite, ported 1:1: auth, image-replacement, multipart-scope, rate-limit,
│                                     reliability, search, trust-proxy, uploads, users (every e2e/*.e2e.js at the merge base)
├── routes/ controllers/ middlewares/ helpers/     LEGACY JS, in place, behaviour unchanged (edits listed in §4.8)
├── models/                                         LEGACY JS; server.js REMOVED; index.js no longer exports Server (ARC-03)
├── public/ assets/ uploads/                        unchanged
├── dist/                                           build output (already gitignored)
├── tsconfig.json  tsconfig.build.json  eslint.config.mjs  .prettierrc.json  .prettierignore  vitest.config.mts   NEW
├── package.json  pnpm-lock.yaml  pnpm-workspace.yaml  .example.env                                                CHANGED
└── REMOVED: app.js, models/server.js, database/config.js (and database/), e2e/, jest-e2e.json
```

ARCHITECTURE §2.2 items not created in M2 (they have no M2 consumer): `core/security/`, `middlewares/{authenticate,authorize,validate}.ts`, `database/{migrations,seed}` and `modules/`. They arrive in M3/M4/M6.

---

## 3. Toolchain

### 3.1 Dependencies

Versions come from `npm view <pkg> version` on 2026-09-23 and are pinned **exactly**. With them, `pnpm audit --prod` and full `pnpm audit` both report **0 advisories**.

| Package | Version | Kind | Why (and what it replaces) |
|---|---|---|---|
| express | **5.2.1** (was ^4.18.2) | runtime | ADR-003. |
| mongoose | **9.10.2** (was ^7.5.0) | runtime | ROADMAP M2. Pulls MongoDB driver 7.6 (**server ≥ 4.4**, Appendix B). |
| zod | 4.6.5 | runtime | ADR-006. Env schema now, DTOs in M3. No dependencies. |
| pino | 10.3.1 | runtime | ADR-011. |
| pino-http | 11.0.0 | runtime | ADR-011. Request logging, `req.log` and the request id in one middleware. |
| typescript | **6.0.3** | dev | ADR-002 / ADR-018 (7.0.2 is blocked by typescript-eslint). |
| tsx | 4.23.15 | dev | ADR-002 dev runner (`tsx watch`). **Replaces nodemon.** |
| vitest | 5.0.1 | dev | ADR-013. **Replaces jest.** Pulls `vite@8.3.0` as a peer (pinned by the lockfile). |
| @vitest/coverage-v8 | 5.0.1 | dev | Coverage (§5.5). Must equal the vitest version. |
| eslint | 10.11.0 | dev | Lint gate, flat config. |
| @eslint/js | 10.0.1 | dev | `js.configs.recommended`. |
| typescript-eslint | 8.70.1 | dev | TS parser and type-aware rules (`no-floating-promises` catches the REL-01 bug class). |
| prettier | 3.9.9 | dev | Formatting. No `eslint-config-prettier`: neither recommended config ships formatting rules. |
| @types/node | 24.13.6 | dev | Match the Node 24 runtime (ADR-014), not `latest` (26.x). |
| @types/express | 5.0.6 | dev | `src/app.ts`, middlewares. |
| @types/cors | 2.8.19 | dev | `src/app.ts`. |
| @types/supertest | 7.2.1 | dev | tests. |
| @types/bcrypt | 6.0.0 | dev | `tests/helpers/factories.ts` now; `core/security` in M3. |

**Removed:** `jest` (replaced by vitest), `nodemon` (replaced by `tsx watch`), `dotenv` (replaced by `node --env-file-if-exists`, Node ≥ 20.6). **Unchanged:** every other runtime dependency; `supertest` ^7.3.0 and `mongodb-memory-server` ^11.3.0 (dev).
**Considered and not added:** `globals` (TS files don't need `no-undef`; legacy JS runs only three rules), `pino-pretty` (use `pnpm dev | pnpm dlx pino-pretty` ad hoc), `eslint-plugin-boundaries` (core rules are enough, §3.5), `dotenv`, `@types/express-fileupload` (C10 keeps multipart in legacy JS, so no TS code imports it in M2; the M3 media module adds it if it keeps the library).

**`pnpm-workspace.yaml`** (pnpm 12 fails install with `ERR_PNPM_IGNORED_BUILDS` for any unlisted build script; `tsx`/`vite` pull `esbuild`, which works without its postinstall, verified):

```yaml
allowBuilds:
  bcrypt: true
  esbuild: false
  mongodb-memory-server: false
```

### 3.2 `package.json` after M2

```json
{
  "name": "backed-rest-server-js",
  "version": "1.0.0",
  "description": "",
  "main": "dist/server.js",
  "type": "commonjs",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node --enable-source-maps --env-file-if-exists=.env dist/server.js",
    "dev": "tsx watch --env-file-if-exists=.env src/server.ts",
    "typecheck": "tsc -p tsconfig.json",
    "lint": "eslint . --max-warnings 0",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  },
  "repository": { "type": "git", "url": "git+https://github.com/carlosAndress101/Backed-Rest-Server-Js.git" },
  "keywords": ["express", "nodejs"],
  "author": "Carlos Andres Hinestroza <carloshinestroza101@gmail.com>",
  "license": "MIT",
  "dependencies": {
    "bcrypt": "^6.0.0",
    "cloudinary": "^2.11.0",
    "cors": "^2.8.5",
    "express": "5.2.1",
    "express-fileupload": "^1.4.1",
    "express-rate-limit": "^8.7.0",
    "express-validator": "^7.0.1",
    "google-auth-library": "^11.1.0",
    "helmet": "^8.3.0",
    "jsonwebtoken": "^9.0.2",
    "mongoose": "9.10.2",
    "pino": "10.3.1",
    "pino-http": "11.0.0",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@types/bcrypt": "6.0.0",
    "@types/cors": "2.8.19",
    "@types/express": "5.0.6",
    "@types/node": "24.13.6",
    "@types/supertest": "7.2.1",
    "@vitest/coverage-v8": "5.0.1",
    "eslint": "10.11.0",
    "mongodb-memory-server": "^11.3.0",
    "prettier": "3.9.9",
    "supertest": "^7.3.0",
    "tsx": "4.23.15",
    "typescript": "6.0.3",
    "typescript-eslint": "8.70.1",
    "vitest": "5.0.1"
  },
  "engines": { "node": ">=24" },
  "packageManager": "pnpm@12.3.4"
}
```

Script notes: `start` requires a prior `pnpm build` (deployment impact, §8.3). `--env-file-if-exists` never overrides variables already set in the environment (same precedence as dotenv). `--enable-source-maps` maps production stack traces to `.ts` lines. `tsc` does not delete stale `dist/` files; CI always builds from a clean checkout.

### 3.3 TypeScript configuration

`tsconfig.json`: one program for the editor, `pnpm typecheck` and ESLint's project service. It covers all TS **and** the legacy JS (inferred types, no errors reported):

```jsonc
{
  "compilerOptions": {
    "target": "es2025",              // Node 24 runs ES2025 (RegExp.escape, Promise.try, Set methods: verified)
    "lib": ["es2025"],
    "module": "nodenext",            // with "type": "commonjs" → CJS output (ADR-017)
    "moduleResolution": "nodenext",
    "types": ["node"],               // TS 6 defaults `types` to []
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,         // tsx and Vitest transpile per file
    "esModuleInterop": true,         // `false` is deprecated in TS 6
    "skipLibCheck": true,
    "allowJs": true,                 // ADR-002: legacy JS is part of the program…
    "checkJs": false,                // …but is not type-checked
    "noEmit": true
  },
  "include": ["src", "tests", "routes", "controllers", "middlewares", "helpers", "models", "vitest.config.mts"]
}
```

`tsconfig.build.json`: emits only `src/`. A TS `import` of a legacy file fails the build with TS6059 ("not under rootDir"), which enforces ADR-017 for free:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "noEmitOnError": true, "rootDir": "src", "outDir": "dist", "sourceMap": true },
  "include": ["src"]
}
```

Deliberately **not** set: `verbatimModuleSyntax` (forbids ESM syntax in CJS output), `exactOptionalPropertyTypes` (friction with Express and Mongoose typings, little value here), `baseUrl`/`paths` (deprecated in TS 6, and they would need runtime resolution), `resolveJsonModule`.

### 3.4 Build, dev and runtime layout

| Mode | Command | Loads TS via | Loads legacy JS via | `.env` |
|---|---|---|---|---|
| dev | `pnpm dev` | tsx (CJS hooks), restarts on change of any loaded file | Node `require` | `--env-file-if-exists` |
| build | `pnpm build` | tsc → `dist/**/*.js` + maps | not compiled (stays in place) | — |
| prod | `pnpm start` | plain Node (`dist/`) | Node `require` from `dist/legacy.js` → `../routes/*` | `--env-file-if-exists` |
| test | `pnpm test` | Vitest (Vite module runner; `require`, `__dirname` provided) | Node `require` (native, uninstrumented by `vi.mock`) | `test.env` in `vitest.config.mts` |

### 3.5 ESLint (flat config) and the layer-boundary rules

`eslint.config.mjs` is shown here in its final state after M2. The two rules marked *(T2.5)* are enabled by T2.5, once the legacy sites they flag are fixed.

```js
// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const LEGACY_DIRS = ['routes', 'controllers', 'middlewares', 'helpers', 'models'];

// ARCHITECTURE §2.3. Each file gets exactly one `no-restricted-imports` entry (flat config replaces, never merges).
const rule = (message, regex, allowTypeImports = false) => ({ regex, message, allowTypeImports });
const SIBLING_MODULE = rule('Modules never import another module; wire services in src/app.ts (§2.3 rule 4).', '^\\.\\./[^./]');
const FEATURE_MODULES = rule('Cross-cutting code must not import feature modules (§2.3 rule 5).', '(^|/)modules(/|$)');
const COMPOSITION = rule('Only the entrypoint may import the composition root or the legacy seam.', '(^|/)(app|server|legacy)$');
const PERSISTENCE = rule('Routes and controllers never touch persistence; call a service (§2.3 rules 1-2).', '^mongoose$|\\.model$');
const HTTP = rule('Services never import Express, routes, controllers or middlewares (§2.3 rule 3).', '^express($|-)|\\.(routes|controller)$|(^|/)middlewares(/|$)');
const ROUTE_SKIPS_CONTROLLER = rule('Routes call controllers, not services (§2.3 rule 1).', '\\.service$');
const SDK = rule('External SDKs are wrapped by a *.client.ts and injected into services.', '^(cloudinary|google-auth-library)$');

const layer = (files, ...patterns) => ({
  files,
  rules: { '@typescript-eslint/no-restricted-imports': ['error', { patterns }] },
});

export default tseslint.config(
  // 'e2e/' is ignored only while the Jest suite exists (T2.6 deletes both): its unused
  // `eslint-disable` directives are warnings under ESLint 10 and would fail --max-warnings 0.
  { ignores: ['dist/', 'coverage/', 'public/', 'node_modules/', 'e2e/'] },
  {
    files: ['**/*.ts', '**/*.mts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true } },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/config/**'],
    rules: {
      'no-console': 'error',
      'no-restricted-properties': ['error', { object: 'process', property: 'env', message: 'Read configuration from the Config object (src/config).' }],
    },
  },
  layer(['src/config/**/*.ts'], rule('config is a leaf: it imports nothing else from the app.', '^\\.\\./')),
  layer(['src/core/**/*.ts'], FEATURE_MODULES, COMPOSITION,
    rule('core must not depend on HTTP middlewares or the database.', '(^|/)(middlewares|database)(/|$)'),
    rule('core stays framework-agnostic.', '^express($|-)', true)),
  layer(['src/middlewares/**/*.ts', 'src/database/**/*.ts'], FEATURE_MODULES, COMPOSITION),
  layer(['src/modules/**/*.ts'], SIBLING_MODULE, COMPOSITION),
  layer(['src/modules/**/*.routes.ts'], SIBLING_MODULE, COMPOSITION, PERSISTENCE, ROUTE_SKIPS_CONTROLLER, SDK),
  layer(['src/modules/**/*.controller.ts'], SIBLING_MODULE, COMPOSITION, PERSISTENCE, SDK),
  layer(['src/modules/**/*.service.ts'], SIBLING_MODULE, COMPOSITION, HTTP, SDK),
  {
    // Legacy JS (ADR-016) is not style-linted. It must never reach into src/ (only .ts in dev, breaks dist).
    files: LEGACY_DIRS.map((dir) => `${dir}/**/*.js`),
    languageOptions: { sourceType: 'commonjs' },
    rules: {
      'no-console': 'error', // (T2.5) ADR-020
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.name='require'] > Literal[value=/(^|\\/)(src|dist)(\\/|$)/]",
          message: 'Legacy JS must not require src/ or dist/ (breaks the compiled build).' },
        { selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name!=/^(SECRET_KEY|GOOGLE_CLIENT_ID|CLOUDINARY_URL)$/]",
          message: 'Legacy JS may only read the env vars validated by src/config/env.ts.' }, // (T2.5) ADR-019
      ],
    },
  },
  {
    // supertest bodies and legacy Mongoose documents are untyped until M3 replaces the legacy modules.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off', // ported M1 fixtures use async setups without await
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock)$/]",
        message: 'vi.mock cannot reach require() in legacy JS: spy on the instance from tests/helpers/legacy.ts.' }], // ADR-023
    },
  },
  { files: ['**/*.mjs'], extends: [js.configs.recommended, tseslint.configs.disableTypeChecked] },
);
```

**Layer rules → lint rules** (all verified against deliberate violations; §2.3 applies to `src/modules/**` from M3, and M2 code is already bound by rules 5–8):

| ARCHITECTURE §2.3 rule | Enforced by |
|---|---|
| 1. Routes: path, middleware, controller only | `*.routes.ts` may not import `mongoose`, `*.model`, `*.service`, SDKs |
| 2. Controllers: no Mongoose, no business rules | `*.controller.ts` may not import `mongoose`, `*.model`, SDKs |
| 3. Services never import Express, throw `AppError` | `*.service.ts` may not import `express*`, `*.routes`, `*.controller`, `middlewares/` |
| 4. Modules never import another module's internals | `src/modules/**` may not import `../<sibling>/…` |
| 5. `core/` must not import `modules/` | `src/core/**` may not import `modules/`, `middlewares/`, `database/`, `app`/`server`/`legacy`, nor `express` values |
| 6. (M2) config is a leaf; only `src/config` reads `process.env` | `no-restricted-imports` `^\.\./` in `src/config/**`; `no-restricted-properties` elsewhere in `src/` |
| 7. (M2) TS never imports legacy JS | the build itself (TS6059) + `@typescript-eslint/no-require-imports` (only `src/legacy.ts` and `tests/helpers/legacy.ts` carry a scoped disable) |
| 8. (M2) Legacy never requires `src/`/`dist/`, reads only validated env, never logs to console | legacy block above |

### 3.6 Prettier

`.prettierrc.json`:

```json
{ "singleQuote": true, "printWidth": 110 }
```

`.prettierignore` (legacy JS and docs are excluded so that M2 produces no whitespace churn in files it does not own; the `e2e/` lines are removed by T2.6 when the Jest suite is deleted):

```
dist/
coverage/
public/
uploads/
assets/
pnpm-lock.yaml
*.md
routes/
controllers/
middlewares/
helpers/
models/
e2e/
jest-e2e.json
```

### 3.7 Vitest

`vitest.config.mts` (`.mts` because the package is CommonJS; Vite warns on ESM syntax in a CJS-typed `.ts` config):

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each test file runs in its own child process: legacy CommonJS modules (and their in-memory
    // state such as the login rate limiter) are loaded fresh per file. Both values are the defaults.
    pool: 'forks',
    isolate: true,
    restoreMocks: true,
    testTimeout: 10_000,
    globalSetup: ['tests/setup/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      SECRET_KEY: 'test-secret',
      GOOGLE_CLIENT_ID: 'test-client-id',
      CLOUDINARY_URL: 'cloudinary://key:secret@demo',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'routes/**/*.js', 'controllers/**/*.js', 'middlewares/**/*.js', 'helpers/**/*.js', 'models/**/*.js'],
      exclude: ['src/server.ts'], // exercised by a spawned process (§5.4), invisible to in-process V8 coverage
      reporter: ['text-summary', 'text', 'lcov'],
      thresholds: { 'src/**/*.ts': { lines: 90, functions: 90, branches: 80, statements: 90 } },
    },
  },
});
```

---

## 4. Platform contracts

### 4.1 Configuration (`src/config`)

**Environment schema.** This is every variable the process reads. Boot fails on any violation, and the error lists **all** failing variables at once (zod `prettifyError`). An empty value (`FOO=`) is treated as unset.

| Variable | Type / format | Default | Required | Consumed by |
|---|---|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` | no | logger level default, CORS warning |
| `PORT` | integer 1–65535 | `1500` (unchanged from legacy; CFG-02 doc mismatch fixed in `.example.env`) | no | `server.ts` |
| `LOG_LEVEL` | `fatal`…`trace` \| `silent` | `info`; `silent` when `NODE_ENV=test` | no | logger |
| `MONGO_CLOUD` | `mongodb://` or `mongodb+srv://` URI | — | **yes** | `connectDatabase` |
| `SECRET_KEY` | non-empty string (min length is raised in M5) | — | **yes** | legacy JWT (read directly, ADR-019); `config.auth` in M3 |
| `GOOGLE_CLIENT_ID` | non-empty string | — | **yes** | legacy Google verify; `config.auth` in M3 |
| `CLOUDINARY_URL` | `cloudinary://<key>:<secret>@<cloud>` | — | **yes** | Cloudinary SDK (reads env itself); `config.media` in M3 |
| `CORS_ORIGINS` | comma-separated origins, or `*` | unset → any origin (ADR-022) | no | `createApp` |
| `TRUST_PROXY` | `^\d+$` → number (reverse-proxy hop count); anything else is a `ConfigError` | unset → Express default (`req.ip` = socket address, `X-Forwarded-For` ignored) | no | `createApp` → `app.set('trust proxy', n)` (C9); `req.ip` is the C5 limiter key |

`GOOGLE_CLIENT_ID` is required for security, not just for completeness. With the variable unset, `verifyIdToken({ audience: undefined })` skips the audience check, so an ID token issued to **any** Google client would be accepted by `POST /api/auth/google`. That login auto-links by email (SEC-12), which would make this an account-takeover path.

```ts
// src/config/env.ts
import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Every environment variable the process reads. Names are unchanged from the legacy code (ADR-019). */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(1500),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  MONGO_CLOUD: z.string().regex(/^mongodb(\+srv)?:\/\/\S+$/, 'must be a mongodb:// or mongodb+srv:// URI'),
  SECRET_KEY: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  CLOUDINARY_URL: z.string().regex(/^cloudinary:\/\/[^:\s]+:[^@\s]+@\S+$/, 'must be cloudinary://<api_key>:<api_secret>@<cloud_name>'),
  CORS_ORIGINS: z.string().optional(),
  TRUST_PROXY: z.string().regex(/^\d+$/, 'must be a non-negative integer hop count (C9)').transform(Number).optional(),
});

export type Env = z.infer<typeof envSchema>;
```

```ts
// src/config/index.ts
export type LogLevel = NonNullable<Env['LOG_LEVEL']>;

export interface Config {
  readonly env: Env['NODE_ENV'];
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly mongoUri: string;
  readonly cors: { readonly origins: '*' | readonly string[] };
  /** C9: reverse-proxy hops to trust for req.ip (and so the C5 limiter key); undefined keeps Express's default. */
  readonly trustProxy: number | undefined;
  /** Consumed by the auth and users modules in M3; legacy JS reads the same variables directly until then. */
  readonly auth: { readonly jwtSecret: string; readonly googleClientId: string };
  /** Consumed by the media module in M3. */
  readonly media: { readonly cloudinaryUrl: string };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parses and validates the environment once, at boot. Throws ConfigError listing every invalid variable. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // An empty variable (`FOO=`) counts as unset, so defaults and "required" behave the same for both.
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  const origins = (env.CORS_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);

  return Object.freeze<Config>({
    env: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    mongoUri: env.MONGO_CLOUD,
    cors: { origins: origins.length === 0 || origins.includes('*') ? '*' : origins },
    trustProxy: env.TRUST_PROXY,
    auth: { jwtSecret: env.SECRET_KEY, googleClientId: env.GOOGLE_CLIENT_ID },
    media: { cloudinaryUrl: env.CLOUDINARY_URL },
  });
}
```

**Fail-fast behaviour:** `loadConfig()` is the first statement of `main()` in `server.ts`. A `ConfigError` goes to stderr as plain text (the logger does not exist yet) and the process exits with code **1** before any socket or DB connection opens.
- Verified output: `Invalid environment: ✖ Too small: expected string to have >=1 characters → at SECRET_KEY ✖ must be cloudinary://… → at CLOUDINARY_URL`.
- `TRUST_PROXY` (verified on the amended prototype): unset and `''` → `undefined`; `'0'` → `0`; `'2'` → `2`. `'abc'`, `'-1'`, `'true'`, `'1.5'` and `' 1'` each give `ConfigError` `✖ must be a non-negative integer hop count (C9) → at TRUST_PROXY`, the same accept/reject set as T1.7's `models/server.js` parse. The platform keeps T1.7's C9 behaviour; only the error class and message change, from `Error: TRUST_PROXY must be …` thrown by `new Server()` to a `ConfigError` naming the variable.

CFG-02 hardcoded values that move to config in M2 are `PORT`, CORS and the proxy hop count. The temp dir is already `os.tmpdir()` from M1. The **upload size limit stays a legacy literal** in `middlewares/file-valid.js` (C10), and the M3 media module adds `UPLOAD_MAX_BYTES` back as config when it replaces that file. The JWT TTL, bcrypt cost, page size and allowed extensions move into `Config` in M3/M5, together with the module that consumes them. The `public/` client id and URL are decided in M8 (CQ-07).

`.example.env` after M2. Node's `--env-file` parser handles inline `#` comments, the `export` prefix and quoted values the way dotenv does (verified); comments sit on their own lines for readability:

```
# Copied to .env for local development and validated at boot by src/config/env.ts (the process exits on any error).
# development | test | production (default development)
NODE_ENV=development
# default 1500
PORT=1500
# fatal | error | warn | info | debug | trace | silent (default info, silent under test)
LOG_LEVEL=
# required
MONGO_CLOUD=mongodb://127.0.0.1:27017/cafe
# required: JWT signing secret
SECRET_KEY=
# required: Google OAuth client id (the ID-token audience)
GOOGLE_CLIENT_ID=
# required: cloudinary://<api_key>:<api_secret>@<cloud_name>
CLOUDINARY_URL=
# optional: comma-separated allowed origins; empty or * = any origin
CORS_ORIGINS=
# optional: number of reverse proxies in front of the app (C9); must equal the real hop count; empty = none trusted
TRUST_PROXY=
```

### 4.2 Logger (`src/core/logger.ts`, `src/middlewares/request-logger.ts`)

```ts
import pino, { type Logger } from 'pino';
import type { Config } from '../config';

export type { Logger };

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-token"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'err.errors.password.value',            // Mongoose ValidationError on User
  'err.errors.password.properties.value',
];

export function createLogger(config: Pick<Config, 'logLevel'>, destination?: pino.DestinationStream): Logger {
  return pino({ level: config.logLevel, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, destination);
}
```

```ts
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';

export const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/; // an inbound id is trusted for correlation only; the charset blocks log injection

/** First middleware: assigns the request id, exposes `req.log`, logs one line per completed request. */
export const requestLogger = (logger: Logger) =>
  pinoHttp({
    logger,
    quietReqLogger: true, // req.log carries only { reqId }, not the whole request, on every legacy log call
    genReqId: (req, res) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customLogLevel: (_req, res) => (res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  });
```

**Request-id propagation:** a valid inbound `x-request-id` is kept, otherwise a UUID v4 is generated. The id is set on `req.id` and echoed as the response `x-request-id` header. It is bound as `reqId` on `req.log` and on the completion line. The completion line also carries the error cause (`err`) whenever the error handler sets `res.err` (§4.3). The redaction list is ADR-011's plus cookies and Mongoose password echoes; request bodies are never logged.

### 4.3 Errors (`src/core/errors`)

```ts
export type ErrorCode = 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_FAILED' | 'INTERNAL';

export interface ValidationIssue { readonly path: string; readonly message: string }

/** An error whose status and message are safe to send to the client. */
export class AppError extends Error {
  readonly details: readonly ValidationIssue[] | undefined;
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    options: { cause?: unknown; details?: readonly ValidationIssue[] } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.details = options.details;
  }
}
export class BadRequestError   extends AppError { constructor(message = 'Invalid request data', cause?: unknown) { super(400, 'BAD_REQUEST', message, { cause }); } }
export class UnauthorizedError extends AppError { constructor(message = 'Unauthorized') { super(401, 'UNAUTHORIZED', message); } }
export class ForbiddenError    extends AppError { constructor(message = 'Forbidden') { super(403, 'FORBIDDEN', message); } }
export class NotFoundError     extends AppError { constructor(message = 'Resource not found') { super(404, 'NOT_FOUND', message); } }
export class ConflictError     extends AppError { constructor(message = 'Resource already exists', cause?: unknown) { super(409, 'CONFLICT', message, { cause }); } }
export class ValidationError   extends AppError { constructor(details: readonly ValidationIssue[], message = 'Validation failed') { super(422, 'VALIDATION_FAILED', message, { details }); } }
export class InternalError     extends AppError { constructor(cause?: unknown) { super(500, 'INTERNAL', 'Internal server error', { cause }); } }

export function toAppError(err: unknown): AppError;
```

| Class | Status | Thrown in M2 by | Thrown from M3 by |
|---|---|---|---|
| `BadRequestError` | 400 | `toAppError` (C1: `ValidationError`/`CastError`) | services (malformed input that passed the DTO) |
| `UnauthorizedError` | 401 | — | `authenticate` middleware (replaces `validarJWT`) |
| `ForbiddenError` | 403 | — | role/ownership checks (C4), `authorize(policy)` in M6 |
| `NotFoundError` | 404 | `notFound` middleware (`'Route not found'`, C2) | services (find-active-or-404) |
| `ConflictError` | 409 | `toAppError` (C1: duplicate key 11000) | services (duplicate name/email) |
| `ValidationError` | 422 | — | `validate(schema)` (zod DTOs, ADR-006) |
| `InternalError` | 500 | `toAppError` fallback | — |

**`toAppError`: how M1 C1 is preserved.** The function is duck-typed, so it works across Mongoose instances and keeps `core/` free of any Mongoose import. It reproduces C1 exactly as T1.3 implemented it, including the HTTP-layer client-error branch from `1d83c87`:

```ts
type ErrorLike = { name?: unknown; code?: unknown; status?: unknown; expose?: unknown };
const asErrorLike = (err: unknown): ErrorLike => (typeof err === 'object' && err !== null ? err : {});

/** A 4xx raised by the HTTP layer: body-parser (http-errors, `expose`) or Express URL decoding (URIError). */
const httpClientStatus = (err: unknown): number | undefined => {
  const { status, expose } = asErrorLike(err);
  const isClientError = typeof status === 'number' && status >= 400 && status < 500;
  return isClientError && (expose === true || err instanceof URIError) ? status : undefined;
};

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const clientStatus = httpClientStatus(err);
  if (clientStatus !== undefined) return new AppError(clientStatus, 'BAD_REQUEST', 'Invalid request data', { cause: err });
  const { code, name } = asErrorLike(err);
  if (code === 11000) return new ConflictError(undefined, err);
  if (name === 'ValidationError' || name === 'CastError') return new BadRequestError(undefined, err);
  return new InternalError(err);
}
```

| Input reaching the error handler | M1 contract | Status | Body (M2, byte-identical to M1) | Log (M2) |
|---|---|---|---|---|
| unmatched route | C2 | 404 | `{"msg":"Route not found"}` | completion line, `warn`, no `err` |
| body-parser error (`expose: true`: malformed JSON 400, JSON > 100 kb 413, bad charset/encoding 415) or `URIError` with status 400 (bad `%` escape in a path param) | C1 (T1.3 client-error branch) | the error's own 4xx | `{"msg":"Invalid request data"}` | `warn` + `err` (replaces T1.3's `console.warn`) |
| `err.code === 11000` (duplicate key) | C1 | 409 | `{"msg":"Resource already exists"}` | `warn` + `err` |
| `err.name` `ValidationError` \| `CastError` | C1 | 400 | `{"msg":"Invalid request data"}` | `warn` + `err` |
| anything else, including non-`Error` throwables | C1 | 500 | `{"msg":"Internal server error"}` | `error` + `err` with stack (replaces `console.error`) |
| an `AppError` thrown by M3 code | — | its status | `{"msg": appError.message}` | `warn` without `err` (4xx), `error` + `err` (5xx) |
| response headers already sent | C1 (T1.3) | — | delegated to Express (socket closed) | `error` + `err` |

```ts
// src/middlewares/error-handler.ts: registered last. Body is `{ msg }` until M3 switches to the envelope (ADR-021).
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const appError = toAppError(err);
  // pino-http writes one line per request on completion; attach the cause unless it is an expected 4xx AppError.
  if (!(err instanceof AppError) || appError.status >= 500) res.err = err instanceof Error ? err : appError;
  if (res.headersSent) { next(err); return; }
  res.status(appError.status).json({ msg: appError.message });
};

// src/middlewares/not-found.ts
export const notFound: RequestHandler = () => { throw new NotFoundError('Route not found'); };
```

Stack traces and raw Mongoose objects are never sent, because the body is only ever `appError.message`, and every non-`AppError` input maps to one of the four fixed messages. The M1 suite's `Object.keys(res.body) == ['msg']` checks keep passing. If T1.5 changes C1 before M1 is accepted, T2.4 updates this table and `toAppError` to match the merged version; the contract is **whatever `m1/stabilization` does**.

One known case: a malformed multipart body. busboy's parse errors (e.g. "Unexpected end of form") carry no `status`, so C1 answers them with 500, and `toAppError` reproduces that. T1.7 raised this as its open Q2, a possible C1 amendment "A2". If the Orchestrator adds A2, T2.4 adds the matching branch to `toAppError` and a row to this table.

### 4.4 Response envelope (`src/core/http/envelope.ts`, consumed from M3)

```ts
export interface DataEnvelope<T> { data: T }
export interface PageMeta { total: number; limit: number; offset: number }
export interface PageEnvelope<T> { data: T[]; meta: PageMeta }
export interface ErrorEnvelope { error: { code: ErrorCode; message: string; details?: readonly ValidationIssue[] } }

export const envelope = <T>(data: T): DataEnvelope<T> => ({ data });
export const pageEnvelope = <T>(data: T[], meta: PageMeta): PageEnvelope<T> => ({ data, meta });
export const errorEnvelope = (err: AppError): ErrorEnvelope => ({
  error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
});
```

These are pure body builders, called as `res.status(201).json(envelope(category))`. M3 uses them in every TS controller. As part of the **3.0.0** contract change (ADR-024) it also replaces `{ msg: appError.message }` with `errorEnvelope(appError)` in the error handler (ADR-021). Pagination parsing is deliberately absent; M3 adds it once duplication is proven (DUP-01).

### 4.5 `createApp(deps)` (`src/app.ts`) and the legacy mount (`src/legacy.ts`)

```ts
export interface AppDeps {
  config: Config;
  logger: Logger;
}
export function createApp(deps: AppDeps): Express;
```

`AppDeps` holds only what M2 consumes. M3 adds the injected clients and models of each TS module as it lands, for example `google: GoogleClient` and `media: MediaClient`. Calling `createApp` performs no I/O: it does not connect to the DB and does not listen (ARC-02). Its only side effect is the first-call `require` of the legacy routers.

**Middleware order.** This matches `models/server.js` after T1.7 exactly, with the request logger added in front:

| # | Middleware | Source | Notes |
|---|---|---|---|
| 0a | `app.set('trust proxy', config.trustProxy)`, only when it is set | T1.7 (C9) | a setting, applied before any middleware so every `req.ip` (logs, the C5 limiter) sees it |
| 0b | `app.disable('x-powered-by')` | T1.3 | |
| 1 | `requestLogger(logger)` | new (ADR-020) | first, so 404s, parse errors and static files are correlated |
| 2 | `helmet(HELMET_OPTIONS)` | T1.3, **moved verbatim** | CSP allows `accounts.google.com/gsi`, Google Fonts; COOP `same-origin-allow-popups`; CORP `cross-origin`; referrer `strict-origin-when-cross-origin` |
| 3 | `cors({ origin: '*' \| [...allowlist] })` | legacy `cors()` + ADR-022 | `'*'` is identical to today's `cors()` |
| 4 | `express.json()` | legacy | 100 kb default, unchanged |
| 5 | `express.static(<root>/public)` | legacy | `path.join(__dirname, '..', 'public')` is correct from both `src/` and `dist/` |
| 6 | `mountLegacyRoutes(app)` | new | `/hello` + 6 routers, each behind `legacyBodyCompat` |
| 7 | `notFound` | C2 | |
| 8 | `errorHandler` | C1 | last |

**No multipart parser in the platform (C10).** Multipart bodies are parsed only by the router-level `fileParser` on the two upload write routes in legacy `routes/uploads.js`, after authentication, authorization and validation. Every other route ignores multipart bodies. That stays so until the M3 media module replaces `routes/uploads.js`. Verified on the amended prototype: T1.7's C10 suite, ported, is green against this `createApp`, including every "other routes ignore multipart" case.

```ts
// src/app.ts (full; HELMET_OPTIONS is the T1.3 object, copied as merged)
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function createApp({ config, logger }: AppDeps): Express {
  const app = express();
  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(requestLogger(logger));
  app.use(helmet(HELMET_OPTIONS));
  app.use(cors({ origin: config.cors.origins === '*' ? '*' : [...config.cors.origins] }));
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  mountLegacyRoutes(app);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
```

```ts
// src/legacy.ts: the only TS→JS seam (ADR-017). An entry is removed when its M3 module lands; the file is deleted with the last one.
import type { Express, RequestHandler, Router } from 'express';

// Legacy JS is loaded with Node's own require: one module instance shared by app, tests and every transform.
const LEGACY_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['/api/user', '../routes/usuarios'],
  ['/api/auth', '../routes/auth'],
  ['/api/category', '../routes/category'],
  ['/api/product', '../routes/products'],
  ['/api/search', '../routes/search'],
  ['/api/uploads', '../routes/uploads'],
];

// Express 5 leaves req.body undefined when no parser ran; legacy handlers were written against Express 4's `{}`.
const legacyBodyCompat: RequestHandler = (req, _res, next) => {
  req.body ??= {};
  next();
};

export function mountLegacyRoutes(app: Express): void {
  app.get('/hello', (_req, res) => {  // debug route kept for parity; removed in M3 (CQ-02)
    res.status(200).json({ name: 'caan' });
  });
  for (const [path, file] of LEGACY_ROUTES) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const router = require(file) as Router;
    app.use(path, legacyBodyCompat, router);
  }
}
```

The routers are required lazily (inside `createApp`), not at module load. That is what lets a test install its stubs before any legacy file destructures a dependency. **ARC-03 is resolved** by removing `Server` from `models/index.js`: with `models/server.js` gone, the cycle `models/index → models/server → routes → … → helpers/db-validators → models/index` no longer exists, and every legacy module can be the entry point.

### 4.6 Boot and shutdown (`src/server.ts`)

```ts
const SHUTDOWN_TIMEOUT_MS = 10_000;

function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (error) => (error ? reject(error) : resolve(server))); // Express 5 passes listen errors here
  });
}

function onShutdownSignal(server: Server, logger: Logger): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => { logger.fatal('graceful shutdown timed out'); process.exit(1); }, SHUTDOWN_TIMEOUT_MS).unref();
    // Stops accepting connections, closes idle keep-alive sockets, waits for in-flight requests.
    server.close((closeError) => {
      disconnectDatabase().then(
        () => process.exit(closeError ? 1 : 0),
        (dbError: unknown) => { logger.error({ err: dbError }, 'failed to close the database connection'); process.exit(1); },
      );
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function main(): Promise<void> {
  const config = loadConfig();                         // 1. fail fast on invalid env (exit 1)
  const logger = createLogger(config);                 // 2.
  const crash = (kind: string) => (reason: unknown) => { logger.fatal({ err: reason }, kind); process.exit(1); };
  process.on('unhandledRejection', crash('unhandled rejection'));
  process.on('uncaughtException', crash('uncaught exception'));
  if (config.env === 'production' && config.cors.origins === '*') logger.warn('CORS_ORIGINS is not set: every origin may call this API');
  await connectDatabase(config.mongoUri);              // 3. DB before traffic (C3 / REL-03)
  logger.info('database connected');
  const server = await listen(createApp({ config, logger }), config.port); // 4.
  logger.info({ port: config.port }, 'server listening');
  onShutdownSignal(server, logger);                    // 5.
}

main().catch((error: unknown) => {
  // Boot failed, possibly before the logger existed (invalid config): plain stderr, non-zero exit.
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
```

| Situation | Behaviour (verified) | Exit |
|---|---|---|
| invalid or missing env | `ConfigError` listing every variable on stderr; no socket, no DB | 1 |
| DB unreachable | `MongooseServerSelectionError` after `serverSelectionTimeoutMS` (10 s) | 1 |
| port in use | `listen` rejects (`EADDRINUSE`) | 1 |
| `SIGTERM` / `SIGINT` | stop accepting, drain in-flight, `mongoose.disconnect()` | 0 (1 on close error) |
| drain exceeds 10 s | `fatal` log | 1 |
| unhandled rejection / uncaught exception | `fatal` log with `err` | 1 |

`/health` and `/ready` remain M9 deliverables.

### 4.7 Database connection (`src/database/connection.ts`)

```ts
import mongoose from 'mongoose';

// SEC-14. Global for every model, legacy included. Both options exist unchanged in Mongoose 7 and 9 (verified).
mongoose.set('strictQuery', true);     // unknown filter paths are stripped (was false)
mongoose.set('sanitizeFilter', true);  // `$`-operator objects in filter values are wrapped in $eq → CastError

export async function connectDatabase(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
```

Verified effects: `User.findOne({ email: { $ne: null } })` now rejects with `CastError`, which C1 maps to 400, instead of matching any user. The legacy search filters (`{ $or: [{ name: regex }], $and: [{ state: true }] }`) are unaffected, because top-level `$or`/`$and` are walked and `RegExp` values are kept. No legacy filter uses a path outside its schema, so `strictQuery` changes no result. `mongoose.trusted()` is the escape hatch should an M3 service ever need an operator from input; it is not needed today.

### 4.8 Legacy transition contract

**Config (ADR-019).** Legacy JS keeps reading from `process.env` only variables validated at boot:
- `SECRET_KEY`: `helpers/generar-jwt.js:10`, `middlewares/validar-jwt.js:18`.
- `GOOGLE_CLIENT_ID`: `helpers/google-verify.js:3,9`.
- `CLOUDINARY_URL` stays on the allowlist, but after T1.2 only the Cloudinary SDK reads it. `controllers/uploads.js:4-5` is now `cloudinary.config({ secure: true })`.

Any other `process.env` read in legacy JS is a lint error. `PORT` and T1.7's `TRUST_PROXY` are read only in `models/server.js`, which T2.5 deletes before it enables the rule. Each remaining read disappears when M3 replaces its file with a module that takes `config` by injection.

**Logger (ADR-020).** The pattern for each case is below. `no-console` in the legacy lint block is the acceptance criterion.

| Where | Replacement |
|---|---|
| request handler or middleware with `req` in scope | `req.log.<level>({ err }, '<what happened>')` |
| helper without `req` that **reports its own failure** (e.g. temp-file cleanup) | pass `req` in and use `req.log.warn`. Such a failure isn't propagated to the error handler, so dropping the log would hide it silently |
| helper without `req` whose failure **propagates** | no log. Reject or throw the **original** error; the platform error handler logs it with the request id |
| an error that is then passed to `next(err)` | no log (the error handler logs it) |

**Ledger of legacy lines deleted or replaced in M2.** Re-derived against the merged `m1/stabilization` @ `a29c539` (T1.1–T1.4). T1.7's sites (`7a932d5`, done but not yet merged) are given *(T1.7)* and covered by rule. T2.2 onward start only after T1.7 is merged forward (§7.3). T2.5 re-verifies the whole ledger by grep on that code; the acceptance gate is `grep -rn "console\." routes controllers middlewares helpers models` → empty and `pnpm lint` green.

| File / site | Change | Task | Why |
|---|---|---|---|
| `app.js` (whole file; `console.error` at `:14`) | **delete** | T2.5 | Entry is `src/server.ts`. `require('dotenv').config()` → `--env-file-if-exists`; `await connection()` → `connectDatabase(config.mongoUri)`; `new Server().listen()` → `createApp` + `listen`; `main().catch(console.error + exit 1)` → the same in `server.ts` |
| `models/server.js` (whole file) | **delete** | T2.5 | ARC-02; its parts go to: |
| ↳ `this.port = process.env.PORT \|\| 1500` (`:18`) | → `config.port` | T2.5 | |
| ↳ `TRUST_PROXY` parse *(T1.7 `:38-46`)* | → `envSchema.TRUST_PROXY` + `app.set('trust proxy', config.trustProxy)` in `createApp` (§4.1, §4.5 row 0a) | T2.5 | C9 |
| ↳ `paths` map (incl. the `categoty` key) | → `LEGACY_ROUTES` | T2.5 | |
| ↳ helmet, cors, json, static | → `createApp`, same options | T2.5 | |
| ↳ global `fileUpload` (`:68-74`) | **not moved.** T1.7 removes it (C10); multipart stays router-level in legacy | T1.7 | C10 |
| ↳ `GET /hello` | → `mountLegacyRoutes` | T2.5 | |
| ↳ 404 handler | → `notFound` | T2.5 | |
| ↳ error middleware, incl. `console.warn` (`:106`) / `console.error` (`:112`) | → `errorHandler` + `toAppError`; logging moves to the pino-http completion line | T2.5 | |
| ↳ `listen()` + `console.log` (`:137-138`) | → `server.ts` | T2.5 | |
| `models/index.js:7` `const Server = require('./server');` and `:15` `Server` | **delete** (and the trailing comma on `Product,`) | T2.5 | ARC-03 |
| `database/config.js` (whole file) | **delete** | T2.5 | `mongoose.set("strictQuery", false)` → `true` + `sanitizeFilter` (SEC-14); `connect(process.env.MONGO_CLOUD)` → `connectDatabase(config.mongoUri)` |
| `middlewares/validar-jwt.js:41` `console.log(error);` | → `req.log.debug({ err: error }, 'token rejected');` | T2.5 | LOG-01 (a full stack on every invalid token) |
| `helpers/generar-jwt.js:14-15` `console.log(err); reject( 'I cannot generate the token' )` | → `reject( err )` | T2.5 | LOG-01. No client-visible change: every caller answers a rejection with a fixed message |
| Temp-file cleanup failure log: `controllers/uploads.js:17` `removeTempFiles` → *(T1.7)* `middlewares/file-valid.js:30` `fs.rm(tempFileDir, …, err => err && console.error(err))` | → `err => err && req.log.warn({ err, tempFileDir }, 'upload temp folder not removed')`. `req` is in scope in T1.7's `fileParser`; if the merged code moves cleanup into a helper, pass `req` in (rule above) | T2.5 | LOG-01; a silent cleanup failure is an SEC-08 leak |
| Previous-asset `destroy` failure: `controllers/uploads.js:173` `console.error(error)` → *(T1.7 `:126`, after the C11 reorder)* | → `req.log.warn({ err: error }, 'previous Cloudinary asset not destroyed')` | T2.5 | LOG-01; C11 "best-effort, logged" |
| Orphaned-asset notice *(T1.7 `controllers/uploads.js:113`)* `` console.error(`Orphaned Cloudinary asset ${ secure_url }: …`) `` | → `req.log.error({ asset: secure_url, collection, id }, 'orphaned Cloudinary asset: the record was not saved')`. The record must keep the asset URL: the ported C11 test asserts it (§5.3) | T2.5 | LOG-01; C11 "accepted and logged" |
| `controllers/uploads.js:130` `res.sendFile(pathImage)` and `:135` `res.sendFile(pathImageNotFound)` *(T1.7 `:69`, `:74`)* | → `res.sendFile(<file name>, { root: <its directory> })` | **T2.2** | Express 5 dotfiles regression (Appendix A, item 13) |
| `controllers/category.js:76,87`, `controllers/product.js:83,95`, `controllers/usuarios.js:60` `{new: true}` (T1.7 leaves them) | → `{ returnDocument: 'after' }` | **T2.3** | Mongoose 9 deprecation (Appendix B) |
| `models/server.js` `listen()` callback, `:137` *(T1.7 `:138`)*, during T2.2 only | `(error) => { if (error) throw error; … }` | **T2.2** | Express 5 passes `EADDRINUSE` to the callback instead of throwing (Appendix A, item 16); the file is deleted in T2.5 |
| `models/server.js`, during T2.2 only | add `this.app.use((req, res, next) => { req.body ??= {}; next(); })` **right after `express.static`** (T1.7 `:73`; there is no global `fileUpload` left to follow) | **T2.2** | Express 5 `req.body` (Appendix A, item 18); T2.5 moves it into `src/legacy.ts` |

**Checked and deliberately unchanged:**
- `controllers/auth.js`: no `console` left after T1.2, whose catch forwards `next(error)`.
- `routes/uploads.js`, and `fileParser`/`fileValid` in `middlewares/file-valid.js` *(T1.7)*: C10's router-level parser and its 5 MB literal stay until the M3 media module.
- `controllers/uploads.js:4-5` `cloudinary.config({ secure: true })`.

AM-1d is verified: with the shim placed ahead of the routers and T1.7's `fileParser` on the route, a file-only multipart upload reaches the controller with `req.body` = `{}` (a plain object). A file plus fields gives `{ field: value }`, and a bodiless request still reaches `fileValid`'s 400. Nothing else in `routes/`, `controllers/`, `middlewares/`, `helpers/` or `models/` changes in M2.

---

## 5. Test harness

### 5.1 Lifecycle

```
vitest run
 └─ globalSetup (main process, once)       MongoMemoryServer.create() → provide('mongoUri') ── teardown: mongod.stop()
     └─ per test file (own child process, pool=forks, isolate=true, files in parallel)
         beforeAll   app = await startTestApp(overrides?) → loadConfig({…process.env, MONGO_CLOUD: <this file's DB>, …overrides})
                                                     → connectDatabase() on first use → createApp({ config, logger → memory })
         beforeEach  await clearDatabase()           → deleteMany on every collection of this file's DB
                     stubs: stubCloudinary(), stubGoogleVerify()   (restored after each test: restoreMocks)
         test        await request(app).…            (supertest, no port bound)
         afterAll    await stopTestApp()             → dropDatabase() + disconnect()
```

```ts
// tests/setup/global-setup.ts
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext { mongoUri: string }
}

export default async function setup(project: TestProject) {
  const mongod = await MongoMemoryServer.create();
  project.provide('mongoUri', mongod.getUri());
  return async () => { await mongod.stop(); };
}
```

```ts
// tests/helpers/app.ts: contract P6 (§7.2)
// One database per test file (each file runs in its own process), shared by every app the file builds.
const DATABASE_URI = `${inject('mongoUri')}test-${randomUUID()}`;
const logLines: string[] = [];

/**
 * Builds the app from `process.env` merged with `overrides` (C9 tests pass e.g. `{ TRUST_PROXY: '1' }`).
 * Rejects with ConfigError when the merged env is invalid. Connects the file's database on first use.
 */
export async function startTestApp(overrides: NodeJS.ProcessEnv = {}): Promise<Express> {
  const config = loadConfig({ ...process.env, MONGO_CLOUD: DATABASE_URI, ...overrides });
  if (mongoose.connection.readyState === mongoose.ConnectionStates.disconnected) await connectDatabase(config.mongoUri);
  return createApp({ config, logger: createLogger(config, { write: (line: string) => logLines.push(line) }) });
}

export async function stopTestApp(): Promise<void> {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
}

export async function clearDatabase(): Promise<void> {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
}

/** Everything the app logged since the last clearLogs(); tests log nothing unless they pass a LOG_LEVEL override. */
export const loggedText = (): string => logLines.join('');
export const clearLogs = (): void => {
  logLines.length = 0;
};
```

- **`startTestApp` can be called several times in one file**, as the C9 tests do, one app per `TRUST_PROXY` value. Every call shares the file's database connection. It rejects before any I/O when the merged env is invalid.
- **Logs go to memory, never to stdout.** They stay empty at the test default level (`silent`). A file that asserts on a log line starts its app with a `LOG_LEVEL` override and reads `loggedText()` (§5.3).
- **One database per file is kept from M1:** T1.4's harness already derived a database name per test file, and this harness keeps that.
- The first `mongodb-memory-server` run downloads `mongod` 8.2.x once (cached in `~/.cache/mongodb-binaries`).

### 5.2 Stubbing legacy dependencies (ADR-023)

Verified: `vi.mock('cloudinary')` and `vi.mock('../../helpers/google-verify')` in a test file do **not** reach `controllers/uploads.js` or `controllers/auth.js`. The real SDK ran (500) and the real verifier ran (400). The ban on `vi.mock` is therefore a correctness rule, not a style preference. Stubs replace methods **on the shared CommonJS instance**, at call time, so load order does not matter:

```ts
// tests/helpers/legacy.ts: contract P7. The one test seam into legacy CommonJS; deleted with the last legacy module (M3).
/* eslint-disable @typescript-eslint/no-require-imports */
type LegacyModel = Model<any>; // legacy schemas are untyped JS
/** A document of a legacy model: untyped JS, so every field is `any` until M3 (factories return it). */
export type LegacyDoc = ReturnType<LegacyModel['hydrate']>;

export const legacyModels = () =>
  require('../../models') as { User: LegacyModel; Role: LegacyModel; Category: LegacyModel; Product: LegacyModel };
export const { generarJWT } = require('../../helpers/generar-jwt') as { generarJWT: (uid: string) => Promise<string> };

const cloudinary = (require('cloudinary') as { v2: typeof v2 }).v2;
const { OAuth2Client: GoogleClient } = require('google-auth-library') as { OAuth2Client: typeof OAuth2Client };

export interface GooglePayload { name?: string; email?: string; picture?: string }
type VerifyIdToken = (options: { idToken: string; audience?: string }) => Promise<{ getPayload: () => GooglePayload | undefined }>;

/** Replaces Google ID-token verification for the current test (undone by restoreMocks). */
export const stubGoogleVerify = () =>
  vi.spyOn(GoogleClient.prototype, 'verifyIdToken') as unknown as MockInstance<VerifyIdToken>;
export const googleTicket = (payload: GooglePayload) => ({ getPayload: () => payload });

/** Replaces the Cloudinary uploader for the current test (undone by restoreMocks). */
export const stubCloudinary = () => ({
  upload: vi.spyOn(cloudinary.uploader, 'upload') as unknown as MockInstance<(file: string) => Promise<{ secure_url: string }>>,
  destroy: vi.spyOn(cloudinary.uploader, 'destroy') as unknown as MockInstance<(publicId: string) => Promise<{ result: string }>>,
});
```

Google is stubbed one level below the M1 mock, at `OAuth2Client.prototype.verifyIdToken`. The reason is that `controllers/auth.js` destructures `googleVerify` at load time, so a stub on the helper module would depend on load order. The prototype verified all three behaviours: the stub reaches the app, a stubbed Google sign-in answers 200, and the stub is gone in the next test (the real verifier rejects the fake token: 401 since T1.2's C5).

Mongoose models can also be reached by name (`mongoose.model('Category')`) once `createApp` has run; platform tests (T2.5) use that and do not depend on T2.6's helper.

### 5.3 Porting the M1 suite (mechanical Jest → Vitest mapping)

| Jest (M1 `e2e/`) | Vitest (M2 `tests/`) |
|---|---|
| `e2e/<name>.e2e.js` | `tests/integration/security/<name>.test.ts`, with the same `describe`/`test` titles in the same order |
| `require('../models/server')` (ARC-03 guard) | delete |
| `const x = require('y')` | `import x from 'y'` / named import |
| globals `describe`, `test`, `it`, `expect`, `beforeAll`, `afterAll`, `beforeEach`, `afterEach` | `import { … } from 'vitest'` (globals stay off) |
| `jest.fn()` / `jest.spyOn(o, 'm')` | `vi.fn()` / `vi.spyOn(o, 'm')`, where `o` comes from `legacyModels()` if it is a model |
| `jest.clearAllMocks()` in `beforeEach` | delete (`restoreMocks: true`; stubs are created per test) |
| `jest.restoreAllMocks()` in `afterEach` | delete (`restoreMocks: true`); delete an `afterEach` left empty |
| `jest.spyOn(fs, 'createWriteStream')` … `fs.createWriteStream.mock.calls` | `import fs from 'node:fs'`; `vi.spyOn(fs, 'createWriteStream')` … `vi.mocked(fs.createWriteStream).mock.calls` (the default import is the CommonJS `fs` object express-fileupload uses; verified) |
| `jest.spyOn(console, 'error').mockImplementation(() => {})` used **only to silence** output | delete (the app logs through pino, silent in tests) |
| `jest.mock('../helpers/google-verify', …)` + `const { googleVerify } = require('../helpers/google-verify')` | delete both; `const googleVerify = stubGoogleVerify()` in `beforeEach` (typed `let googleVerify: ReturnType<typeof stubGoogleVerify>`) |
| `googleVerify.mockResolvedValue(p)` | `googleVerify.mockResolvedValue(googleTicket(p))` |
| `googleVerify.mockRejectedValue(e)` | unchanged |
| `expect(googleVerify).toHaveBeenCalledWith(tok)` | `expect(googleVerify).toHaveBeenCalledWith(expect.objectContaining({ idToken: tok }))` |
| `jest.mock('cloudinary', …)` + `const cloudinary = require('cloudinary').v2` | delete both; `({ upload, destroy } = stubCloudinary())` in `beforeEach` |
| `cloudinary.uploader.upload.mockReset(); cloudinary.uploader.upload.mockResolvedValue(x)` | `upload.mockResolvedValue(x)` (same for `destroy`) |
| `expect(cloudinary.uploader.upload)…` | `expect(upload)…` |
| `let app;` | `let app: Express;` (annotate only what `strict` requires) |
| `await connectDatabase(); app = buildApp();` | `app = await startTestApp();` |
| `await mongoose.connection.close();` | `await stopTestApp();` |
| `require('./helpers/db')` exports | see the helper table below |
| `jest-e2e.json` (`globalSetup`, `globalTeardown`, `testTimeout`) | `vitest.config.mts` + `tests/setup/global-setup.ts` |
| `mockImplementationOnce`, `mockRestore`, `toHaveBeenCalled*`, `expect.*`, `test.each` | unchanged (same API) |
| `%p` in a `test.each` title | `%j`. Vitest has no `%p`, and `%j` renders a string as `"abc"`, like Jest's `%p` (verified). `%s`, `%i` and `%d` are unchanged |
| **Strict typing:** untyped parameters, `let` declarations, `test.each` tables | annotate only what `strict` rejects: parameter and `let` types, a tuple type on the `test.each` table (e.g. `Array<[string, number, () => Promise<[method: 'post' \| 'put', url: string, token?: string]>]>`), `import request, { type Test } from 'supertest'` for helpers that take a request, and `!` on an index access that `noUncheckedIndexedAccess` flags inside an assertion (`mock.invocationCallOrder[0]!`) |
| **[non-mechanical A]** `process.env.X = v` (or `delete process.env.X`), then `new Server().app`; the saved and restored `process.env.X` in `afterEach` | `await startTestApp({ X: v })` (or `{ X: undefined }`); delete the save/restore. A synchronous test that now awaits becomes `async`. Add `afterAll(stopTestApp)` if the file had no `afterAll` |
| **[non-mechanical A]** `expect(() => new Server()).toThrow(re)` | `await expect(startTestApp({ X: v })).rejects.toThrow(ConfigError)`, plus `await expect(startTestApp({ X: v })).rejects.toThrow(/X/)` **only if** `re` names the variable (`ConfigError` messages name it: `→ at X`) |
| **[non-mechanical B]** `expect(console.error).toHaveBeenCalledWith(expect.stringContaining(s))` for a legacy log that T2.5 moves to `req.log` (§4.8) | the file starts its app with `startTestApp({ LOG_LEVEL: 'warn' })`; its silencing `jest.spyOn(console, 'error')…` becomes `clearLogs()`; the assertion becomes `expect(loggedText()).toContain(s)` |

**Non-mechanical rows.** Rows A and B are the only ones that change a test's code rather than its syntax. T2.6 lists every use of either in its report (file, test title, before → after).
- **Row A** comes from T1.7's C9 tests, which build one app per `TRUST_PROXY` value through `process.env`.
- **Row B** is forced by T2.5's move of the C11 orphan notice from `console.error` to `req.log.error`; T1.7's `image-replacement` test asserts on that notice.

The helper table below covers **every export of `e2e/helpers/db.js` at the merge base**, i.e. the commit T2.6 branches from. That includes whatever T1.7 changed, notably `listTempFiles` now also reporting this process's `upload-<pid>-*` folders.

| `e2e/helpers/db.js` export | New home |
|---|---|
| `connectDatabase` + `buildApp` | `startTestApp(overrides?)` in `tests/helpers/app.ts` (T2.5) |
| `clearDatabase` | `tests/helpers/app.ts` (T2.5) |
| `BCRYPT_ROUNDS`, `TEST_PASSWORD`, `hashPassword`, `uniqueSuffix`, `createUser`, `createAdmin`, `seedRoles`, `createCategory`, `createProduct`, `tokenFor`, `authHeader`, `reload` | `tests/helpers/factories.ts` (T2.6, same signatures and defaults) |
| `User`, `Role`, `Category`, `Product` | `legacyModels()` in `tests/helpers/legacy.ts` (T2.6) |
| `listTempFiles` (incl. `upload-<pid>-*` folders), `newTempFiles`, `waitForNoTempLeak`, `resetUploadDirs`, `UPLOAD_DIR` | `tests/helpers/uploads.ts` (T2.6; uploads dir = `path.join(__dirname, '..', '..', 'uploads')`) |
| anything else exported at the merge base | same name and behaviour, in the module its concern belongs to; list it in the report |
| `e2e/setup/globalSetup.js` / `globalTeardown.js` | `tests/setup/global-setup.ts` (T2.1) |

**Worked example (validated).** The head of `reliability.e2e.js`, ported. The rest of the file changed only in `jest.` → `vi.`, and the port ran green 13/13 against the prototype platform with T1.3's legacy code:

```diff
-// ARC-03: load models/server before any other application module.
-require('../models/server');
-const request = require('supertest');
-const mongoose = require('mongoose');
-const { connectDatabase, buildApp, clearDatabase, createUser, createCategory, createProduct,
-        tokenFor, authHeader, Category, Product } = require('./helpers/db');
+import type { Express } from 'express';
+import mongoose from 'mongoose';
+import request from 'supertest';
+import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
+import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
+import { authHeader, createCategory, createUser, tokenFor } from '../../helpers/factories';
+import { legacyModels } from '../../helpers/legacy';
+
+const { Category, Product } = legacyModels();

 describe('crash safety and HTTP error handling', () => {
-  let app;
-  let admin;
-  let adminToken;
+  let app: Express;
+  let admin: Awaited<ReturnType<typeof createUser>>;
+  let adminToken: string;

   beforeAll(async () => {
-    await connectDatabase();
-    app = buildApp();
+    app = await startTestApp();
     await Category.init();
     await Product.init();
   });

   afterAll(async () => {
-    await mongoose.connection.close();
+    await stopTestApp();
   });
…
-      const spy = jest.spyOn(Category, 'find').mockImplementationOnce(() => {
+      const spy = vi.spyOn(Category, 'find').mockImplementationOnce(() => {
```

**Worked example for the non-mechanical rows (validated).** From T1.7's `trust-proxy.e2e.js` (row A) and `image-replacement.e2e.js` (row B). Both ports ran green against the amended prototype, along with the mechanical port of `multipart-scope.e2e.js`. The three T1.7 files have 7 + 7 + 15 titles, all identical to the originals:

```diff
-  const original = process.env.TRUST_PROXY;
-  const buildWith = (value) => {
-    if (value === undefined) { delete process.env.TRUST_PROXY; } else { process.env.TRUST_PROXY = value; }
-    return new Server().app;
-  };
-  afterEach(() => { /* restore process.env.TRUST_PROXY */ });
+  const buildWith = (value?: string) => startTestApp({ TRUST_PROXY: value });   // [A]
+  afterAll(stopTestApp);                                                         // [A] added
…
-    test('a non-negative integer becomes the trusted hop count', () => {
-      expect(buildWith('0').get('trust proxy')).toBe(0);
+    test('a non-negative integer becomes the trusted hop count', async () => {
+      expect((await buildWith('0')).get('trust proxy')).toBe(0);
…
-      'TRUST_PROXY=%p makes new Server() throw',
-      (value) => {
-        expect(() => buildWith(value)).toThrow(/TRUST_PROXY must be a non-negative integer/);
+      'TRUST_PROXY=%j makes new Server() throw',
+      async (value) => {
+        await expect(buildWith(value)).rejects.toThrow(ConfigError);              // [A]
+        await expect(buildWith(value)).rejects.toThrow(/TRUST_PROXY/);           // [A] the regex named the variable
```

```diff
   beforeAll(async () => {
-    await connectDatabase();
-    app = buildApp();
+    app = await startTestApp({ LOG_LEVEL: 'warn' });                            // [B]
   });
   beforeEach(async () => {
…
-    jest.spyOn(console, 'error').mockImplementation(() => {});
+    clearLogs();                                                                 // [B]
   });
…
-    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(NEW_URL));
+    expect(loggedText()).toContain(NEW_URL);                                     // [B]
```

**1:1 proof** (T2.6 deliverable): the sorted list of `describe`/`test`/`it` titles, including `test.each` titles, extracted from `e2e/*.e2e.js` at the merge base equals the list extracted from `tests/integration/security/*.test.ts`. The base side maps `%p` to `%j` first (row above). The extractor uses `perl` because the macOS `grep` here is ugrep, which has no back-references. Results on the validated ports: reliability 18, trust-proxy 7, image-replacement 7 and multipart-scope 15 titles, all identical.

```sh
BASE=$(git merge-base HEAD m2/foundation)   # the integration commit this branch started from
titles() { perl -ne 'print "$2\n" if /^\s*(?:describe|test|it)(?:\.each\([^)]*\))?\((["\x27`])(.*?)\1\s*,/' | sort; }
diff <(git ls-tree -r --name-only "$BASE" e2e/ | grep '\.e2e\.js$' | while read -r f; do git show "$BASE:$f"; done | sed 's/%p/%j/g' | titles) \
     <(cat tests/integration/security/*.test.ts | titles) && echo IDENTICAL
```

Multi-line `test.each(`…`)(` titles, where the title sits on the next line, aren't matched on either side, so they cancel out. T2.6 checks those by eye and lists them.

### 5.4 New tests added in M2

| File | Task | Covers |
|---|---|---|
| `tests/unit/config.test.ts` | T2.4 | defaults (port 1500, level `info`/`silent`, CORS `*`, `trustProxy` undefined); `TRUST_PROXY` unset → `undefined`, `'0'` → `0`, `'2'` → `2`, and `'abc'`, `'-1'`, `'true'` → `ConfigError` whose message names `TRUST_PROXY`; each required variable missing → `ConfigError` naming it; all four missing → one error listing all four; empty string = unset; bad `PORT`/`LOG_LEVEL`/`MONGO_CLOUD`/`CLOUDINARY_URL` rejected; `CORS_ORIGINS=' a , b '` → `['a','b']`; list containing `*` → `'*'`; result is frozen |
| `tests/unit/errors.test.ts` | T2.4 | table-driven `toAppError`: `AppError` passthrough; `{code:11000}` and a real `MongoServerError` → 409; real Mongoose `ValidationError`/`CastError` → 400; body-parser-shaped `{status:400,expose:true}` → 400, `{status:413,expose:true}` → 413; `URIError` with `status:400` → 400; `{status:404}` without `expose` → 500; `{status:500,expose:true}` → 500; thrown string → 500; message always one of the fixed strings; each subclass status/code/default message; `name` equals class name |
| `tests/unit/envelope.test.ts` | T2.4 | the three builders; `details` omitted when absent |
| `tests/unit/logger.test.ts` | T2.4 | writing through a destination stream: every `REDACT_PATHS` entry is `[REDACTED]`, non-sensitive fields untouched, level honoured |
| `tests/integration/platform/app.test.ts` | T2.5 | C2 404 body; C1 table (409 via duplicate category, 400 via cast, 400 malformed JSON, 413 JSON > 100 kb, 400 `%E0%A4%A` in a path param, 500 via `vi.spyOn(mongoose.model('Category'), 'find')` with a log line at `error` carrying `reqId` and `err`, captured by a logger on a memory stream); `x-request-id` echoed when valid, generated UUID when absent or invalid; no `x-powered-by`; CSP contains the T1.3 Google/Fonts sources; CORS `*` by default, allowlisted origin echoed, other origins get no `access-control-allow-origin`; `GET /hello`; `GET /` serves `index.html`; a legacy request without a body sees `req.body` as `{}` (Express 4 parity); a multipart body sent to a non-upload route is ignored (C10: no platform parser) |
| `tests/integration/platform/trust-proxy.test.ts` | T2.5 | `createApp` applies `config.trustProxy` (C9), observed through `req.ip` as the C5 limiter key (draft-7 `RateLimit: …remaining=n`). With `{ TRUST_PROXY: '1' }`: `app.get('trust proxy') === 1`, two `X-Forwarded-For` addresses each start at `remaining=9`, and a repeat address drops to `8`. Unset: `false`, and two different `X-Forwarded-For` values share one budget (`9`, then `8`). A dedicated file, so the per-process limiter starts fresh (verified green) |
| `tests/integration/platform/database.test.ts` | T2.5 | `mongoose.get('strictQuery') === true`, `mongoose.get('sanitizeFilter') === true`; an operator object in a filter rejects with `CastError` |
| `tests/integration/platform/server.test.ts` | T2.5 | spawns `node --import tsx src/server.ts`: invalid env → exit 1 with `Invalid environment` on stderr, no listen; valid env → `server listening`, a request succeeds, `SIGTERM` → exit 0 within 10 s |

### 5.5 Coverage

V8 coverage measures `src/**` **and** the natively-loaded legacy JS (verified), so M2 reports the regression suite's reach into legacy code. Thresholds gate only `src/**/*.ts` (lines 90, functions 90, branches 80, statements 90). `src/server.ts` is excluded because it runs in a spawned process. Legacy coverage is reported and not gated. M7 introduces the global ≥ 80% gate once legacy code is gone.

---

## 6. CI (`.github/workflows/ci.yml`)

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    name: Format, lint, typecheck, build, test, audit
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
      # Third-party action pinned by commit (v6.1.0); pnpm version comes from package.json#packageManager.
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413
        with:
          cache: true
      - name: Cache the mongod binary used by mongodb-memory-server
        uses: actions/cache@v6
        with:
          path: ~/.cache/mongodb-binaries
          key: mongod-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: mongod-${{ runner.os }}-
      - run: pnpm install --frozen-lockfile
      - run: pnpm format:check
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test:coverage
      - run: pnpm audit --prod
```

Setup-node runs before pnpm/action-setup so that pnpm 12 runs on Node 24, not on the runner's default Node. `pnpm build` is in the gate because it is the only check for ADR-017 rule 7 (TS importing legacy JS). Vitest emits GitHub annotations automatically under `GITHUB_ACTIONS`. `pnpm audit --prod` fails on any advisory level; the baseline is 0, so any new advisory forces triage. M10 extends this workflow (CodeQL, dependency review, Renovate, image build).

---

## 7. Task breakdown

### 7.1 Ground rules (M1 rules 1–7 apply, with these changes)

1. **Strangler (ADR-016).** Legacy JS behaviour must not change. The only legacy edits allowed are the ledger rows in §4.8 assigned to your task.
2. **Touch only your Files Allowed.** A needed change elsewhere goes under **Questions**, unmade.
3. **Dependencies:** only T2.1 adds or removes packages. T2.2 and T2.3 each bump exactly one package; T2.5 removes `jest`, `nodemon` and `dotenv`. Use the exact versions from §3.1.
4. **Conventional commits**, one per logical change, with debt IDs in the body. The commits listed per task are the **revert units** (§8.1). Don't squash them.
5. **Gates before hand-in:** the gates available on your branch are `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test`. Until T2.5/T2.6 merge, the legacy gate is `pnpm e2e` (the Jest M1 suite), which must stay green.
6. **New TS code:** Prettier config, English identifiers and messages, comments only for a non-obvious *why*, and no `any` outside `tests/helpers/legacy.ts`. Implement the contracts in §4 as written; a contract change goes under **Questions**, unmade.
7. **Local runtime:** no Docker; use `mongodb-memory-server`. Never commit a `.env`.
8. **Return format:** as in M1 (Summary · Files changed with `git diff --stat` · Decisions made · Risks · Questions · Acceptance checklist with the command proving each item).

### 7.2 Shared contracts (binding across M2 tasks, in addition to M1 C1–C11)

| ID | Contract | Owner | Consumers |
|---|---|---|---|
| P1 | `loadConfig(source?: NodeJS.ProcessEnv): Config`, `Config` (incl. `trustProxy: number \| undefined`, C9), `ConfigError`, `envSchema` exactly as §4.1 | T2.4 | T2.5, T2.6 (via P6) |
| P2 | `createLogger(config: Pick<Config,'logLevel'>, destination?): Logger`, `REDACT_PATHS`, `type Logger` as §4.2 | T2.4 | T2.5 |
| P3 | `AppError` + 7 subclasses and `toAppError(err): AppError` as §4.3 (C1 reproduced byte-for-byte) | T2.4 | T2.5; M3 |
| P4 | `envelope`, `pageEnvelope`, `errorEnvelope` and their types as §4.4 | T2.4 | M3 |
| P5 | `createApp(deps: AppDeps): Express` with `AppDeps = { config; logger }`, middleware order and legacy mount as §4.5; `connectDatabase(uri)`, `disconnectDatabase()` as §4.7 | T2.5 | T2.6 (via P6) |
| P6 | Test harness: `inject('mongoUri')` from `tests/setup/global-setup.ts` (T2.1); in `tests/helpers/app.ts` (T2.5): `startTestApp(overrides?: NodeJS.ProcessEnv): Promise<Express>` (merges `overrides` into the env given to `loadConfig`; rejects with `ConfigError`; callable many times per file, one DB connection), `stopTestApp(): Promise<void>`, `clearDatabase(): Promise<void>`, `loggedText(): string`, `clearLogs(): void` | T2.1, T2.5 | T2.6, T2.4 (runner only) |
| P7 | Legacy test seam `tests/helpers/legacy.ts` as §5.2 (`legacyModels`, `LegacyDoc`, `generarJWT`, `stubGoogleVerify`, `googleTicket`, `stubCloudinary`) | T2.6 | M3 tests |
| P8 | Script names (§3.2) and the lint rule set (§3.5) | T2.1 | every task, T2.7 |

### 7.3 Execution plan

```
m1/stabilization @ a29c539 ──► m2/foundation (integration, cut BEFORE M1 was accepted)
   │                              ▲
   │   M1 finishes in parallel:   │ forward merge of m1/stabilization when M1 closes (T1.7 merged, T1.5 accepted, T1.6 done)
   │   T1.7 → T1.5 → T1.6 ────────┘
   │
   ├─► T2.1  BACKEND ENGINEER   toolchain & dependency baseline      [already dispatched off a29c539; touches no file M1 still changes]
   │
   │   ═══ gate: forward merge done AND T2.1 merged ═══  (every task below touches files T1.7 changed, or builds on them)
   │                                     ┌─► T2.2 BACKEND ENGINEER  Express 5 upgrade  ──► merge ──► T2.3 DATABASE AGENT  Mongoose 9 upgrade ──► merge
   │                                     └─► T2.4 SECURITY & QA     platform core      ──► merge ──► T2.7 SECURITY & QA   CI workflow        ──► merge
   │        after T2.3 AND T2.4 merged ─┐
   │                                    ├─► T2.5 BACKEND ENGINEER  composition root, boot, legacy cut-over   ┐ developed in parallel, disjoint files.
   │                                    └─► T2.6 DATABASE AGENT    port the M1 suite to Vitest (against P6)  ┘ T2.5 merges first (not pushed); T2.6 rebases
   │                                                                                                           on it, verifies, merges; M2 gate runs after T2.6
   └─► T2.8 ARCHITECT (read-only)  independent review → ACCEPT / RETURN per task
            T2.9 Orchestrator: docs, milestone gate, owner approves push/PR
```

Sequencing rationale:
- **`m2/foundation` was cut from `m1/stabilization` @ `a29c539` before M1 was accepted**, so that T2.1 could run in parallel with M1's final steps.
- **T2.1 goes alone** because it owns `package.json` and the lockfile. It touches no file that T1.7 or T1.5 changes.
- **Forward merge.** When M1 closes, the Orchestrator merges `m1/stabilization` forward into `m2/foundation`. **T2.2 and every later task start only after that merge.** They touch files T1.7 changes (`models/server.js`, `controllers/uploads.js`, `middlewares/file-valid.js`, `e2e/**`), and the §4.8 ledger and §5.3 mapping are written against the post-T1.7 code.
- **T2.2 → T2.3 run in sequence** because both edit the lockfile. Each runs against the Jest suite, so the ROADMAP gate "green before and after each upgrade" holds literally.
- **T2.4 runs in parallel** with them because its files are disjoint.
- **T2.5 ‖ T2.6 are developed in parallel and merged back to back.** T2.5 deletes `models/server.js` (which breaks the Jest suite) and T2.6 replaces that suite. T2.6 needs `tests/helpers/app.ts` (P6) to run, so it verifies after rebasing onto the integration branch once T2.5 is merged locally. Nothing is pushed between the two merges, and the M2 gate (full suite 3×) runs on the combined result.

| Task | Agent | Model | Depends on |
|---|---|---|---|
| T2.1 | BACKEND ENGINEER | Claude Code · Opus 5.5 | ADR-017…024 accepted (dispatched off `m2/foundation` @ `a29c539`) |
| T2.2 | BACKEND ENGINEER | Claude Code · Opus 5.5 | T2.1, forward merge of M1 |
| T2.3 | DATABASE AGENT | OpenCode · DeepSeek V4 Flash | T2.2 |
| T2.4 | SECURITY & QA AGENT | Claude Code · Opus 5.5 | T2.1, forward merge of M1 |
| T2.5 | BACKEND ENGINEER | Claude Code · Opus 5.5 | T2.3, T2.4 |
| T2.6 | DATABASE AGENT | OpenCode · DeepSeek V4 Flash | T2.3 (codes against P6; runs after T2.5) |
| T2.7 | SECURITY & QA AGENT | Claude Code · Opus 5.5 | T2.4 |
| T2.8 | ARCHITECT | Claude Code · Opus 5.5 | T2.1–T2.7 merged |

---

### T2.1: Toolchain & Dependency Baseline
- **Agent:** BACKEND ENGINEER · **Worktree:** `worktrees/m2-t2.1-toolchain` · **Branch:** `m2/t2.1-toolchain` (dispatched off `m2/foundation` @ `a29c539`, in parallel with M1's final steps) · **Debt:** OPS-03 (lint/format), TEST-01 (runner)
- **Objective:** Install and configure the M2 toolchain **additively**: the legacy app, its Jest suite and `pnpm start` keep working unchanged.
- **Files allowed:** `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json` (new), `tsconfig.build.json` (new), `eslint.config.mjs` (new), `.prettierrc.json` (new), `.prettierignore` (new), `vitest.config.mts` (new), `tests/setup/global-setup.ts` (new).
- **Files forbidden:** everything else, including all legacy JS, `e2e/**`, `jest-e2e.json` and all `*.md`.
- **Required changes:**
  1. Add the packages in §3.1 **except** the two upgrades: zod, pino, pino-http, typescript, tsx, vitest, @vitest/coverage-v8, eslint, @eslint/js, typescript-eslint, prettier and the five `@types/*` (node, express, cors, supertest, bcrypt; **not** `@types/express-fileupload`, C10), at the exact versions shown. Keep `express`, `mongoose`, `jest`, `nodemon` and `dotenv` as they are.
  2. `pnpm-workspace.yaml`: add `esbuild: false` (§3.1).
  3. Scripts: add `build`, `typecheck`, `lint`, `format`, `format:check`, `test`, `test:watch`, `test:coverage` exactly as §3.2. Keep `start`, `dev`, `e2e` and `e2e:coverage` unchanged (T2.5 switches them). Add `"type": "commonjs"`.
  4. Create the config files with the exact content of §3.3, §3.5, §3.6 and §3.7, with these differences: in the legacy ESLint block, leave out `no-console` and the env-allowlist selector (T2.5 enables them). **Keep `'e2e/'` in the ESLint `ignores`**: without it, T1.4's `e2e/search.e2e.js:121` unused `eslint-disable` directive is a warning and fails `--max-warnings 0` (verified). In `.prettierignore`, keep the `e2e/` and `jest-e2e.json` lines. T2.6 removes both ignores when it deletes the Jest suite.
  5. `tests/setup/global-setup.ts` as §5.1.
- **Acceptance criteria:**
  - [ ] `pnpm install --frozen-lockfile` succeeds on a clean clone with Node 24 and pnpm 12.3.4, with no `ERR_PNPM_IGNORED_BUILDS`.
  - [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check` exit 0.
  - [ ] `pnpm vitest run --passWithNoTests` exits 0 (config loads, `mongod` starts and stops).
  - [ ] `pnpm e2e` (Jest M1 suite) is green; `pnpm start` still boots `app.js`.
  - [ ] A deliberate violation file (e.g. `src/core/x.ts` importing `../modules/y`) fails `pnpm lint` with the §2.3 message; delete it before committing.
  - [ ] `pnpm audit --prod` reports 0 advisories.
  - [ ] `git diff --stat` shows only the allowed files.
- **Commits:** `build(deps): add the TypeScript, lint, format and test toolchain` · `build: configure tsc, ESLint layer rules, Prettier and Vitest`.
- **Deliverables:** branch, report with the audit output.

### T2.2: Express 5 Upgrade
- **Agent:** BACKEND ENGINEER · **Worktree:** `worktrees/m2-t2.2-express5` · **Branch:** `m2/t2.2-express5` (from integration after T2.1 **and the M1 forward merge**, so T1.7 is in) · **Debt:** ADR-003, REL-01 (structural)
- **Objective:** Run the unchanged legacy app on Express 5.2.1 with byte-identical behaviour, as one revertible commit.
- **Files allowed:** `package.json` (the `express` line only), `pnpm-lock.yaml`, `models/server.js` (only the two T2.2 rows of §4.8), `controllers/uploads.js` (only the `res.sendFile` calls).
- **Files forbidden:** everything else.
- **Required changes:**
  1. `express` → `5.2.1`; `pnpm install`.
  2. Apply the three T2.2 rows of the §4.8 ledger: the compat shim, placed **right after `express.static`**; the listen callback; the `sendFile` root form. Go through every row of Appendix A and confirm "no other site" by grep on the merged M1 code, T1.7 included.
- **Acceptance criteria:**
  - [ ] `pnpm e2e` green, 3 consecutive runs.
  - [ ] With the repo copied under a path containing a dot-directory (e.g. `/tmp/.x/repo`), `GET /api/uploads/user/:id` still serves the stored file and the placeholder (Express 4 parity).
  - [ ] A bodiless `PUT /api/user/:id` as the owner behaves as on Express 4 (curl evidence before and after).
  - [ ] A file-only multipart upload through the router-level `fileParser` (C10) reaches the controller with `req.body` = `{}` (evidence from a temporary log line or a debugger, not committed). The C10/C11 Jest files (`multipart-scope`, `image-replacement`, `uploads`) stay green.
  - [ ] Starting two instances on one port makes the second exit non-zero.
  - [ ] Every Appendix A row has a before/after grep in the report. `pnpm audit --prod` shows 0 advisories.
- **Commit:** `build(deps)!: upgrade to Express 5` (body lists the call sites and `Refs: ADR-003`).
- **Deliverables:** branch, report.

### T2.3: Mongoose 9 Upgrade
- **Agent:** DATABASE AGENT · **Worktree:** `worktrees/m2-t2.3-mongoose9` · **Branch:** `m2/t2.3-mongoose9` (from integration after T2.2) · **Debt:** SEC-09 (keep 0), ROADMAP M2
- **Objective:** Run the unchanged legacy app on Mongoose 9.10.2, as one revertible commit.
- **Files allowed:** `package.json` (the `mongoose` line only), `pnpm-lock.yaml`, `controllers/category.js`, `controllers/product.js`, `controllers/usuarios.js` (**only** the `{new: true}` option objects).
- **Files forbidden:** everything else.
- **Required changes:**
  1. `mongoose` → `9.10.2`; `pnpm install`.
  2. Replace every `{new: true}` / `{ new: true }` option with `{ returnDocument: 'after' }`. There are 5 on the merged M1 code: `controllers/category.js:76,87`, `controllers/product.js:83,95`, `controllers/usuarios.js:60` (§4.8). Find all with `grep -rnE "new: ?true" controllers helpers middlewares models routes`. Change nothing else on those lines.
- **Acceptance criteria:**
  - [ ] `grep -rnE "new: ?true" controllers helpers middlewares models routes` prints nothing.
  - [ ] `pnpm e2e` green, 3 consecutive runs, and the output contains no `[MONGOOSE] Warning`.
  - [ ] `node -e "require('mongoose').version"` prints `9.10.2`; `pnpm audit --prod` shows 0 advisories.
  - [ ] `git diff` touches only the allowed lines.
- **Commit:** `build(deps)!: upgrade to Mongoose 9` (body: `Refs: ROADMAP M2`, the list of replaced sites, "requires MongoDB server ≥ 4.4").
- **Deliverables:** branch, report.

### T2.4: Platform Core (config, errors, envelope, logger)
- **Agent:** SECURITY & QA AGENT · **Worktree:** `worktrees/m2-t2.4-platform-core` · **Branch:** `m2/t2.4-platform-core` (from integration after T2.1 and the M1 forward merge; runs in parallel with T2.2/T2.3) · **Debt:** CFG-01, CFG-02 (partial), LOG-01 (logger), REL-02 (model), SEC-15 (config half of C9)
- **Objective:** Implement contracts P1–P4 with unit tests.
- **Files allowed:** `src/config/env.ts`, `src/config/index.ts`, `src/core/errors/{app-error,to-app-error,index}.ts`, `src/core/http/envelope.ts`, `src/core/logger.ts`, `tests/unit/**`, `.example.env`.
- **Files forbidden:** everything else (notably `src/app.ts`, `src/middlewares/**`, `src/database/**`, legacy JS, `package.json`).
- **Required changes:** implement §4.1–§4.4 exactly, write the four unit test files of §5.4, and write `.example.env` from §4.1.
- **Acceptance criteria:**
  - [ ] Every test listed for T2.4 in §5.4 exists and passes. `pnpm test:coverage` shows `src/config` and `src/core` at or above the §3.7 thresholds.
  - [ ] The `toAppError` table test covers every row of the §4.3 mapping table, including the T1.3 client-error branch, and the exact message strings.
  - [ ] `TRUST_PROXY` accepts and rejects exactly the set T1.7's `models/server.js` does (§4.1): the config unit tests cover unset, `''`, `0`, `2`, `abc`, `-1` and `true`.
  - [ ] Logger test: every `REDACT_PATHS` entry is censored.
  - [ ] `pnpm lint` passes, so `src/core` imports no Mongoose, Express value or `modules/`.
  - [ ] `pnpm typecheck`, `pnpm format:check`, `pnpm build` pass.
- **Commits:** `feat(config): validate the environment with zod and fail fast` · `feat(core): add the AppError hierarchy and the C1 error mapping` · `feat(core): add the response envelope helpers` · `feat(core): add the pino logger with redaction`.
- **Deliverables:** branch, report.

### T2.5: Composition Root, Boot and Legacy Cut-over
- **Agent:** BACKEND ENGINEER · **Worktree:** `worktrees/m2-t2.5-composition-root` · **Branch:** `m2/t2.5-composition-root` (from integration after T2.3 and T2.4) · **Debt:** ARC-02, ARC-03, SEC-14, LOG-01, REL-02, REL-03 (shutdown), SEC-10 (allowlist), SEC-15 (C9 wiring), CFG-01
- **Objective:** Boot from `src/server.ts` through `createApp`, mount the legacy routers unchanged, and remove the legacy platform code.
- **Files allowed:** `src/app.ts`, `src/legacy.ts`, `src/server.ts`, `src/middlewares/{request-logger,not-found,error-handler}.ts`, `src/database/connection.ts`, `tests/helpers/app.ts`, `tests/integration/platform/**`; **delete** `app.js`, `models/server.js`, `database/config.js`; **edit** `models/index.js` and only the console sites of `middlewares/validar-jwt.js`, `helpers/generar-jwt.js`, `controllers/uploads.js` and `middlewares/file-valid.js` (§4.8 T2.5 rows); `eslint.config.mjs` (enable the two legacy rules); `package.json` + `pnpm-lock.yaml` (scripts `start`/`dev`, `main`; remove `jest`, `nodemon`, `dotenv` and the `e2e`/`e2e:coverage` scripts).
- **Files forbidden:** `src/config/**`, `src/core/**` (raise a Question for any contract change), `tests/helpers/{legacy,factories,uploads}.ts`, `tests/integration/security/**`, `tests/unit/**`, `e2e/**`, `jest-e2e.json`, `vitest.config.mts`, `.github/**`, all `*.md`, and every legacy line not in the ledger.
- **Required changes:**
  1. Implement §4.5, §4.6 and §4.7 exactly. `HELMET_OPTIONS` is copied from the merged `models/server.js` before deleting it.
  2. Apply every T2.5 row of the §4.8 ledger; enable `no-console` and the env allowlist in the legacy ESLint block.
  3. `tests/helpers/app.ts` (P6, including `overrides`, one DB connection per file, and the log capture) and the four platform test files of §5.4 (`app`, `trust-proxy`, `database`, `server`).
  4. Scripts per §3.2; remove the three packages.
- **Acceptance criteria:**
  - [ ] ARC-03: `node -e "require('./models'); require('./helpers/db-validators'); require('./controllers/uploads'); require('./routes/usuarios')"` exits 0 **in each of the 4 entry orders** (every module can be the entry point).
  - [ ] Re-verify the §4.8 ledger by grep on the post-T1.7 code and report any site that differs from it. `grep -rn "console\." routes controllers middlewares helpers models` prints nothing, and `pnpm lint` passes with both legacy rules enabled.
  - [ ] C9: `TRUST_PROXY=abc` makes `node dist/server.js` exit 1 with a `ConfigError` naming `TRUST_PROXY`, before listening. `tests/integration/platform/trust-proxy.test.ts` is green.
  - [ ] C10: `createApp` has no multipart parser (`grep -n fileUpload src` prints nothing), and the platform test "multipart body on a non-upload route is ignored" is green.
  - [ ] Every platform test of §5.4 passes; `pnpm test:coverage` meets the `src/**` thresholds.
  - [ ] `pnpm build && node --enable-source-maps dist/server.js` with a valid env and a `mongodb-memory-server` URI logs `server listening`; `curl -i /api/category` returns 201 with an `x-request-id` header; `kill -TERM` exits 0. With `SECRET_KEY` unset it exits 1 before listening.
  - [ ] `pnpm dev` serves the same request (tsx path).
  - [ ] The demo page `/` still loads under the moved CSP (the `curl -I /` header matches the T1.3 evidence).
  - Note: the Jest suite cannot run on this branch (`models/server.js` is gone). Full regression evidence comes from T2.6 on the combined result (§7.3).
- **Commits (revert units):** `feat(platform)!: boot from src/server.ts through createApp` (src, deletions, models/index, scripts; `connection.ts` keeps the legacy `mongoose.set('strictQuery', false)` so this commit changes no query behaviour) · `fix(database): enable sanitizeFilter and strictQuery` (SEC-14: flips `strictQuery` to `true` and adds `sanitizeFilter`, those two lines only) · `refactor(logging): route legacy logs through req.log` (LOG-01 + the two legacy lint rules) · `build(deps): remove Jest, nodemon and dotenv`.
- **Deliverables:** branch, report with the boot/shutdown transcript.

### T2.6: Port the M1 Regression Suite to Vitest
- **Agent:** DATABASE AGENT · **Worktree:** `worktrees/m2-t2.6-suite-port` · **Branch:** `m2/t2.6-suite-port` (from integration after T2.3; write against P6 while T2.5 runs; rebase onto the integration branch once T2.5 is merged, then verify) · **Debt:** TEST-01
- **Objective:** A **mechanical, 1:1** port of every `e2e/*.e2e.js` to TypeScript Vitest tests, with no change to what any test asserts.
- **Files allowed:** `tests/helpers/legacy.ts`, `tests/helpers/factories.ts`, `tests/helpers/uploads.ts`, `tests/integration/security/*.test.ts` (new); **delete** `e2e/**` and `jest-e2e.json`; `.prettierignore` (remove the `e2e/` and `jest-e2e.json` lines only); `eslint.config.mjs` (remove `'e2e/'` from `ignores` only, after rebasing onto T2.5, which edits the legacy block of the same file).
- **Files forbidden:** everything else, notably all application code (`src/**` and legacy JS), `tests/helpers/app.ts`, `tests/setup/**`, `vitest.config.mts`, `package.json`. If a ported test fails, **report it** under Questions with the failing assertion; don't change the app or the assertion.
- **Required changes:**
  1. `tests/helpers/legacy.ts` exactly as §5.2. `tests/helpers/factories.ts` and `tests/helpers/uploads.ts` port **every export of `e2e/helpers/db.js` at the merge base** (§5.3 helper table, T1.7's changes included), with **the same names, defaults and behaviour**.
  2. For each `e2e/<name>.e2e.js` at the merge base (9 files after T1.7), create `tests/integration/security/<name>.test.ts` by applying **only** the rows of the §5.3 mapping table, in order, as in the worked examples. Keep every `describe`/`test` title, the order, and every `expect`. Rows A and B are the only non-mechanical ones; list each use of them in the report.
  3. Delete `e2e/` and `jest-e2e.json`.
- **Acceptance criteria:**
  - [ ] The 1:1 title diff of §5.3 is empty (paste the command and its output). Multi-line `test.each` titles are checked by eye and listed.
  - [ ] The report lists every use of non-mechanical rows A and B: file, test title, before → after.
  - [ ] `grep -rn "vi.mock\|jest\." tests` prints nothing.
  - [ ] On the combined T2.5+T2.6 result: `pnpm test` is green 3 consecutive times, and the security folder runs in under 60 s.
  - [ ] `pnpm lint`, `pnpm typecheck`, `pnpm format:check` pass.
  - [ ] No file outside Files Allowed changed.
- **Commit:** `test: port the M1 regression suite to Vitest` (body: `Refs: TEST-01`, file mapping).
- **Deliverables:** branch, report with the title diff and the 3 run summaries.

### T2.7: CI Workflow
- **Agent:** SECURITY & QA AGENT · **Worktree:** `worktrees/m2-t2.7-ci` · **Branch:** `m2/t2.7-ci` (after T2.4) · **Debt:** OPS-03 (CI)
- **Objective:** Add the §6 workflow verbatim.
- **Files allowed:** `.github/workflows/ci.yml` (new).
- **Files forbidden:** everything else.
- **Acceptance criteria:**
  - [ ] File content equals §6; `pnpm format:check` passes (valid YAML).
  - [ ] Every `uses:` ref resolves: `gh api repos/<owner>/<repo>/commits/<ref>` for `actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6` and `pnpm/action-setup@ea17c68…`, output pasted. The Orchestrator already verified checkout v7.0.1, setup-node v7.0.0, cache v6.1.0, and that `ea17c68…` is pnpm/action-setup v6.1.0.
  - [ ] Running the workflow's `run:` steps in order on a clean clone of the integration branch succeeds (steps that need T2.5/T2.6 are re-run by the Orchestrator after those merges).
- **Commit:** `ci: add lint, typecheck, build, test and audit workflow`.
- **Deliverables:** branch, report.

### T2.8: Independent Review (quality gate)
- **Agent:** ARCHITECT (**read-only**) · **Target:** `m2/foundation` after all merges.
- **Checks:**
  - [ ] Every acceptance criterion of T2.1–T2.7 has evidence.
  - [ ] Contract conformance: P1–P8 match §4 byte-for-byte where specified. C1/C2 bodies are identical to M1. The full M1 suite passes. Diff the legacy tree against the M1 merge: only §4.8 ledger lines changed.
  - [ ] Each upgrade reverts cleanly: on a scratch branch, `git revert` the Express 5 commit and then the Mongoose 9 commit, each alone; run `pnpm install && pnpm test`.
  - [ ] Scope compliance per branch; no new dependencies outside §3.1; no speculative code (every export is consumed in M2 or named as an M3 consumer in this document).
- **Deliverables:** findings ranked by severity; ACCEPT / RETURN per task.

### T2.9: Milestone Close (Orchestrator)
- ADR-017…024 are already recorded in ARCHITECTURE §3. Refresh ARCHITECTURE §1.1/§1.2/§1.4/§1.6/§1.7 (stack, tree, logging, config, dependencies).
- TECH_DEBT: mark ARC-02, ARC-03, LOG-01, SEC-14, REL-02 (model; envelope → M3) fixed. SEC-15 keeps its M1 status; M2 moves the parse into config without changing behaviour. Mark CFG-01 fixed for the platform (legacy reads end in M3). Mark CFG-02, SEC-10, OPS-03, TEST-01 and REL-03 partially fixed, with their remaining milestones.
- API_PROGRESS ledger (M2 rows): the `x-request-id` response header (additive), the CORS allowlist when configured, and operator objects in filter values now rejected with 400. CHANGELOG entries go under **2.1.0** (ADR-024): an **Operational** section with `pnpm build` before `pnpm start`, boot fails fast without the four required variables or with an invalid `TRUST_PROXY`, Node `--env-file-if-exists` replaces dotenv, JSON logs on stdout, and MongoDB server ≥ 4.4.
- ROADMAP: M2 ✅, M3 next.

---

## 8. Risks and rollback

### 8.1 Commit plan and independent reverts

| Revert unit (commit) | Reverts cleanly because | Revert procedure |
|---|---|---|
| T2.2 `build(deps)!: upgrade to Express 5` | Commit holds the version + lockfile + its 3 call-site fixes. Every fix is also valid on Express 4 (`{ root }` sendFile, `req.body ??= {}`, the listen callback). After T2.5, `src/` compiles against `@types/express@5` (T2.1) and runs on Express 4: the only runtime difference is that `EADDRINUSE` arrives as an `error` event, which the `uncaughtException` handler turns into exit 1 | `git revert <sha>` → `pnpm install --frozen-lockfile` → `pnpm test` |
| T2.3 `build(deps)!: upgrade to Mongoose 9` | `returnDocument: 'after'` is supported by Mongoose 7 (verified) | same |
| T2.5 `fix(database): enable sanitizeFilter and strictQuery` | two lines; works on 7 and 9 | same |
| T2.5 `refactor(logging): route legacy logs through req.log` | legacy sites + two lint rules only | same |
| T2.5 `feat(platform)!…` / T2.6 port / T2.4 core | not independently revertible (the platform is one unit). Rollback = revert the M2 merge on `master` (M1 state, Jest suite restored) | `git revert -m 1 <merge>` |

### 8.2 Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **M9 production checklist:** build before start. `pnpm start` runs `dist/`, so a deploy that only installs cannot boot | a later deploy fails to start | There is **no live deployment** (owner, 2026-09-23: the app is no longer on Zeabur; the demo URL is dead, CQ-07). M9's checklist carries the build step; CHANGELOG 2.1.0 Operational entry |
| R2 | **M9 production checklist:** the four required variables (`MONGO_CLOUD`, `SECRET_KEY`, `GOOGLE_CLIENT_ID`, `CLOUDINARY_URL`), plus `TRUST_PROXY` set to the real hop count behind a proxy | boot fails fast (by design) or, for `TRUST_PROXY`, a C5 bypass or lockout | M9 checklist. Failing fast is intended: a missing `GOOGLE_CLIENT_ID` would disable the audience check. For the hop count, see T1.7 Risk 1 |
| R3 | **M9 production checklist:** MongoDB server ≥ 4.4 (driver 7 minimum) | connection refused at boot | M9 checklist; T2.3 can be reverted alone |
| R4 | An agent stubs a legacy dependency with `vi.mock`, so the real SDK runs | false-green or network-dependent tests | Lint bans `vi.mock`; the §5.2 helpers are the only stubbing path |
| R5 | Express 5 behaviour not covered by the M1 suite (dot-directory paths, bodiless requests, listen errors) | silent regressions | Fixed at the call sites (Appendix A). T2.2 acceptance reproduces each case, and the platform tests keep them covered |
| R6 | M1 closes differently from `a29c539` + `7a932d5` (T1.5 findings, a C1 amendment A2 for multipart parse errors, changes to T1.7 during review) | contract drift in `toAppError`, the ledger, the helmet options or the ported tests | Contracts are defined as "what `m1/stabilization` does". Site lists are grep/lint-based, and T2.2+ start only after the forward merge. T2.4/T2.5 re-derive from the merged code and report differences |
| R7 | TypeScript 7 cannot be adopted while typescript-eslint caps at `<6.1` | stuck on 6.0 | tsconfig is 7-clean (no deprecated options); revisit in M10 |
| R8 | Parallel test files share one `mongod`. One unreproduced `socket hang up` was seen in a ported 404 test while other agents loaded the machine; T1.7 also reported an unexplained intermittent failure under load | flakiness under load | Per-file DB and process. 5 consecutive full-suite runs, then 10 runs of the C10 file, were green afterwards. T2.6's 3× gate and T2.8 watch for it; fall back to `fileParallelism: false` if it recurs |
| R9 | Request URLs contain PII (admin `GET /api/search/user/<email>`) and are logged | PII in logs | admin-only route; logs are operator-only; M3 can move terms to a redacted query parameter |
| R10 | Node `--env-file` parsing differs from dotenv in edge cases (inline comments, `export` and quotes verified identical; multiline values and `${VAR}` expansion are not used here) | wrong local values | production uses real env vars, which take precedence over the file (verified) |
| R11 | Lockfile conflicts between tasks | merge pain | only one task at a time edits the lockfile (T2.1 → T2.2 → T2.3 → T2.5) |
| R12 | A future `esbuild` release needs its postinstall | install fails under `esbuild: false` | switch the entry to `true`; tsx/vite pick up the platform binary either way |
| R13 | T2.5 and T2.6 both touch the C11 orphan notice: T2.5 moves it to `req.log.error`, and T2.6's ported test asserts on it through `loggedText()` | the ported C11 test fails if the log record drops the asset URL | §4.8 fixes the record to include `asset: secure_url`; row B asserts only that the URL appears in the logged text |

### 8.3 Operational notes for whoever deploys M2 later

There is no live deployment today; these notes feed the M9 production checklist.

1. Build step: `pnpm install --frozen-lockfile && pnpm build`, then `pnpm start`.
2. Required env: `MONGO_CLOUD`, `SECRET_KEY`, `GOOGLE_CLIENT_ID`, `CLOUDINARY_URL`. Optional: `PORT`, `NODE_ENV=production`, `LOG_LEVEL`, `CORS_ORIGINS` (unset = any origin, with a boot warning in production; ADR-022), and `TRUST_PROXY` (the real reverse-proxy hop count; unset = none trusted; C9).
3. Logs are JSON lines on stdout; errors carry `reqId`, which clients see as `x-request-id`.
4. MongoDB server ≥ 4.4.

### 8.4 Questions (all closed on 2026-09-23)

1. ~~Does the deployment run `build` before `start`?~~ **Closed:** there is no live deployment; it is an M9 checklist item (R1).
2. ~~Are the required variables set in production, and is Atlas ≥ 4.4?~~ **Closed:** same answer (R2, R3).
3. ~~CORS default?~~ **Closed:** ADR-022 is kept as written (unset = any origin, with a production `warn`); M9's checklist sets `CORS_ORIGINS`.
4. ~~Accept ADR-017…ADR-023?~~ **Closed:** accepted, plus ADR-024.

Still open, owned by M1 rather than this design: T1.7's Q2, a C1 amendment "A2" mapping multipart parse errors to 400. If it is accepted, §4.3 gets a row and T2.4 a branch in `toAppError`.

---

## Appendix A: Express 4 → 5 audit against this codebase

Source: the official migration guide, <https://expressjs.com/en/guide/migrating-5.html>. The grep covered the merged `m1/stabilization` @ `a29c539` and T1.7 @ `7a932d5`; site references use `a29c539` lines, with *(T1.7)* lines where they differ. "Verified" means reproduced side by side on Express 4.22.3 and 5.2.1.

| # | Breaking change | Touches this codebase? | Sites | Fix |
|---|---|---|---|---|
| 1 | `app.del()` removed | no | — | — |
| 2 | `app.param(fn)` / `router.param(fn)` signatures removed; leading `:` in `app.param` name | no | — | — |
| 3 | `req.acceptsCharset/Encoding/Language` → plural | no | — | — |
| 4 | `req.param(name)` removed | no | — | — |
| 5 | `res.json(obj, status)`, `res.jsonp(obj, status)`, `res.send(body, status)` removed | no (every call is `res.status(n).json(…)`) | — | — |
| 6 | `res.send(status)` number-only removed | no | — | — |
| 7 | `res.redirect(url, status)` order; `'back'` magic string | no | — | — |
| 8 | `res.sendfile()` removed | no (`sendFile` already) | — | — |
| 9 | `express.static.mime` removed; `.js` served as `text/javascript` | only the MIME value of `public/js/auth.js` | `public/` | none needed (browsers accept both) |
| 10 | `express:router` debug namespace → `router` | no | — | — |
| 11 | Path syntax: unnamed `*`, `?`, regexp chars, reserved chars | no. Every path is literal or `:param`: `/`, `/:id`, `/:collection/:term`, `/:collection/:id`, `/login`, `/google`, `/hello` | all routers | — |
| 12 | Rejected promises forwarded to the error middleware | **yes, beneficial**: an async handler that throws no longer crashes the process (REL-01 structurally closed) | all async handlers | none (M1 try/catch stays until M3) |
| 13 | `express.static` / `res.sendFile` `dotfiles` now applies to hidden **directories** in the path | **yes (verified regression)**: `res.sendFile(<absolute path>)` returns 404 when any ancestor directory starts with `.` (e.g. a deploy under `/home/app/.apps/…`) | `controllers/uploads.js:130`, `:135` (`showImage`) *(T1.7 `:69`, `:74`)* | `res.sendFile(name, { root: dir })`: the dotfile check then applies only to the file name, as in Express 4 (verified 200 on both). `express.static(public)` has no dotfiles. |
| 14 | `sendFile`/`static` `hidden`, `from` options removed | no | — | — |
| 15 | `express.urlencoded` `extended` default `false` | no (not used) | — | — |
| 16 | `app.listen` passes errors to the callback instead of throwing | **yes**: with a callback that ignores its argument, `EADDRINUSE` would log "listening" and never exit | `models/server.js:137` `listen()` *(T1.7 `:138`)* → `src/server.ts` | T2.2: rethrow in the callback; T2.5: `listen()` rejects (§4.6) |
| 17 | `app.router` restored | no | — | — |
| 18 | `req.body` is `undefined` when no parser ran (was `{}`) | **yes (verified)**: bodiless requests and multipart requests with only a file (express-fileupload sets no body without fields). Handlers that destructure `req.body` without a body validator throw. That is `controllers/usuarios.js:43` `putUser` (T1.2's whitelist, `const { name, password, role, state } = req.body`, outside its `try`), so a bodiless or multipart `PUT /api/user/:id` would answer 500 instead of Express 4's 200 no-op. T1.7's "`PUT /api/user/:id` ignores multipart fields (200)" test depends on this | legacy handlers | `req.body ??= {}` in front of legacy routers only: T2.2 adds it globally in `models/server.js`, right after `express.static`; T2.5 moves it into `src/legacy.ts`. With T1.7's router-level `fileParser`, a file-only upload still gets `{}` (verified, §4.8). Handlers behind a body validator (`name`/`email`/`id_token` required) already answer 400 either way |
| 19 | `req.host` keeps the port | no | — | — |
| 20 | `req.params` null prototype; unmatched params omitted; wildcards are arrays | no (only destructuring of named params; T1.3's `req.params.collection` is a plain read) | — | — |
| 21 | `req.query` is a getter; default parser `simple` (not `extended`/qs) | read-only use only: `controllers/{category,product}.js` read `req.query.limit/offset` (T1.3); nested `?limit[$gt]=…` is no longer parsed into an object, and T1.3's `parseInt` falls back to the default either way (verified identical) | `controllers/category.js:7-8`, `controllers/product.js:7-8` (T1.3) | none. Note for M3: express-validator sanitizers cannot write back into `req.query`; zod DTOs parse into a new object |
| 22 | `res.clearCookie` ignores `maxAge`/`expires` | no | — | — |
| 23 | `res.status()` accepts only integers 100–999 | all literal integers; T1.3's `res.status(err.status)` is guarded to 4xx | — | — |
| 24 | `res.vary()` throws without a field | no | — | — |
| 25 | Node ≥ 18 | ok (24.16) | — | — |
| — | Third-party middleware on Express 5 | `cors`, `helmet`, `express-fileupload@1.5.2` (router-level since C10), `express-validator@7.3.2`, `express-rate-limit@8.7.0` (peer `express >= 4.11`) | — | none: all exercised in the prototype, including T1.7's `fileParser` and the C9 limiter key |

The **URL-decoding error** keeps its shape: `URIError` with `status: 400` on both versions (Express 5 drops `statusCode`, which C1 never read). C1's client-error branch therefore behaves the same (verified).

## Appendix B: Mongoose 7 → 8 → 9 audit against this codebase

Sources: <https://mongoosejs.com/docs/migrating_to_8.html> and <https://mongoosejs.com/docs/migrating_to_9.html>. Driver minimum from `mongodb@7.6.0` `lib/cmap/wire_protocol/constants.js` (`MIN_SUPPORTED_SERVER_VERSION = '4.4'`).

| Version | Breaking change | Touches this codebase? | Fix |
|---|---|---|---|
| 8 | `rawResult` → `includeResultMetadata` | no | — |
| 8 | `Document#deleteOne()` returns a Query | no (soft delete via `findByIdAndUpdate`) | — |
| 8 | MongoDB driver 6: `ObjectId` no longer built from 12-character strings; SSL option renames | **indirect.** On Mongoose 7, `isValidObjectId('novelsnovels')` is `true` and a 12-character search term was treated as an id; on 9 it is `false` (verified). T1.3 `fcc2a54` ("treat only real ObjectIds as id lookups") already made search independent of this; no SSL options used | none after M1 |
| 8 | `findOneAndRemove`, `findByIdAndRemove` removed | no | — |
| 8 | `count()` removed | no (`countDocuments`) | — |
| 8 | `id` setter removed | no | — |
| 8 | `null` allowed for non-required string enums | no enums | — |
| 8 | `minimize` on `save()` for updates | no empty objects saved | — |
| 8 | discriminator path order | no discriminators | — |
| 8 | `overwrite` option removed | no | — |
| 8 | `findOneAndUpdate` + `orFail` + `upsert` | no | — |
| 8 | `create()` waits for all saves before throwing | test factories create one document at a time; no effect | — |
| 8 | `Model.validate()` returns a copy | no | — |
| 8 | TS: optional fields include `null`; constructor props optional; `distinct` types | TS only; M2 TS writes no queries | — |
| 9 | `pre` middleware without `next()` | no hooks | — |
| 9 | `Schema#doValidate()` returns a promise | no | — |
| 9 | Update pipelines disallowed by default | no | — |
| 9 | **`new` / `returnOriginal` deprecated → `returnDocument`** | **yes**: emits `[MONGOOSE] Warning … the new option … is deprecated` (verified) | `{new: true}` → `{ returnDocument: 'after' }` at `controllers/category.js:76,87`, `controllers/product.js:83,95`, `controllers/usuarios.js:60` (T2.3). `deleteUser`'s update has no option and keeps returning the pre-update document (default `'before'`, CQ-05 unchanged) |
| 9 | index `background` option removed | no | — |
| 9 | `isValidObjectId()` false for numbers | search passes strings; no effect | — |
| 9 | subdocument `deleteOne()` hooks | no | — |
| 9 | callbacks in custom method/static hooks, `Document#updateOne` | no | — |
| 9 | `promiseOrCallback`, `isAsync` middleware, `skipOriginalStackTraces`, `caster`/`casterConstructor`, `skipId`, `use$geoWithin`, `useDb({ noListener })` removed | no | — |
| 9 | UUIDs returned as `bson.UUID` | no UUID paths (`crypto.randomUUID()` is only used for file names) | — |
| 9 | Node ≥ 20.19 | ok (24.16) | — |
| 9 | TS: `FilterQuery` → `QueryFilter`, stricter filters, no generic on `create()`, typed `id` | TS only (from M3) | — |
| driver 7 | MongoDB server ≥ **4.4** | no live deployment; an M9 production checklist item (R3). `mongodb-memory-server` runs 8.2.x | — |
| — | `Schema({...})` called **without `new`** (all four legacy models) | still supported in 9.10.2 (verified) | none |

## Appendix C: Prototype evidence and sources

Prototype: the legacy JS of `m1/t1.3-crash-safety` (with T2.x ledger edits applied), the §3.1 dependency set, and the §4 platform code. Results on Node 24.16.0 / pnpm 12.3.4:

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` with and without `esbuild` in `allowBuilds` | fails with `ERR_PNPM_IGNORED_BUILDS` if unlisted; passes with `esbuild: false`; `tsx` and Vitest work |
| `pnpm audit --prod` / `pnpm audit` | 0 / 0 advisories |
| `tsc -p tsconfig.json` (TS + legacy JS) · `tsc -p tsconfig.build.json` | pass · `dist/` mirrors `src/`, no legacy emitted |
| ESLint (type-aware) on the platform + deliberate violations | platform clean; all 8 rule groups of §3.5 fire with their messages; `no-console` flags exactly the 4 legacy sites in §4.8 |
| Vitest: `require`, `__filename`, `import.meta.url` available in TS test and source modules; each file in its own process | yes / yes |
| `vi.mock('cloudinary')`, `vi.mock('../../helpers/google-verify')` against legacy | **not applied** (real SDK: 500; real verifier: 400) |
| Spies on the shared instance (`stubCloudinary`, `stubGoogleVerify`); `restoreMocks` isolation | applied; gone in the next test |
| `import mongoose` (test/TS) vs `require('mongoose')` (legacy) | same instance |
| Mechanical port of T1.4 `reliability.e2e.js` | **13/13 green** |
| Express 4.22.3 vs 5.2.1: `sendFile` under a dot-directory, `req.body` bodiless / file-only multipart, `URIError` shape, `res.json(undefined)` | regression / regression / same / same |
| Mongoose 9: `{new:true}` warning; `Schema()` without `new`; `sanitizeFilter` + legacy search; `strictQuery` | warns / works / search unaffected, operator filter → CastError / unknown path stripped |
| Mongoose 7.8.12: `returnDocument: 'after'`, `sanitizeFilter` | supported (independent revert) |
| `node dist/server.js`: invalid env · unreachable DB · request + SIGTERM | exit 1 with the zod report · exit 1 after 10 s · 201 with echoed `x-request-id`, `x-token` redacted in the log line, exit 0 |
| `tsx watch --env-file-if-exists=.env src/server.ts` | serves requests |
| Node `--env-file`: `A=1 # comment`, `export B=2`, `C="x # y"`, variable already in the environment | `1`, `2`, `x # y`, environment value wins (same as dotenv) |
| 1:1 title diff (§5.3) on the ported `reliability` file | identical, 18 titles |
| **Amendment re-run** on T1.7 legacy code (`7a932d5`, with `models/server.js` removed and the §4.8 T2.5 logging rows applied) | |
| `loadConfig` with `TRUST_PROXY` unset, `''`, `'0'`, `'2'`, `'abc'`, `'-1'`, `'true'`, `'1.5'`, `' 1'` | `undefined`, `undefined`, `0`, `2`, then `ConfigError … → at TRUST_PROXY` for the rest (T1.7's accept/reject set) |
| `createApp` with no global `fileUpload`; T1.7's `multipart-scope` ported (15 tests) | green, including every "other routes ignore multipart" case and every temp-file cleanup case |
| `vi.spyOn(fs, 'createWriteStream')` on the `node:fs` default import vs express-fileupload's `require('fs')` | same object; the spy sees every temp write |
| T1.7's `image-replacement` ported with row B (orphan notice via `req.log.error` → `loggedText()`) | green |
| T1.7's `trust-proxy` ported with row A (`startTestApp({ TRUST_PROXY })`, `ConfigError`) | green; Vitest has no `%p`, and `%j` renders `"abc"` |
| Platform `trust-proxy.test.ts` (draft-7 `RateLimit … remaining=n`) | set: per-`X-Forwarded-For` budgets (9, 9, 8); unset: one budget (9, 8) |
| AM-1d body shape: shim ahead of the router, T1.7 `fileParser` on the route | file-only → `{}`; file + field → `{ note: 'hi' }`; no body → `fileValid` 400 |
| Title diff of the three T1.7 ports (base side `%p`→`%j`) | identical: 7 + 7 + 15 |
| Legacy lint after the §4.8 T2.5 rows | `grep console.` empty; `no-console` and the env allowlist pass |
| `eslint --max-warnings 0` over T1.4's `e2e/` | fails on `e2e/search.e2e.js:121` (unused `eslint-disable`), hence `'e2e/'` in the T2.1 ignores |
| Full prototype suite (unit, platform, 4 ported security files, stub checks) | **57/57 green, 5 consecutive runs**. One earlier run had a single `socket hang up` in a 404 test while the machine was under load; it wasn't reproduced (R8) |
| V8 coverage of natively-required legacy JS; glob thresholds | measured; `src/**` thresholds enforced |

Sources: Express 5 migration guide (above); Mongoose migrating_to_8 / migrating_to_9 (above); "Announcing TypeScript 6.0" (defaults: `strict`, `module esnext`, `types: []`, `rootDir .`; deprecations removed in 7.0), <https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/>; `npm view` peer ranges (`typescript-eslint@8.70.1` → `typescript >=4.8.4 <6.1.0`; `vitest@5.0.1` → `vite ^6.4 || ^7 || ^8`, Node `^22.12 || ^24 || >=26`; `mongoose@9.10.2` → Node `>=20.19`); `pnpm/action-setup` README (v6 supports pnpm 12; version read from `packageManager`); pino-http 11 README and `logger.js` (`res.err` logging, `quietReqLogger`).
