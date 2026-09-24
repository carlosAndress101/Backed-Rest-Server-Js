# M5 — Authentication Hardening Design

> Milestone **M5 (Authentication Hardening)** · Design only — no code in this document is executed by the M5 design task.
> Prepared by the ARCHITECT · 2026-09-25 · Base: `next` @ `01be022` (M4 accepted and merged, 926 tests).
> Governing ADRs: **ADR-005** (DI factories, one composition root), **ADR-010** (Bearer transport, `x-token` deprecated one major, `tokenVersion` revocation, no refresh tokens), **ADR-019** (fail-fast config), **ADR-024/026** (release mapping and lines — M5 ships inside 3.0.0, on `next`), **ADR-025** (supply-chain age gate: prefer no new dependency), **ADR-028** (the interim guards M5 does **not** touch — that is M6), **ADR-031** (the migration runner and `src/cli.ts` composition root M5 reuses as-is).
> Debt closed or advanced: **SEC-06** (per-account key added; the per-instance store stays, M9), **SEC-07** (the residual: rehash-on-login), **SEC-11**, **SEC-12**, **SEC-16**, **PERF-01**, **CQ-06** (M5) · **OPS-05** stays M9 (not pulled in).

All mechanics below marked **[P#]** were measured in a scratch clone of this branch against the real dependencies (`jsonwebtoken` 9.0.3, `bcrypt` 6.0.0, `mongoose` 9.10.2, `mongodb-memory-server`), never assumed.

---

## 0. Scope, assumptions, non-goals

**Assumes M4 has landed.** `password` is `select: false`; a login read asks for `+password` explicitly; email is normalized (trimmed, lowercased) at the schema and DTO layers; `tokenVersion` exists on every user document, defaulted to `0`, hidden from JSON; the migration runner (`src/database/migrate.ts`) and its CLI (`src/cli.ts`, a composition root, ADR-031) are in place; `autoIndex` is off in production.

**In scope (M5 deliverables):**
- `Authorization: Bearer` as the primary transport; `x-token` accepted for one major with a deprecation signal (ADR-010).
- JWT pinned to HS256, with `iss`/`aud`, a configurable TTL, and a minimum secret length enforced at boot.
- Revocation via `tokenVersion`: the claim, when it increments, how `authenticate` checks it, and the fate of every M4-and-earlier token.
- Async password hashing with a configurable cost (PERF-01), a length policy including the 72-byte bcrypt boundary (SEC-16), and a rehash-on-login rule for the SEC-07 residual.
- Google sign-in hardening: `email_verified` required, no placeholder password, an explicit (not silent) account-linking rule (SEC-12).
- Rate limiting per IP **and** per account on the credential-guessing surface (SEC-06's per-account gap; the per-instance store stays as it is).
- Two new endpoints: `POST /api/auth/logout-all`, `PUT /api/auth/password`.
- Two data migrations (M005, M006) in the M4 runner's style.

**Out of scope (scope fences):**
- `authorize(policy)` and the permission matrix — **M6**.
- The multi-instance rate-limiter store and the OPS-05 production boot guard — **M9**.
- Refresh tokens — explicitly rejected by ADR-010 (YAGNI; no client has asked for long sessions).
- A dedicated "link my Google account" authenticated flow — this design closes the *dangerous* silent auto-link (SEC-12) but does not build the opt-in linking UI; see Owner Question 1.
- Anything about `role`/`state`/ownership semantics — unchanged from M3/M4.

**Principles applied (ARCHITECTURE §2.1):** no new dependency (ADR-025) — every mechanic below uses `jsonwebtoken`, `bcrypt` and `express-rate-limit`, already present; F1 (the constant-shape, constant-cost credential failure) is never weakened, and is explicitly extended to the new password-change path; every new index or migration traces to a stated need.

---

## 1. Decisions summary (proposed ADRs, ADR-032+)

| ADR | Decision | Why | Consequence |
|---|---|---|---|
| **ADR-032** | **Transport: `Authorization: Bearer <token>` first; `x-token` second, never both.** If an `Authorization` header is present at all, it must be exactly `Bearer <token>` or the request is 401 — `x-token` is never consulted as a fallback for a malformed `Authorization` header. Every response that was authenticated via `x-token` carries `Deprecation: true` (RFC 9745) [P-verified header semantics, no library needed]. `Sunset` (RFC 8594) is added once a 4.0.0 date is scheduled; omitted until then, since RFC 8594 requires an HTTP-date, not a placeholder. | A deterministic precedence rule is a stated, testable adversarial case (the brief's list). RFC 9745 (2024) is the standing IETF answer for "this deprecated"; it allows a boolean `true` when no exact date exists yet. | Clients that send both headers must know Bearer wins. No client code silently keeps working through a garbled `Authorization` header. |
| **ADR-033** | **Revocation via `tokenVersion` (`tv` claim), a single per-user counter.** It increments on **logout-all** and on a **password change**; nothing else increments it in M5 (session-level, "log out this device only" revocation needs a session store, which is out of scope). `authenticate` loads `tokenVersion` with every other field it already reads (no extra query) and rejects a mismatch with the same generic 401 as any other invalid token — never a distinguishable "revoked" message. | Reuses the field M4 already added (hidden, defaulted). No new collection, matching ADR-010's rationale ("`validarJWT` already loads the user per request"). | Every session on every device dies together; there is no "log out phone, keep laptop." Acceptable per YAGNI (no client has asked for per-device sessions). |
| **ADR-034** | **JWT claims: `{ uid, tv, iat, exp, iss, aud }`, HS256 pinned on both `sign` and `verify`.** `iss`/`aud` are **fixed code constants** (`backed-rest-server` / `backed-rest-server-clients`), not environment variables — they identify this API, not a per-deployment secret, and making them env-configurable would let two instances of the same deployment silently disagree and reject each other's tokens. TTL is configurable (`JWT_TTL`, default `'4h'`, unchanged). `SECRET_KEY` gains a minimum length of 32 characters (256 bits, matching HS256's recommended key size), enforced by the existing zod env schema (fail-fast, ADR-019). | **[P1]** Verified: `jwt.verify()` with **no** `algorithms` option (today's code) accepts an HS384-signed token against the same secret — not classic RS/HS confusion, but a real "any HMAC variant" laxity. Pinning `algorithms:['HS256']` plus `issuer`/`audience` rejects HS384, an unsigned (`alg:none`) token, a wrong `aud`, and a wrong `iss` — all confirmed to throw `JsonWebTokenError`. | **Breaking, by design:** every token issued before M5 (no `iss`/`aud`/`tv`) fails the new `audience`/`issuer` check — **[P1]** confirmed directly: an M4-shaped token verified under M5's options throws `jwt audience invalid`. See §2 for the client-recovery story. A `SECRET_KEY` under 32 characters now **fails to boot** — see §7 (deploy notes). |
| **ADR-035** | **Password hashing is async everywhere, at a configurable cost; a differently-costed stored hash is rehashed to the configured cost after a successful login, without affecting the response.** `bcrypt.compareSync`/`hashSync` are replaced by `bcrypt.compare`/`bcrypt.hash` (PERF-01). Cost comes from `config.auth.bcryptCost` (default `10`, unchanged behaviour unless an operator opts in), read by both `user.service.ts` and the shared `core/security/password.ts` module — the seed keeps its own constant per T4.4 D8 (unchanged; `src/database` still imports no module) but now reads it from `config.seed`'s sibling `config.auth.bcryptCost`, passed in by `src/cli.ts` like every other config value it already threads through. | **[P2]** Measured: `bcrypt.compare` against a cost-12 hash takes ~194 ms and against a cost-4 hash ~0.8 ms, versus ~48 ms for cost-10 (the dummy hash's cost and the API's own write cost) — this **is** the SEC-07 residual TECH_DEBT names, reproduced exactly. Rehashing on a *successful* login (never on a failed one, and never awaited before the response — fire-and-forget after `session()` resolves) converges every *active* account to the configured cost over time, without adding a single millisecond to any response, so F1's timing invariant is untouched. | The residual isn't eliminated for a **dormant** account (one that never logs in again after being seeded at another cost) or for a **wrong-password attempt** against a mixed-cost account before its first successful login (bcrypt must run at the *stored* hash's own cost to compare at all — there is no way to compare a password against a cost-12 hash in cost-10 time without the hash itself changing first, which requires the correct password). This residual is stated, not hidden, exactly as TECH_DEBT already scopes it ("only seeded or imported data; the API writes cost 10"). |
| **ADR-036** | **Google sign-in: `email_verified` is required; no account is ever created with a placeholder password; a Google-verified email that matches an *existing, non-Google* account is refused, not silently linked.** `password` becomes required only for non-Google accounts (`required: function() { return !this.google; }`); a fresh Google-only account has no `password` field at all. Every Google-sign-in failure — an unverified email, an invalid token, an inactive account, or a match against an existing password account — answers the **same** generic 401 (reusing `invalidCredentials()`), so no branch is distinguishable from the response. | TECH_DEBT SEC-12 lists three defects: the `email_verified` gap (open), the placeholder password (open), and "reports every failure (including DB errors) as invalid token," which cites the deleted `controllers/auth.js`; the **current** `auth.service.ts`'s `try/catch` already scopes narrowly around `google.verify()` only, so a `User.findOne`/`create` failure already propagates as a 500, not a swallowed 401 — that sub-issue is **already fixed** by the M3 rewrite (T3.4) and this design only confirms it, it does not re-fix it. | See Owner Question 1 for the account-linking rule itself (this ADR states the *safe default*, not the final word — the owner may prefer a different one). |
| **ADR-037** | **The auth rate limiter runs two independent `express-rate-limit` instances on `POST /api/auth/login`: the existing per-IP budget (unchanged, C9-keyed) and a new per-account budget keyed on the DTO-normalized email (trim+lowercase), same numbers (10/15 min).** Both use `express-rate-limit`'s built-in in-memory `MemoryStore` — the same store class the per-IP limiter already uses today, so **no new dependency**. `POST /api/auth/google` keeps only the per-IP budget: extracting an email for a per-account key would require verifying the Google ID token *before* rate-limiting, doubling Google API calls per request for a benefit Google's own token-issuance gate already provides. A request with no identifiable email (a malformed body) falls into one shared `'no-email'` per-account bucket. | Closes the SEC-06 gap the brief calls out explicitly: an attacker who rotates IPs against **one** account is now capped regardless of how many IPs they use. The brief's constraint #7 explicitly defers the multi-instance store question to M9 "unless you justify otherwise" — this design does not justify pulling it in: `express-rate-limit`'s pluggable `Store` interface makes a future swap (e.g., a Redis store) a contained, additive change, and no client-visible contract depends on which store backs it. | A horizontally-scaled deployment's budgets are still per-instance (unchanged limitation, SEC-06's other half, M9). The `'no-email'` shared bucket is a stated, low-severity trade-off: many different malformed-body requests compete for one bucket; the per-IP budget is the primary defence for that case and is unaffected. |

---

## 2. Contract changes for 3.0.0

M5 ships inside the same 3.0.0 release as M3/M4 (ADR-024/026): no new version number, and every change below lands on `next` before the M6 close.

### 2.1 Per-route table (extends the M3 §6 / M4 §11 table)

| # | Method | Path | Auth | Request DTO | Success | Failure | Notes |
|---|---|---|---|---|---|---|---|
| 2 | POST | `/api/auth/login` | none; rate-limited **10/15min/IP _and_ 10/15min/account** (ADR-037) | `{ email, password }` (unchanged) | 200 `{ data: { token, user } }` — `token` now carries `iss`/`aud`/`tv` | 401 generic (F1, unchanged); 422; **429** (either budget) | Async compare (ADR-035); a stored hash of another cost is silently rehashed after success. |
| 3 | POST | `/api/auth/google` | none; rate-limited 10/15min/IP only (ADR-037) | `{ id_token }` (unchanged) | 200 `{ data: { token, user } }` | 401 generic — now also for an unverified email or a match against an existing password account (ADR-036); 422; 429 | A first sign-in creates a **passwordless** Google account (no `':D'`). |
| **24** | **POST** | **`/api/auth/logout-all`** | Bearer/x-token (self) | none | **204** No Content | 401 | Bumps `tokenVersion`; every token this user holds, including the one used here, stops verifying immediately. |
| **25** | **PUT** | **`/api/auth/password`** | Bearer/x-token (self) | `{ currentPassword, newPassword }` | 200 `{ data: { token } }` — a **fresh** token, so the caller isn't logged out by their own action | 401 generic (F1 extended, ADR-035); 422 (policy); 429 unthrottled — see §4.2 rationale | Bumps `tokenVersion`; every *other* previously-issued token stops verifying. |

Every other route (`#4`–`#23`) is unchanged by M5: `authenticate` still runs first in each chain, only its internals change (Bearer/x-token, `tokenVersion`).

### 2.2 Breaking changes (CHANGELOG, `### M5: Authentication hardening (on next)`)

**Breaking**
- **All tokens issued before M5 stop verifying**, on *either* transport. **[P1]** confirmed: the new `iss`/`aud` check rejects a token that lacks them, so this is not a hypothetical. Recovery: the client's next authenticated request gets a plain 401 (the same shape as any other invalid token — no special "please re-login" body, consistent with C4/F1's "one generic failure" spirit); it must call `POST /api/auth/login` or `/google` again.
- **`Authorization: Bearer <token>` is now the primary transport.** `x-token` is still read, but only when no `Authorization` header is present at all (ADR-032); a request carrying `x-token` gets a `Deprecation: true` response header. `x-token` support is removed at 4.0.0 (ADR-010/024).
- **`SECRET_KEY` must be at least 32 characters.** A shorter value now fails to boot (`ConfigError`), whatever environment it is set in. This is a deploy-time gate, not a runtime one.
- **`PUT /api/user/:id` and `POST /api/user`'s password field is unchanged in shape**, but a password now rejects one whose UTF-8 byte length exceeds 72 (SEC-16) — previously accepted and silently truncated by bcrypt.
- **A Google sign-in for an email that already has a password (non-Google) account is now refused** (401, generic), where before it silently signed the caller into that account (SEC-12). This is a deliberate security fix with a real UX cost — see Owner Question 1.

**Added**
- `POST /api/auth/logout-all`, `PUT /api/auth/password` (§2.1).
- `Deprecation`/optionally `Sunset` response headers on any `x-token`-authenticated request.

**Changed**
- Password hashing is asynchronous throughout (no observable API change; PERF-01 is an internal fix).
- A stored password hash of a cost other than `config.auth.bcryptCost` is silently rehashed on the next successful login (no observable API change beyond the stored hash itself).

**Security**
- Google sign-in requires `email_verified`; a new Google account never stores a placeholder password.
- The auth surface is now rate-limited per account as well as per IP (ADR-037).

### 2.3 API_PROGRESS.md ledger rows

Update rows #2/#3's **Issues**/**Status**/**Target** columns to `— | 🟢 | —` (PERF-01, SEC-11, SEC-12 close). Add:

| # | Method | Path | Auth | Request DTO (zod, 422 on failure) | Success | Issues | Status | Target |
|---|---|---|---|---|---|---|---|---|
| 24 | POST | `/api/auth/logout-all` | Bearer/x-token | — | **204** | — | 🟢 | — |
| 25 | PUT | `/api/auth/password` | Bearer/x-token | `{ currentPassword, newPassword (policy) }` | 200 `{ data: { token } }` | — | 🟢 | — |

Breaking-change ledger: add the four Breaking bullets from §2.2, worded for the ledger's terse style (as M3/M4's rows were).

---

## 3. Signatures and sketches

### 3.1 `src/core/security/jwt.ts` — `TokenService`

```ts
export interface TokenClaims {
  readonly uid: string;
  readonly tokenVersion: number;
}

export interface TokenService {
  sign(claims: TokenClaims): Promise<string>;
  /** Throws when the token is malformed, expired, wrongly signed, or fails alg/iss/aud (ADR-034). */
  verify(token: string): TokenClaims;
}

export interface TokenServiceOptions {
  readonly ttl: string; // e.g. '4h' or a plain integer (seconds); validated at boot (config)
}

const ISSUER = 'backed-rest-server';
const AUDIENCE = 'backed-rest-server-clients';

export function createTokenService(secret: string, { ttl }: TokenServiceOptions): TokenService {
  return {
    sign: ({ uid, tokenVersion }) =>
      new Promise((resolve, reject) => {
        jwt.sign(
          { uid, tv: tokenVersion },
          secret,
          { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, expiresIn: ttl },
          (error, token) => (error ? reject(error) : token === undefined ? reject(new Error('jsonwebtoken returned no token')) : resolve(token)),
        );
      }),
    verify(token) {
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
      if (typeof payload === 'string' || typeof payload.uid !== 'string' || typeof payload.tv !== 'number') {
        throw new jwt.JsonWebTokenError('jwt payload has no uid/tv');
      }
      return { uid: payload.uid, tokenVersion: payload.tv };
    },
  };
}
```
`uid` keeps its existing name (not renamed to the JWT-standard `sub`) — minimizing churn against every test and comment that already says "uid," a deliberate decision, not an oversight.

### 3.2 `src/middlewares/authenticate.ts`

```ts
interface LookupUser {
  _id: unknown;
  role: string;
  state: boolean;
  name: string;
  tokenVersion: number; // hydrated Mongoose reads apply the schema default (0) even if absent on disk — [P3]
}
export interface UserLookup {
  findById(id: string): PromiseLike<LookupUser | null>;
}

/** Bearer first; x-token only if Authorization is entirely absent (ADR-032). A malformed Authorization
 *  header is 401 immediately — it never falls through to x-token. */
function extractToken(req: Request, res: Response): string | null {
  const header = req.header('authorization');
  if (header !== undefined) {
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' && token ? token : null; // present-but-malformed -> null -> 401, no x-token fallback
  }
  const legacy = req.header('x-token');
  if (legacy) {
    res.setHeader('Deprecation', 'true'); // RFC 9745; Sunset added once a 4.0.0 date exists
    return legacy;
  }
  return null;
}

export const authenticate =
  (deps: { tokens: TokenService; users: UserLookup }): RequestHandler =>
  async (req, res, next) => {
    const header = extractToken(req, res);
    if (!header) throw new UnauthorizedError('No token in the request');
    let claims: TokenClaims;
    try {
      claims = deps.tokens.verify(header);
    } catch (err) {
      req.log.debug({ err }, 'token rejected');
      throw new UnauthorizedError('Invalid token');
    }
    const user = await deps.users.findById(claims.uid);
    // ADR-033: a tokenVersion mismatch is the SAME generic 401 as any other invalid token — never distinguishable.
    if (!user || !user.state || user.tokenVersion !== claims.tokenVersion) throw new UnauthorizedError('Invalid token');
    req.user = { id: String(user._id), role: user.role, name: user.name, state: user.state };
    next();
  };
```
`UserLookup.findById`'s caller in `app.ts` is unchanged (`UserModel.findById(id)`, a hydrated read) — **[P3]** confirmed this applies the schema's `tokenVersion` default even when a raw document on disk lacks the field, so no `?? 0` defensive read is strictly required in the real path; M005 (§4) backfills it anyway, for any code that ever reads with `.lean()`.

### 3.3 `src/core/security/password.ts` (new) — the hashing module

```ts
export interface PasswordPolicyOptions {
  readonly minLength?: number; // default 8, unchanged
}

// SEC-16: bcrypt only ever looks at the first 72 BYTES (UTF-8), not characters — [P4] measured directly:
// two passwords sharing a 72-byte prefix hash identically, and a 20-emoji string is 80 bytes at only 40 UTF-16
// code units, so byte length, not .length, is the only correct measure.
export const passwordPolicy = (opts: PasswordPolicyOptions = {}) =>
  z
    .string()
    .min(opts.minLength ?? 8)
    .max(256) // a sane form-input bound, unrelated to the 72-byte bcrypt boundary below
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
      message: 'must be at most 72 bytes (bcrypt only uses the first 72)',
    });

const BCRYPT_HASH = /^\$2[ab]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/; // unchanged from auth.service.ts

export const isUsableHash = (hash: string | undefined | null): hash is string =>
  typeof hash === 'string' && BCRYPT_HASH.test(hash);

export const costOf = (hash: string): number => Number(hash.split('$')[2]);

export async function hashPassword(password: string, cost: number): Promise<string> {
  return bcrypt.hash(password, cost); // PERF-01: async everywhere
}

/** F1-preserving compare: always exactly one bcrypt call, real hash or a cost-matched dummy. */
export async function comparePassword(password: string, hash: string | undefined | null, dummy: string): Promise<boolean> {
  return bcrypt.compare(password, isUsableHash(hash) ? hash : dummy);
}

export const needsRehash = (hash: string, cost: number): boolean => costOf(hash) !== cost;
```
`user.service.ts`'s `create`/`update` and `auth.service.ts`'s login/password-change all import this module instead of calling `bcrypt` directly or hardcoding `BCRYPT_ROUNDS = 10`.

### 3.4 `src/modules/auth/auth.service.ts` — the extended shape

```ts
export interface AuthService {
  login(dto: LoginDto): Promise<Session>;
  googleSignIn(dto: GoogleDto): Promise<Session>;
  logoutAll(uid: string): Promise<void>;
  changePassword(uid: string, dto: PasswordChangeDto): Promise<Session>;
}

export function createAuthService(deps: {
  User: SignInUserModel; // gains bumpTokenVersion + a password-bearing update
  tokens: TokenService;
  google: GoogleVerifier;
  bcryptCost: number;
}): AuthService {
  const dummyHashPromise = hashPassword('dummy-password', deps.bcryptCost); // computed once, at the configured cost
  const invalidCredentials = () => new UnauthorizedError('Invalid credentials');
  const session = async (user: SignInUser): Promise<Session> => ({
    token: await deps.tokens.sign({ uid: String(user._id), tokenVersion: user.tokenVersion }),
    user,
  });

  return {
    async login({ email, password }) {
      const user = await deps.User.findOne({ email }, '+password');
      const dummy = await dummyHashPromise;
      const valid = await comparePassword(password, user?.password, dummy);
      if (!user || !user.state || !valid) throw invalidCredentials();
      if (isUsableHash(user.password) && needsRehash(user.password, deps.bcryptCost)) {
        void hashPassword(password, deps.bcryptCost).then((newHash) =>
          deps.User.updateOne({ _id: user._id }, { password: newHash }),
        ); // fire-and-forget, after the compare decided the outcome — never affects this response's timing
      }
      return session(user);
    },

    async googleSignIn({ id_token }) {
      let profile: GoogleProfile;
      try {
        profile = await deps.google.verify(id_token);
      } catch {
        throw invalidCredentials();
      }
      if (!profile.email_verified) throw invalidCredentials(); // ADR-036
      const email = profile.email?.trim().toLowerCase();
      const existing = await deps.User.findOne({ email });
      if (existing && !existing.google) throw invalidCredentials(); // ADR-036: no silent link
      const user = existing ?? (await deps.User.create({ name: profile.name, email, image: profile.picture, google: true })); // no password field at all
      if (!user.state) throw invalidCredentials();
      return session(user);
    },

    async logoutAll(uid) {
      await deps.User.bumpTokenVersion(uid); // $inc: { tokenVersion: 1 }
    },

    async changePassword(uid, { currentPassword, newPassword }) {
      const user = await deps.User.findById(uid, '+password'); // the same '+password' shape as login
      const dummy = await dummyHashPromise;
      const valid = await comparePassword(currentPassword, user?.password, dummy); // F1 extended (brief #1)
      if (!user || !valid) throw new UnauthorizedError('Current password is incorrect');
      const newHash = await hashPassword(newPassword, deps.bcryptCost);
      const updated = await deps.User.bumpTokenVersionAndSetPassword(uid, newHash); // one atomic update
      return session(updated); // a FRESH token, at the NEW tokenVersion, so the caller isn't logged out
    },
  };
}
```
`SignInUserModel` gains `findById`, `bumpTokenVersion` and `bumpTokenVersionAndSetPassword` — all narrow, injected, satisfied by `UserModel` without a cast, matching the existing `SignInUserModel` pattern (ADR-005, §2.3 rule 4: `src/modules/auth` still never imports `src/modules/users`).

### 3.5 `src/modules/auth/auth.routes.ts` — the two limiters and the two new routes

```ts
const ipLimiter = rateLimit({ windowMs: WINDOW_MS, limit: LIMIT, standardHeaders: 'draft-7', legacyHeaders: false, handler });
const normalizeForKey = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');
const accountLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
  keyGenerator: (req) => normalizeForKey(req.body?.email) || 'no-email', // ADR-037; runs before validate, like ipLimiter
});

router.post('/login', ipLimiter, accountLimiter, validate('body', loginBody), controller.login);
router.post('/google', ipLimiter, validate('body', googleBody), controller.googleSignIn); // no accountLimiter (ADR-037)
router.post('/logout-all', authenticate, controller.logoutAll);
router.put('/password', authenticate, validate('body', passwordChangeBody), controller.changePassword);
```
`authenticate` is injected into `AuthRouteDeps` for the first time (the auth module previously needed no guard on its own routes) — a small, deliberate widening of `authModule`'s dependencies, alongside `bcryptCost`.

### 3.6 `src/config` additions

```ts
// env.ts
SECRET_KEY: z.string().min(32, 'must be at least 32 characters (256 bits) for HS256'), // was .min(1)
JWT_TTL: z.string().regex(/^\d+[smhd]?$/, 'must be a plain integer (seconds) or <n>[smhd]').default('4h'),
BCRYPT_COST: z.coerce.number().int().min(10).max(14).default(10), // PERF-01; 10 keeps today's behaviour
```
```ts
// index.ts — Config gains:
auth: { jwtSecret: string; googleClientId: string; jwtTtl: string; bcryptCost: number };
```

### 3.7 `src/app.ts` wiring (illustrative diff)

```ts
const tokens = createTokenService(config.auth.jwtSecret, { ttl: config.auth.jwtTtl });
...
app.use('/api/auth', authModule({ User: UserModel, tokens, googleClientId: config.auth.googleClientId, authenticate: auth, bcryptCost: config.auth.bcryptCost }));
app.use('/api/user', usersModule({ authenticate: auth, bcryptCost: config.auth.bcryptCost }));
```

---

## 4. Data: migrations M005, M006

Both follow the M4 runner exactly (`src/database/migrations/M00N-*.ts`, `up`/`down`, the `Migration` interface); `src/cli.ts` appends both to `MIGRATIONS` after M004.

### 4.1 `M005-backfill-token-version`

No abort check is needed — this is purely additive, like M003 (backfill-created-at), and cannot conflict with any existing data.

```ts
export const M005: Migration = {
  id: 'M005-backfill-token-version',
  async up(db, log) {
    // [P3]: a hydrated Mongoose read already defaults a missing tokenVersion to 0, so this migration is
    // defence-in-depth for any raw-driver or .lean() read, not a correctness requirement of the app today.
    const { modifiedCount } = await db.collection('users').updateMany(
      { tokenVersion: { $exists: false } },
      { $set: { tokenVersion: 0 } },
    );
    log.info({ modified: modifiedCount }, 'M005: tokenVersion backfilled to 0 where absent');
  },
  async down(db, log) {
    // Exact and safe: only removes what this migration itself would have set, on documents that still show 0.
    // A document whose tokenVersion has since been bumped by a real logout-all/password-change keeps its value.
    await db.collection('users').updateMany({ tokenVersion: 0 }, { $unset: { tokenVersion: '' } });
    log.warn('M005 down: tokenVersion unset on documents left at 0 (a real bump since up is not reverted)');
  },
};
```

### 4.2 `M006-drop-google-placeholder-password`

```ts
export const M006: Migration = {
  id: 'M006-drop-google-placeholder-password',
  async up(db, log) {
    // No abort check: the filter is exact ({ google: true, password: ':D' }), so a hybrid account that already
    // has a real bcrypt hash never matches, and nothing ambiguous can be dropped.
    const { modifiedCount } = await db.collection('users').updateMany(
      { google: true, password: ':D' },
      { $unset: { password: '' } },
    );
    log.info({ modified: modifiedCount }, 'M006: the \':D\' placeholder removed from Google-only accounts');
  },
  async down(db, log) {
    // Best-effort, like M001's lossy down: restores the placeholder on every Google account that currently has
    // no password, on the assumption that this migration is what removed it (true unless a later, unrelated
    // change also produced a passwordless Google account — negligible before M006 exists).
    await db.collection('users').updateMany(
      { google: true, password: { $exists: false } },
      { $set: { password: ':D' } },
    );
    log.warn('M006 down: the \':D\' placeholder restored on every passwordless Google account');
  },
};
```
Order: **M005 before M006** — both are independent of each other's data, but M005's id sorts first and there is no reason to reorder.

---

## 5. Test strategy

### 5.1 Re-expressed or kept invariants

| Invariant | Disposition |
|---|---|
| **F1** (one generic 401, flat cost, per credential failure) | **Kept**, and its vehicle changes from `bcrypt.compareSync` to `bcrypt.compare` (async) — the existing timing test (T3.4's method: interleaved rounds, median comparison) is rerun and must still show ratio ≈1. **Extended**: a new timing test covers `PUT /api/auth/password`'s wrong-current-password path (real hash vs Google-only account, both against a dummy of the *configured* cost). |
| **C4** (`authenticate`'s 401 semantics) | **Re-expressed**: every existing "no token" / "invalid token" test gains a Bearer-header variant alongside the `x-token` one; a `tokenVersion` mismatch is a **new** case asserting the same message/body as a malformed token. |
| **C5** (the shared budget, the 429 envelope) | **Kept** for the per-IP budget (unchanged code path). **Extended**: a new per-account budget test (§5.2) using the *same* 429 body, so a client cannot tell which budget it hit. |
| **C9** (proxy-trust keying) | **Kept**, unchanged — `req.ip` resolution doesn't change; only the *number* of limiters keyed off it changes (still one, the IP one; the account one keys on the body, not the IP). |
| **SEC-07** (the enumeration equality test, "unknown/disabled/wrong-password share status and body") | **Kept verbatim** as the primary test. Its "one cost-10 bcrypt comparison" sub-assertion becomes "one comparison at the configured cost," parameterized by `config.auth.bcryptCost` rather than hardcoded 10. **New**: a rehash-on-login test proving a cost-12 seeded account's *second* login (after the first success rehashes it) now times identically to a cost-10 account, while the *first* login (pre-rehash) is allowed to differ — stating the residual precisely, not hiding it. |

### 5.2 New adversarial tests (the brief's list, plus the ones this design's own decisions require)

- **Token replay after logout-all:** mint a token, call `logout-all`, replay the old token against any protected route → 401, same body as a malformed token.
- **Alg confusion:** hand-craft an HS384-signed token with the real secret, and an unsigned (`alg:none`) token → both 401. **[P1]** already confirms the mechanism; the test pins it in the suite.
- **`aud`/`iss` mismatch:** a token signed with the right secret but a foreign `aud` or `iss` → 401.
- **`x-token`/Bearer precedence:** both headers present, `x-token` invalid and `Authorization: Bearer` valid → 200 (Bearer wins, no `Deprecation` header); both present, Bearer malformed (e.g. `Authorization: Basic xyz`) and `x-token` valid → 401 (no x-token fallback, per ADR-032) — a deliberately strict, testable rule.
- **Per-account limiter bypass by case or padding:** 10 failed logins as `Ada@Example.com`, then one as ` ADA@EXAMPLE.COM ` → 429 (same account bucket; the keyGenerator normalizes independently of the DTO, proven by hitting the limiter *before* validation would even run).
- **72-byte truncation:** two passwords sharing a 72-byte prefix are rejected at sign-up/password-change with **422** before either ever reaches bcrypt (the DTO catches it, so the truncation-collision **[P4]** never has a chance to occur in this API); a request that tries to *authenticate* with the truncated-equivalent tail (bypassing sign-up validation via a direct DB fixture, simulating pre-M5 data) still gets the generic 401 — the residual is closed for new writes, not retroactively for data that predates the policy.
- **Old M4 token rejected:** a token minted with the pre-M5 `createTokenService(secret)` shape (no `iss`/`aud`) is rejected by the new `verify` — **[P1]**'s exact reproduction, pinned as a regression test.
- **Google account-linking refusal:** a Google-verified profile whose email matches an existing password account → 401, and the existing account is untouched (no fields changed, no login granted).
- **`email_verified: false`** → 401, `User.findOne`/`create` never called (mockable assertion, mirrors the existing "Google failure creates nothing" pattern).
- **Boot gate:** `SECRET_KEY` of 31 characters → `ConfigError` naming the variable, never its value (P20's existing invariant, extended to the new min-length rule).

### 5.3 Coverage

No coverage regression expected: every new branch (transport precedence, tokenVersion check, rehash, Google-linking refusal, the two new endpoints, the two migrations) is directly testable without mocks beyond the existing `stubGoogleClient` pattern. The `src/**` gate (90/90/80/90) stays the bar; `core/security/{jwt,password}.ts` and `src/modules/auth/**` are expected at ≥98%, matching M4's own auth-adjacent files.

---

## 6. Task breakdown

Integration branch **`m5/auth`**, cut from `next` @ `01be022`. P-numbers continue from **P21**.

**Shared contracts:**
- **P21** — `TokenService.sign`/`verify` take/return `{ uid, tokenVersion }`; HS256 pinned on both ends; `iss`/`aud` are fixed code constants, never environment-configurable.
- **P22** — `authenticate` reads `Authorization: Bearer` first; `x-token` only when `Authorization` is entirely absent; a present-but-malformed `Authorization` header is 401 and never falls back to `x-token`; every `x-token` use sets `Deprecation: true`.
- **P23** — a `tokenVersion` mismatch is the same generic 401 as any other invalid token — never a distinguishable message, status, or body shape.
- **P24** — every password hash/compare in `src` goes through `core/security/password.ts`; no direct `bcrypt.hashSync`/`compareSync` call remains anywhere.
- **P25** — a login's rehash (when the stored hash's cost ≠ `config.auth.bcryptCost`) happens strictly after the compare has decided the outcome, and is never awaited before the response.
- **P26** — every password DTO (sign-up, self-update, password-change) uses the shared `passwordPolicy`, so the 72-byte bcrypt boundary is enforced identically everywhere a password is ever set.
- **P27** — every Google-sign-in failure path (unverified email, invalid token, inactive account, existing-non-Google-account match) answers through the same `invalidCredentials()` call — one body, one status, everywhere.
- **P28** — the per-account rate limiter's key is computed independently of `validate`, using the same normalization (trim+lowercase) the DTO applies, so it cannot be bypassed by case or padding before validation runs.

| Task | Agent | Files allowed | Forbidden | Required | Acceptance | Commits |
|---|---|---|---|---|---|---|
| **T5.1 core transport & tokens (GATE)** | BACKEND | `src/core/security/jwt.ts`, `src/middlewares/authenticate.ts`, `src/config/{env,index}.ts`, `src/app.ts` (token/authenticate wiring only), `.example.env`, `tests/unit/{jwt,authenticate,config}.test.ts` | `src/modules/auth/**`, `src/modules/users/**`, `src/core/security/password.ts` (new, T5.2's), `src/database/**` | §3.1–§3.2, §3.6 exactly: `{uid,tv}` claims, HS256+iss+aud pinned on verify, configurable TTL, `SECRET_KEY` ≥32, `tokenVersion` added to `LookupUser`/`UserLookup`, Bearer/x-token precedence (P22) with the deprecation header. | typecheck/lint/format/build green; `jwt.test.ts` proves alg/iss/aud pinning **[P1]**-style and old-M4-token rejection; `authenticate.test.ts` proves precedence (P22) and the tokenVersion check (P23) with a fake `UserLookup`; `config.test.ts` proves the 32-char boot gate; full suite green (every existing authenticated-route test still passes once its fixture mints a Bearer or an `x-token` with the new claims — a mechanical, one-line-per-test-file fixture change, not a logic change). | `feat(auth): Bearer transport, HS256+iss+aud, tokenVersion check (ADR-032/033/034)` |
| **T5.2 passwords, Google, rate limits, new endpoints** | SECURITY & QA | `src/core/security/password.ts` (new), `src/modules/auth/**`, `src/modules/users/{user.model,user.schemas,user.service}.ts` (password policy + hashing module only — no other field changes), `src/app.ts` (auth/users module wiring, additive lines after T5.1 merges), `tests/integration/security/{auth,rate-limit,normalization}.test.ts`, `tests/integration/modules/auth.test.ts`, `tests/unit/modules/{auth.service,google.client,user.service,user.model}.test.ts`, `tests/unit/core/password.test.ts` (new) | `src/core/security/jwt.ts`, `src/middlewares/authenticate.ts`, `src/config/**`, `src/database/**` | §3.3–§3.5, §4's *consumers* (not the migrations themselves): async hashing (P24), rehash-on-login (P25), the 72-byte policy (P26), Google hardening (P27), the two-limiter split (P28), the two new endpoints (§2.1 #24/#25) with F1 extended to `PUT /api/auth/password` per the brief's constraint #1. | typecheck/lint/format/build green; every §5.2 adversarial test passes, including the timing tests (ratio ≈1, both for login and for password-change); mutation-style check that `bcrypt.compareSync`/`hashSync` has zero remaining call sites in `src`; full suite green; layer lint clean (the auth module still imports no sibling module). | `feat(auth): async password hashing, rehash-on-login (ADR-035, PERF-01, SEC-07)`; `feat(auth): Google email_verified, no placeholder, no silent linking (ADR-036, SEC-12)`; `feat(auth): per-account rate limit, logout-all, password change (ADR-037)` |
| **T5.3 migrations** | DATABASE AGENT | `src/database/migrations/M005-backfill-token-version.ts` (new), `src/database/migrations/M006-drop-google-placeholder-password.ts` (new), `src/cli.ts` (append both to `MIGRATIONS`, two lines), `tests/integration/database/migrations.test.ts` (add cases) | everything else | §4.1–§4.2 **exactly as specified** — the filters, the `$set`/`$unset` shapes, and the down-migration's stated best-effort semantics are not to be altered; this is a mechanical, precisely-specified task with no design judgement left to make. | `pnpm test` includes: M005 backfills `tokenVersion:0` only where absent (a raw-inserted fixture proves it), a second run is a no-op; M006 unsets `password` only on the exact `{google:true, password:':D'}` shape (a hybrid-account fixture with a real hash is untouched), a second run is a no-op; both `down`s behave exactly as documented; `migrate status` after `up` shows M001–M006 all applied, in order; full suite green. | `feat(db): M005 tokenVersion backfill, M006 drop the Google placeholder password` |
| **T5.4 final review** | ARCHITECT | — (read-only) | — | Adversarial review vs this design + P21–P28; re-run C1–C11/SEC and F1/C4/C5/C9/SEC-07; every §5.2 adversarial case; the deploy-time `SECRET_KEY` gate; cold frozen install; contract-impact ledger. | ACCEPT/RETURN per task; findings + reproduction; docs-for-close list. | — |

**Dependency sequence:** `T5.1` (**GATE** — reviewed before T5.2 starts, exactly as T4.1/T4.2 gated T4.3) → `T5.2`, while `T5.3` runs **in parallel with T5.1 from the start** (the migrations touch neither the token service nor `authenticate`, and have no dependency on either) → `T5.4` waits for both `T5.2` and `T5.3`.

**Shared edit surface:** `src/app.ts` — T5.1 lands the token/authenticate wiring first (before T5.2 starts, since T5.2 is gated on T5.1's merge), so T5.2's additive lines (`authenticate`/`bcryptCost` into `authModule`/`usersModule`) land on an already-settled file, mirroring how M3/M4 sequenced their own one-line `app.ts` contention. `src/cli.ts` is touched only by T5.3 (two appended lines); no other task touches it.

**Revert units:** each task's commit(s) are independent revert units, as in M3/M4. T5.3's migrations are **data** revert units via `down` (run `pnpm migrate down` for M006 then M005 before reverting the code that defines them, mirroring M4's §7.4 pattern). Reverting the whole M5 merge on `next` is the milestone-level rollback (ADR-026) and leaves `master`/2.x untouched; because M5 invalidates every session regardless of whether it stays or is reverted (both directions force a re-login once deployed), a revert carries no *additional* session cost beyond the one M5 itself already causes.

---

## 7. Risks and rollback

| Risk | Task | Mitigation / rollback |
|---|---|---|
| **Every existing session dies the moment M5 deploys.** | T5.1 | Stated as the headline breaking change (§2.2); no mitigation removes it (it is the point of `iss`/`aud`/`tv`). Document it in the deploy runbook exactly like M4's §7.1 step 0: warn users/clients ahead of the deploy window. |
| **A `SECRET_KEY` under 32 characters now refuses to boot.** | T5.1 | A one-time, pre-deploy operator action: rotate/lengthen `SECRET_KEY` **before** deploying M5. Since all sessions invalidate anyway, rotating the secret at the same moment costs nothing extra. Add this as a runbook step, the same way M4's OPS-05/§7.1 pattern documents a pre-deploy gate. |
| **`x-token` clients silently keep sending old, now-invalid tokens** and see a generic 401 with no explanation. | T5.1 | The `Deprecation` header nudges any client that inspects it; the 401 body itself carries no more detail than any other invalid-token case (by design, C4). A CHANGELOG/API_PROGRESS note is the operator-facing warning; there is no server-side way to explain "your token is simply too old" without adding a distinguishable error, which this design deliberately avoids (C4 consistency over developer convenience). |
| **The per-account rate limiter's `'no-email'` shared bucket** lets many different malformed-body requests exhaust one bucket for each other. | T5.2 | Accepted, low-severity (§1, ADR-037): the per-IP budget is the primary defence for that case and is unaffected; a legitimate client sends a well-formed body and gets its own per-account bucket. |
| **A dormant, differently-costed account never rehashes** (SEC-07 residual persists indefinitely for an account that never logs in again). | T5.2 | Accepted and stated (ADR-035); the API itself never *creates* a new instance of this residual (every write goes through `config.auth.bcryptCost`). A bulk-rehash-by-admin tool is out of scope (no plaintext to rehash with). |
| **M006's `down` restores `':D'` on a passwordless Google account that wasn't actually created by M006.** | T5.3 | Stated as a best-effort limitation (§4.2, mirroring M001's own lossy-down precedent); the window is only between M006 first running and any *subsequent, unrelated* change producing a passwordless Google account — negligible before M006 exists, and the migration ledger makes the ordering auditable. |
| **A client that reads `req.user` expects no shape change** but the server-internal `LookupUser` gained `tokenVersion` (T5.1). | T5.1 | `tokenVersion` is never added to `req.user`/`AuthUser` (the client-visible shape) — it stays a server-internal comparison inside `authenticate`, never serialized. No client-visible risk. |
| **T5.1's `app.ts` wiring and T5.2's additive lines collide** if run out of order. | T5.1/T5.2 | The dependency sequence (§6) makes this structurally impossible: T5.2 cannot start until T5.1's gate is reviewed and merged. |
| **A production deploy runs the new code before `pnpm migrate up` (M005/M006).** | T5.3 | Low impact either way: M005 is pure defence-in-depth (§3.2/§4.1 already shows the app tolerates its absence via Mongoose's own default); M006's absence just means old Google accounts keep a harmless, already-non-authenticating `':D'` value a little longer. Neither is an OPS-05-style hard gate like M4's email-casing hazard — no ordering requirement is added to the runbook beyond "run migrations as usual." |

---

## 8. Owner questions

1. **The account-linking rule (ADR-036).** This design's default is: **refuse** a Google sign-in whose verified email matches an existing, non-Google account (generic 401; the existing account is untouched). This closes SEC-12's silent-auto-link danger completely, but means a user who signed up with a password and later tries "Sign in with Google" using the same address is turned away with no path forward except logging in with their password (a real, if narrow, UX cost). **Alternative:** build a dedicated, authenticated "link my Google account" endpoint (out of scope for M5; a small follow-up task) — until it exists, the refuse-by-default rule is the only safe option that isn't a silent merge. **Recommendation: accept the default (refuse); schedule the linking endpoint as a small M5.1/M6-adjacent follow-up if product wants the convenience back.**
2. **`JWT_TTL` default.** This design keeps the current 4-hour default unchanged, only making it configurable. **Recommendation: keep 4h**; there is no signal (from TECH_DEBT or ROADMAP) that today's session length is a problem, and shortening it purely for "hardening's" sake would increase re-login frequency for every client with no stated threat it defends against.
3. **`BCRYPT_COST` default and ceiling.** This design defaults to `10` (unchanged from today) with a `min(10)`/`max(14)` boot-time range. **Recommendation: keep 10 as the default**; raising it is an operational, measured decision (it directly trades login latency for brute-force cost) better made with real traffic data, not baked into this design. The range exists only to catch a fat-fingered config value (e.g., `31`, which would make every login take seconds) at boot, not to imply 14 is recommended.
4. **`logout-all` semantics: everyone, or everyone-else?** This design bumps `tokenVersion` unconditionally, which also logs out the very request that called it (there is no per-session exception without a session store, which is out of scope, §0). **Recommendation: accept this** — it matches the endpoint's literal name ("logout-**all**," not "logout-others"), and `PUT /api/auth/password` already covers the "stay logged in on this device" case by minting a fresh token in its own response.
5. **Whether to rate-limit `PUT /api/auth/password`.** This design leaves it unthrottled (§2.1, §6's acceptance notes why: a caller already holds a valid Bearer token, so guessing their own current password gains an attacker nothing they don't already have via the stolen token itself). **Recommendation: leave unthrottled for M5**; revisit only if telemetry (M9-era observability) shows abuse.

---

## 9. Orchestrator rulings on D5 (AM-M5-1…7, binding; override the text they name)

The owner delegated decisions to the Orchestrator ("toma las mejores decisiones"). Each owner question below takes the design's recommended default and stays **reversible**; the owner may flip any of them before 3.0.0 ships.

| ID | Question / finding | Ruling |
|---|---|---|
| AM-M5-1 | §8 Q1: Google account linking | **Refuse** a Google sign-in whose verified email matches an existing non-Google account: the generic 401 (P27), and the account is untouched. An authenticated linking endpoint is a later feature, not M5. CHANGELOG **Breaking**, because 2.x silently signed such users in. |
| AM-M5-2 | §8 Q2: `JWT_TTL` default | **4h** (unchanged). |
| AM-M5-3 | §8 Q3: `BCRYPT_COST` | Default **10**, boot range **10–14**. |
| AM-M5-4 | §8 Q4: does logout-all include the caller? | **Yes**: every token of the user is revoked, the caller's included. `PUT /api/auth/password` returns a fresh token for "stay signed in here". |
| AM-M5-5 | §8 Q5: throttle `PUT /api/auth/password`? | **Not in M5.** Revisit with M9 telemetry. Recorded as a TECH_DEBT note. |
| AM-M5-6 | Orchestrator review of the T5.1 row: Files allowed | T5.1 re-signs the test fixtures and must raise the test `SECRET_KEY` to ≥ 32 characters. Its Files allowed also include **`tests/helpers/**`** (`tokenFor` signs `{ uid, tokenVersion }`) and **`tests/setup/**`** (the test env), plus any test file whose **only** change is the token-minting or header fixture. That is a mechanical change, listed per file. |
| AM-M5-7 | Sequencing | As in §6: T5.1 (a **review gate**, "T5.1G", ARCHITECT) runs in parallel with T5.3 from the start; T5.2 starts after the T5.1 merge; T5.4 is the final review. |
