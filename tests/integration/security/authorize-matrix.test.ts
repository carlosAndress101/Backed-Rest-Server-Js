// M6 design §6.2, AM-M6-6, AM-M6-9 (T6.2A): the matrix-driven test, written test-first against the M6 target
// contract while T6.1 (BACKEND) is still building it in parallel. Every cell this branch's pre-M6 code answers
// differently from the fixture is an EXPECTED failure until T6.1 merges (T6.2B); see the report for the table.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';

import { createApp } from '../../../src/app';
import { loadConfig } from '../../../src/config';
import { createLogger } from '../../../src/core/logger';
import type { UserDocument } from '../../../src/modules/users';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { stubGoogleClient } from '../../helpers/auth';
import {
  TEST_PASSWORD,
  authHeader,
  createAdmin,
  createCategory,
  createProduct,
  createUser,
  tokenFor,
  uniqueSuffix,
} from '../../helpers/factories';
import { stubMediaClient } from '../../helpers/uploads';
import {
  MATRIX,
  MOUNT_PREFIXES,
  type Caller,
  type MatrixCase,
  type MatrixRow,
} from '../../helpers/permission-matrix';

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const CLOUDINARY_IMAGE = 'https://res.cloudinary.com/demo/image/upload/v1/existing.png';

// The app is built here (not through startTestApp) only to read its own route registration: no listen, no
// request ever goes through this instance. Express 5's path-to-regexp v8 layers expose a matcher closure, not a
// path or regexp string (verified directly against this branch's express@5.2.1), so the app's registered routes
// are read from `router.stack` / `layer.handle.stack` — [P30], amended by AM-M6-6 — rather than parsed from it.
function buildIntrospectableApp() {
  const config = loadConfig({ ...process.env, MONGO_CLOUD: `${inject('mongoUri')}test-${randomUUID()}` });
  return createApp({ config, logger: createLogger(config, { write: () => undefined }) });
}

interface RouteLayer {
  name: string;
  handle: { stack?: SubLayer[] };
}
interface SubLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

function mountedRouters(): RouteLayer[] {
  const app = buildIntrospectableApp() as unknown as { router: { stack: RouteLayer[] } };
  return app.router.stack.filter((layer) => layer.name === 'router');
}

/** The (METHOD, router-local suffix) pairs one mounted router registers. The mount prefix itself is
 * not readable off the Express 5 layer (path-to-regexp v8 matcher closure), so the TEST-05 pairing
 * below recovers it by suffix-set bijection instead. */
function routerSuffixes(router: RouteLayer): Array<{ method: string; suffix: string }> {
  const pairs: Array<{ method: string; suffix: string }> = [];
  for (const sub of router.handle.stack ?? []) {
    if (!sub.route) continue;
    const suffix = sub.route.path === '/' ? '' : sub.route.path;
    for (const [method, enabled] of Object.entries(sub.route.methods)) {
      if (enabled) pairs.push({ method: method.toUpperCase(), suffix });
    }
  }
  return pairs;
}

/** Order-independent router-to-prefix pairing (TEST-05): a prefix is a candidate for a router iff
 * every live (METHOD, prefix + suffix) pair is in the fixture set; the routers are then bound to
 * distinct prefixes — an exact bijection where every router is matched and every prefix is used
 * exactly once. Throws with a diff when a router matches no prefix or when no exact bijection
 * exists, so added/removed routes fail closed. Deterministic: routers bind fewest-candidates-first,
 * prefixes in listed order. The category/product twin routers share one suffix set and are
 * interchangeable by construction — either assignment yields the same live pair set, which the
 * sorted-set equality assertion below checks as the backstop. */
function pairRouters<P extends string>(
  routers: RouteLayer[],
  prefixes: readonly P[],
  fixturePairs: Set<string>,
): Map<RouteLayer, P> {
  if (routers.length !== prefixes.length) {
    throw new Error(
      `pairRouters: router/prefix count mismatch (fail-closed): ${routers.length} router(s) vs ${prefixes.length} prefixes (${prefixes.join(', ')})`,
    );
  }
  const candidatesOf = new Map<RouteLayer, P[]>();
  const suffixesOf = new Map<RouteLayer, Array<{ method: string; suffix: string }>>();
  for (const router of routers) {
    const suffixes = routerSuffixes(router);
    suffixesOf.set(router, suffixes);
    candidatesOf.set(
      router,
      prefixes.filter((prefix) =>
        suffixes.every(({ method, suffix }) => fixturePairs.has(`${method} ${prefix}${suffix}`)),
      ),
    );
  }

  const orphaned = routers.filter((router) => candidatesOf.get(router)!.length === 0);
  if (orphaned.length > 0) {
    const detail = orphaned.map((router) => JSON.stringify(suffixesOf.get(router))).join('\n');
    throw new Error(
      `pairRouters: ${orphaned.length} router(s) match no known prefix (fail-closed) — live routes drifted from the fixture:\n${detail}\nKnown prefixes: ${prefixes.join(', ')}`,
    );
  }

  const ordered = [...routers].sort((a, b) => candidatesOf.get(a)!.length - candidatesOf.get(b)!.length);
  const assignment = new Map<RouteLayer, P>();
  const used = new Set<P>();
  const solve = (index: number): boolean => {
    if (index === ordered.length) return true;
    const router = ordered[index];
    if (!router) return false;
    for (const prefix of candidatesOf.get(router)!) {
      if (used.has(prefix)) continue;
      used.add(prefix);
      assignment.set(router, prefix);
      if (solve(index + 1)) return true;
      used.delete(prefix);
      assignment.delete(router);
    }
    return false;
  };
  if (!solve(0)) {
    const detail = routers
      .map(
        (router, index) =>
          `router[${index}] suffixes=${JSON.stringify(suffixesOf.get(router))} candidates=[${candidatesOf.get(router)!.join(', ')}]`,
      )
      .join('\n');
    throw new Error(
      `pairRouters: no exact router-to-prefix bijection (fail-closed) — live routes drifted from the fixture:\n${detail}`,
    );
  }
  return assignment;
}

/** Every (METHOD, full path) the live app actually registers, pairing each router with its prefix
 * by suffix-set bijection — independent of `app.use()` order in `src/app.ts` (read-only). */
function registeredRoutes(routers: RouteLayer[]): Set<string> {
  const fixturePairs = new Set(MATRIX.map((row) => `${row.method.toUpperCase()} ${row.path}`));
  const pairing = pairRouters(routers, MOUNT_PREFIXES, fixturePairs);
  const routes = new Set<string>();
  for (const [router, prefix] of pairing) {
    for (const { method, suffix } of routerSuffixes(router)) {
      routes.add(`${method} ${prefix}${suffix}`);
    }
  }
  return routes;
}

describe('the fixture is the single source of truth (AM-M6-6, P30): it drifts from the live app, pnpm test fails', () => {
  test('the app mounts exactly as many routers as permission-matrix.ts has MOUNT_PREFIXES entries', () => {
    expect(mountedRouters().length).toBe(MOUNT_PREFIXES.length);
  });

  test("the fixture's (method, full path) set equals every route the app registers", () => {
    const fixturePairs = new Set(MATRIX.map((row) => `${row.method.toUpperCase()} ${row.path}`));
    const livePairs = registeredRoutes(mountedRouters());
    expect([...fixturePairs].sort()).toEqual([...livePairs].sort());
  });
});

describe('pairRouters is order-independent (TEST-05)', () => {
  const fixturePairs = () => new Set(MATRIX.map((row) => `${row.method.toUpperCase()} ${row.path}`));

  /** Plain-object rebuild of a mounted router's route table — a synthetic RouteLayer carrying the
   * live suffix set, so the permutation checks prove the pairing logic, not the layer identity. */
  function syntheticRouter(router: RouteLayer): RouteLayer {
    return {
      name: 'router',
      handle: {
        stack: routerSuffixes(router).map(({ method, suffix }) => ({
          route: { path: suffix === '' ? '/' : suffix, methods: { [method.toLowerCase()]: true } },
        })),
      },
    };
  }

  const syntheticRouters = () => mountedRouters().map(syntheticRouter);

  /** Reorder routers by a fixed index permutation (throws on an out-of-range index). */
  function inOrder(routers: RouteLayer[], order: number[]): RouteLayer[] {
    return order.map((index) => {
      const router = routers[index];
      if (!router) throw new Error(`shuffle order references missing router index ${index}`);
      return router;
    });
  }

  function expectExactBijection(routers: RouteLayer[]) {
    const pairing = pairRouters(routers, MOUNT_PREFIXES, fixturePairs());
    expect(pairing.size).toBe(MOUNT_PREFIXES.length);
    // Every prefix matched exactly once, every router matched.
    expect([...pairing.values()].sort()).toEqual([...MOUNT_PREFIXES].sort());
    expect(new Set(pairing.keys()).size).toBe(routers.length);
    return pairing;
  }

  test('reversed mount order pairs every prefix exactly once', () => {
    expectExactBijection(syntheticRouters().reverse());
  });

  // Deterministic sampled shuffles of the live mount order (no randomness: fixed index orders).
  const SHUFFLES: Array<[string, number[]]> = [
    ['rotate-1', [1, 2, 3, 4, 5, 0]],
    ['rotate-3', [3, 4, 5, 0, 1, 2]],
    ['swap-halves', [3, 4, 5, 0, 1, 2].reverse()],
    ['interleave', [0, 3, 1, 4, 2, 5]],
    ['twins-swapped', [1, 0, 2, 3, 4, 5]],
    ['ends-inward', [5, 0, 4, 1, 3, 2]],
  ];

  for (const [name, order] of SHUFFLES) {
    test(`shuffle ${name} pairs every prefix exactly once`, () => {
      expectExactBijection(inOrder(syntheticRouters(), order));
    });
  }

  test('shuffled mounts still recover the full fixture pair set', () => {
    const shuffled = inOrder(syntheticRouters(), [4, 2, 0, 5, 1, 3]);
    const pairing = pairRouters(shuffled, MOUNT_PREFIXES, fixturePairs());
    const livePairs = new Set<string>();
    for (const [router, prefix] of pairing) {
      for (const { method, suffix } of routerSuffixes(router)) {
        livePairs.add(`${method} ${prefix}${suffix}`);
      }
    }
    expect([...livePairs].sort()).toEqual([...fixturePairs()].sort());
  });

  test('a router with no matching prefix throws fail-closed', () => {
    const routers = mountedRouters().reverse();
    const bogus: RouteLayer = {
      name: 'router',
      handle: { stack: [{ route: { path: '/no-such-route', methods: { get: true } } }] },
    };
    expect(() => pairRouters([...routers.slice(1), bogus], MOUNT_PREFIXES, fixturePairs())).toThrow(
      /match no known prefix/,
    );
  });

  test('a router/prefix count mismatch throws fail-closed', () => {
    expect(() => pairRouters(mountedRouters().slice(1), MOUNT_PREFIXES, fixturePairs())).toThrow(
      /count mismatch/,
    );
  });
});

interface Actor {
  user?: UserDocument;
  header: Record<string, string>;
}

async function actorFor(caller: Caller): Promise<Actor> {
  if (caller === 'anonymous') return { header: {} };
  const user = caller === 'ADMIN_ROLE' ? await createAdmin() : await createUser({ role: caller });
  return { user, header: authHeader(await tokenFor(user)) };
}

/** One concrete HTTP request per matrix cell, dispatched by the design's own row id (§2.2). */
async function fire(app: Server, row: MatrixRow, kase: MatrixCase): Promise<number> {
  const { user: callerUser, header } = await actorFor(kase.caller);

  switch (row.id) {
    case '#2': {
      const owner = await createUser();
      const wrong = kase.label === 'wrong credentials';
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: owner.email, password: wrong ? 'the-wrong-password' : TEST_PASSWORD });
      return res.statusCode;
    }
    case '#3': {
      const verified = kase.label === 'verified Google profile';
      stubGoogleClient({
        name: 'Google User',
        email: `google-${uniqueSuffix()}@example.com`,
        emailVerified: verified,
      });
      const res = await request(app).post('/api/auth/google').send({ id_token: 'stubbed' });
      return res.statusCode;
    }
    case '#4': {
      const res = await request(app).get('/api/user').set(header);
      return res.statusCode;
    }
    case '#5': {
      const res = await request(app)
        .post('/api/user')
        .send({
          name: 'New Sign-up',
          email: `signup-${uniqueSuffix()}@example.com`,
          password: TEST_PASSWORD,
        });
      return res.statusCode;
    }
    case '#6': {
      const target = kase.owner ? callerUser! : await createUser();
      const res = await request(app).put(`/api/user/${target.id}`).set(header).send({ name: 'Renamed User' });
      return res.statusCode;
    }
    case '#7': {
      const target = await createUser();
      const res = await request(app).delete(`/api/user/${target.id}`).set(header);
      return res.statusCode;
    }
    case '#9': {
      const res = await request(app).get('/api/category').set(header);
      return res.statusCode;
    }
    case '#10': {
      const category = await createCategory();
      const res = await request(app).get(`/api/category/${category.id}`).set(header);
      return res.statusCode;
    }
    case '#11': {
      const res = await request(app)
        .post('/api/category')
        .set(header)
        .send({ name: `Category ${uniqueSuffix()}` });
      return res.statusCode;
    }
    case '#12': {
      const category = kase.owner ? await createCategory({ user: callerUser }) : await createCategory();
      const res = await request(app)
        .put(`/api/category/${category.id}`)
        .set(header)
        .send({ name: `Renamed ${uniqueSuffix()}` });
      return res.statusCode;
    }
    case '#13': {
      const category = kase.owner ? await createCategory({ user: callerUser }) : await createCategory();
      const res = await request(app).delete(`/api/category/${category.id}`).set(header);
      return res.statusCode;
    }
    case '#14': {
      const res = await request(app).get('/api/product').set(header);
      return res.statusCode;
    }
    case '#15': {
      const product = await createProduct();
      const res = await request(app).get(`/api/product/${product.id}`).set(header);
      return res.statusCode;
    }
    case '#16': {
      const category = await createCategory();
      const res = await request(app)
        .post('/api/product')
        .set(header)
        .send({ name: `Product ${uniqueSuffix()}`, category: category.id });
      return res.statusCode;
    }
    case '#17': {
      const product = kase.owner ? await createProduct({ user: callerUser }) : await createProduct();
      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(header)
        .send({ name: `Renamed ${uniqueSuffix()}` });
      return res.statusCode;
    }
    case '#18': {
      const product = kase.owner ? await createProduct({ user: callerUser }) : await createProduct();
      const res = await request(app).delete(`/api/product/${product.id}`).set(header);
      return res.statusCode;
    }
    case '#19a': {
      const res = await request(app)
        .get(`/api/search/category/${uniqueSuffix().slice(0, 6)}`)
        .set(header);
      return res.statusCode;
    }
    case '#19b': {
      const res = await request(app)
        .get(`/api/search/user/${uniqueSuffix().slice(0, 6)}`)
        .set(header);
      return res.statusCode;
    }
    case '#21a': {
      stubMediaClient(CLOUDINARY_IMAGE);
      const target = kase.owner ? callerUser! : await createUser();
      const res = await request(app)
        .put(`/api/uploads/user/${target.id}`)
        .set(header)
        .attach('file', JPEG, 'photo.jpg');
      return res.statusCode;
    }
    case '#21b': {
      stubMediaClient(CLOUDINARY_IMAGE);
      const product = kase.owner ? await createProduct({ user: callerUser }) : await createProduct();
      const res = await request(app)
        .put(`/api/uploads/product/${product.id}`)
        .set(header)
        .attach('file', JPEG, 'photo.jpg');
      return res.statusCode;
    }
    case '#22': {
      const owner = await createUser({ image: CLOUDINARY_IMAGE });
      const res = await request(app).get(`/api/uploads/user/${owner.id}`);
      return res.statusCode;
    }
    case '#24': {
      const res = await request(app).post('/api/auth/logout-all').set(header);
      return res.statusCode;
    }
    case '#25': {
      const res = await request(app)
        .put('/api/auth/password')
        .set(header)
        .send({ currentPassword: TEST_PASSWORD, newPassword: `new-password-${uniqueSuffix()}` });
      return res.statusCode;
    }
    default:
      throw new Error(`no request builder for matrix row ${row.id}`);
  }
}

describe('one HTTP request per matrix cell (§6.2, the authoritative enforcement check)', () => {
  let app: Server;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  for (const row of MATRIX) {
    describe(`${row.id} ${row.method.toUpperCase()} ${row.path}`, () => {
      for (const kase of row.cases) {
        const title = [kase.caller, kase.owner ? 'owner' : undefined, kase.label].filter(Boolean).join(' / ');

        test(`${title} → ${kase.status}`, async () => {
          const status = await fire(app, row, kase);
          expect(status).toBe(kase.status);
        });
      }
    });
  }
});
