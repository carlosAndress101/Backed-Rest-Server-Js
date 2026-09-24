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

/** Every (METHOD, full path) the live app actually registers, pairing each router with MOUNT_PREFIXES by mount
 * order (AM-M6-6: the live prefix cannot be read off the layer, so this pairing is an assumption the router-count
 * assertion below checks — but not one this test can verify path-by-path if app.ts ever reorders its app.use()s). */
function registeredRoutes(routers: RouteLayer[]): Set<string> {
  const routes = new Set<string>();
  routers.forEach((layer, index) => {
    const prefix = MOUNT_PREFIXES[index];
    for (const sub of layer.handle.stack ?? []) {
      if (!sub.route) continue;
      const suffix = sub.route.path === '/' ? '' : sub.route.path;
      for (const [method, enabled] of Object.entries(sub.route.methods)) {
        if (enabled) routes.add(`${method.toUpperCase()} ${prefix}${suffix}`);
      }
    }
  });
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
