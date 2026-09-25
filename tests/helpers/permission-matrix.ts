// M6 design §2.2, amended by the Orchestrator rulings §11 (AM-M6-1..9). This is the single source of truth
// (AM-M6-6): there is no ROUTE_POLICIES export anywhere in src/ to cross-check against, only this fixture,
// checked against the live app's own registered routes (authorize-matrix.test.ts).
//
// Each row is one route the app registers (one entry per (method, path) pair, no matter how many design-table
// rows share it, e.g. the two search.routes.ts/media.routes.ts collections below). Each case is one HTTP
// request the matrix-driven test fires: `caller` is who asks (no token for 'anonymous'), `owner: true` means the
// caller — of a non-privileged role — is the resource's creator or, for a user account, the account itself.
// `label` disambiguates cases that would otherwise collide (a route dispatched on a URL segment, like
// `:collection`, or a route with two credential outcomes for the same caller).
export type Caller = 'anonymous' | 'USER_ROLE' | 'VENTAS_ROLE' | 'ADMIN_ROLE';
export type Method = 'get' | 'post' | 'put' | 'delete';

export interface MatrixCase {
  caller: Caller;
  status: number;
  owner?: boolean;
  label?: string;
}

export interface MatrixRow {
  /** The design's §2.2 row number (a design-table row split across two `MatrixRow`s, e.g. #19a/#19b, shares a path). */
  id: string;
  method: Method;
  /** Exactly as Express registers it: the mount prefix (see MOUNT_PREFIXES) plus the router's own path. */
  path: string;
  cases: MatrixCase[];
}

/**
 * src/app.ts's app.use() order. AM-M6-6: mount prefixes cannot be read off the live app (Express 5's
 * path-to-regexp v8 layers expose a matcher closure, not a path or regexp string) — the drift check takes them
 * from here and only asserts that the number of mounted routers equals this list's length.
 */
export const MOUNT_PREFIXES = [
  '/api/category',
  '/api/product',
  '/api/search',
  '/api/user',
  '/api/auth',
  '/api/uploads',
] as const;

export const MATRIX: MatrixRow[] = [
  // #2 — anonymous-only (P28's account limiter and C9's IP limiter budget 10 attempts/15 min; mind them).
  {
    id: '#2',
    method: 'post',
    path: '/api/auth/login',
    cases: [
      { caller: 'anonymous', status: 200, label: 'correct credentials' },
      { caller: 'anonymous', status: 401, label: 'wrong credentials' },
    ],
  },
  // #3 — anonymous-only; ADR-036's email_verified gate.
  {
    id: '#3',
    method: 'post',
    path: '/api/auth/google',
    cases: [
      { caller: 'anonymous', status: 200, label: 'verified Google profile' },
      { caller: 'anonymous', status: 401, label: 'unverified Google profile' },
    ],
  },
  {
    id: '#4',
    method: 'get',
    path: '/api/user',
    cases: [
      { caller: 'anonymous', status: 401 },
      { caller: 'USER_ROLE', status: 403 },
      { caller: 'VENTAS_ROLE', status: 403 },
      { caller: 'ADMIN_ROLE', status: 200 },
    ],
  },
  // #5 — public sign-up, unaffected by M6; kept so the fixture's path set matches the live router exactly.
  {
    id: '#5',
    method: 'post',
    path: '/api/user',
    cases: [{ caller: 'anonymous', status: 201 }],
  },
  {
    id: '#6',
    method: 'put',
    path: '/api/user/:id',
    cases: [
      { caller: 'anonymous', status: 401 },
      { caller: 'USER_ROLE', status: 403 },
      { caller: 'VENTAS_ROLE', status: 403 },
      { caller: 'ADMIN_ROLE', status: 200, label: 'any target, a benign field' },
      { caller: 'USER_ROLE', owner: true, status: 200, label: 'self, a benign field' },
    ],
  },
  {
    id: '#7',
    method: 'delete',
    path: '/api/user/:id',
    cases: [
      { caller: 'anonymous', status: 401 },
      { caller: 'USER_ROLE', status: 403 },
      { caller: 'VENTAS_ROLE', status: 403, label: 'breaking: was 204 pre-M6 (ADR-040)' },
      { caller: 'ADMIN_ROLE', status: 204, label: 'a different target, not self' },
    ],
  },
  {
    id: '#9',
    method: 'get',
    path: '/api/category',
    cases: [
      { caller: 'anonymous', status: 200 },
      { caller: 'USER_ROLE', status: 200 },
      { caller: 'VENTAS_ROLE', status: 200 },
      { caller: 'ADMIN_ROLE', status: 200 },
    ],
  },
  {
    id: '#10',
    method: 'get',
    path: '/api/category/:id',
    cases: [
      { caller: 'anonymous', status: 200 },
      { caller: 'USER_ROLE', status: 200 },
      { caller: 'VENTAS_ROLE', status: 200 },
      { caller: 'ADMIN_ROLE', status: 200 },
    ],
  },
  {
    id: '#11',
    method: 'post',
    path: '/api/category',
    cases: [
      { caller: 'anonymous', status: 401 },
      { caller: 'USER_ROLE', status: 201 },
      { caller: 'VENTAS_ROLE', status: 201 },
      { caller: 'ADMIN_ROLE', status: 201 },
    ],
  },
  // #12 — AM-M6-2: categories are a shared taxonomy; no creator ownership (a pure role policy, unlike products).
  {
    id: '#12',
    method: 'put',
    path: '/api/category/:id',
    cases: [
      { caller: 'anonymous', status: 401 },
      { caller: 'USER_ROLE', status: 403 },
      { caller: 'VENTAS_ROLE', status: 200, label: 'any category, additive (ADR-040)' },
      { caller: 'ADMIN_ROLE', status: 200, label: 'any category' },
      {
        caller: 'USER_ROLE',
        owner: true,
        status: 403,
        label: 'AM-M6-2: creator, still 403 — no category ownership',
      },
    ],
  },
  {
    id: '#13',
    method: 'delete',
    path: '/api/category/:id',
    cases: [
      { caller: 'anonymous', status: 401 },
      { caller: 'USER_ROLE', status: 403 },
      { caller: 'VENTAS_ROLE', status: 204, label: 'any category, additive (ADR-040)' },
      { caller: 'ADMIN_ROLE', status: 204, label: 'any category' },
      {
        caller: 'USER_ROLE',
        owner: true,
        status: 403,
        label: 'AM-M6-2: creator, still 403 — no category ownership',
      },
    ],
  },
  {
    id: '#14',
    method: 'get',
    path: '/api/product',
    cases: [
      { caller: 'anonymous', status: 200 },
      { caller: 'USER_ROLE', status: 200 },
      { caller: 'VENTAS_ROLE', status: 200 },
      { caller: 'ADMIN_ROLE', status: 200 },
    ],
  },
  {
    id: '#15',
    method: 'get',
    path: '/api/product/:id',
    cases: [
      { caller: 'anonymous', status: 200 },
      { caller: 'USER_ROLE', status: 200 },
      { caller: 'VENTAS_ROLE', status: 200 },
      { caller: 'ADMIN_ROLE', status: 200 },
    ],
  },
  {
    id: '#16',
    method: 'post',
    path: '/api/product',
    cases: [
      { caller: 'anonymous', status: 401 },
      { caller: 'USER_ROLE', status: 201 },
      { caller: 'VENTAS_ROLE', status: 201 },
      { caller: 'ADMIN_ROLE', status: 201 },
    ],
  },
  // #17 — ADR-041: a product's creator may edit their own active product.
  {
    id: '#17',
    method: 'put',
    path: '/api/product/:id',
    cases: [
      { caller: 'anonymous', status: 401 },
      { caller: 'USER_ROLE', status: 403 },
      { caller: 'VENTAS_ROLE', status: 200, label: 'any product, additive (ADR-040)' },
      { caller: 'ADMIN_ROLE', status: 200, label: 'any product' },
      { caller: 'USER_ROLE', owner: true, status: 200, label: 'creator, additive (ADR-041)' },
    ],
  },
  {
    id: '#18',
    method: 'delete',
    path: '/api/product/:id',
    cases: [
      { caller: 'anonymous', status: 401 },
      { caller: 'USER_ROLE', status: 403 },
      { caller: 'VENTAS_ROLE', status: 204, label: 'any product, additive (ADR-040)' },
      { caller: 'ADMIN_ROLE', status: 204, label: 'any product' },
      { caller: 'USER_ROLE', owner: true, status: 204, label: 'creator, additive (ADR-041)' },
    ],
  },
  // #19a — public collections (category, product): unaffected, same for every caller.
  {
    id: '#19a',
    method: 'get',
    path: '/api/search/:collection/:term',
    cases: [
      { caller: 'anonymous', status: 200, label: 'collection=category' },
      { caller: 'USER_ROLE', status: 200, label: 'collection=category' },
      { caller: 'VENTAS_ROLE', status: 200, label: 'collection=category' },
      { caller: 'ADMIN_ROLE', status: 200, label: 'collection=category' },
    ],
  },
  // #19b — the user collection: SEC-05, admin-only. Shares #19a's (method, path); the drift check dedupes it.
  {
    id: '#19b',
    method: 'get',
    path: '/api/search/:collection/:term',
    cases: [
      { caller: 'anonymous', status: 401, label: 'collection=user' },
      { caller: 'USER_ROLE', status: 403, label: 'collection=user' },
      { caller: 'VENTAS_ROLE', status: 403, label: 'collection=user' },
      { caller: 'ADMIN_ROLE', status: 200, label: 'collection=user' },
    ],
  },
  // #21a — the user collection: owner-or-admin, unchanged from pre-M6 (only its guard's name changes).
  {
    id: '#21a',
    method: 'put',
    path: '/api/uploads/:collection/:id',
    cases: [
      { caller: 'anonymous', status: 401, label: 'collection=user' },
      { caller: 'USER_ROLE', status: 403, label: 'collection=user, not self' },
      { caller: 'VENTAS_ROLE', status: 403, label: 'collection=user' },
      { caller: 'ADMIN_ROLE', status: 200, label: 'collection=user' },
      { caller: 'USER_ROLE', owner: true, status: 200, label: 'collection=user, self' },
    ],
  },
  // #21b — the product collection: VENTAS_ROLE gains it (ADR-040); a creator does not (ADR-041 does not extend
  // media). Shares #21a's (method, path); the drift check dedupes it.
  {
    id: '#21b',
    method: 'put',
    path: '/api/uploads/:collection/:id',
    cases: [
      { caller: 'anonymous', status: 401, label: 'collection=product' },
      { caller: 'USER_ROLE', status: 403, label: 'collection=product, no owner exception (ADR-041)' },
      { caller: 'VENTAS_ROLE', status: 200, label: 'collection=product, additive (ADR-040)' },
      { caller: 'ADMIN_ROLE', status: 200, label: 'collection=product' },
      {
        caller: 'USER_ROLE',
        owner: true,
        status: 403,
        label: 'collection=product, creator, not extended to media',
      },
    ],
  },
  // #22 — public and unaffected by M6; representative of every caller (§2.2's column is identical across all four).
  {
    id: '#22',
    method: 'get',
    path: '/api/uploads/:collection/:id',
    cases: [{ caller: 'anonymous', status: 302, label: 'collection=user, an existing image' }],
  },
  {
    id: '#24',
    method: 'post',
    path: '/api/auth/logout-all',
    cases: [
      { caller: 'anonymous', status: 401 },
      { caller: 'USER_ROLE', status: 204, label: 'self' },
      { caller: 'VENTAS_ROLE', status: 204, label: 'self' },
      { caller: 'ADMIN_ROLE', status: 204, label: 'self' },
    ],
  },
  {
    id: '#25',
    method: 'put',
    path: '/api/auth/password',
    cases: [
      { caller: 'anonymous', status: 401 },
      { caller: 'USER_ROLE', status: 200, label: 'self' },
      { caller: 'VENTAS_ROLE', status: 200, label: 'self' },
      { caller: 'ADMIN_ROLE', status: 200, label: 'self' },
    ],
  },
];
