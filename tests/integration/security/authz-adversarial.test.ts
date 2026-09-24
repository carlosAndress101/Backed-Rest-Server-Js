// M6 design §6.3, as ruled by §11 (AM-M6-1..9): every adversarial case, written test-first against the M6 target
// contract while T6.1 (BACKEND) is still building it in parallel (AM-M6-9). A case this branch's pre-M6 code
// answers differently from the ruled contract is an EXPECTED failure until T6.1 merges (T6.2B); see the report.
import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { CategoryModel } from '../../../src/modules/categories';
import { ProductModel } from '../../../src/modules/products';
import { UserModel } from '../../../src/modules/users';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import {
  authHeader,
  createAdmin,
  createCategory,
  createProduct,
  createUser,
  tokenFor,
  uniqueSuffix,
} from '../../helpers/factories';
import { stubMediaClient } from '../../helpers/uploads';
import { MATRIX } from '../../helpers/permission-matrix';

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

describe('M6 adversarial suite (§6.3)', () => {
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

  describe('SEC-02: no write path grants role or ownership from the client', () => {
    test('POST /api/user ignores a client-supplied role', async () => {
      const email = `escalate-${uniqueSuffix()}@example.com`;

      const res = await request(app)
        .post('/api/user')
        .send({ name: 'Attacker', email, password: 'a-strong-password-1', role: 'ADMIN_ROLE' });

      expect(res.statusCode).toBe(201);
      const stored = await UserModel.findOne({ email }).lean();
      expect(stored?.role).toBe('USER_ROLE');
    });

    test('POST /api/category ignores a client-supplied user (the creator is always the caller)', async () => {
      const caller = await createUser();
      const someoneElse = await createUser();
      const token = await tokenFor(caller);

      const res = await request(app)
        .post('/api/category')
        .set(authHeader(token))
        .send({ name: `Category ${uniqueSuffix()}`, user: someoneElse.id, role: 'ADMIN_ROLE' });

      expect(res.statusCode).toBe(201);
      const stored = await CategoryModel.findById(res.body.data.id).lean();
      expect(String(stored?.user)).toBe(caller.id);
    });

    test('POST /api/product ignores a client-supplied user (the creator is always the caller)', async () => {
      const caller = await createUser();
      const someoneElse = await createUser();
      const category = await createCategory();
      const token = await tokenFor(caller);

      const res = await request(app)
        .post('/api/product')
        .set(authHeader(token))
        .send({
          name: `Product ${uniqueSuffix()}`,
          category: category.id,
          user: someoneElse.id,
          role: 'ADMIN_ROLE',
        });

      expect(res.statusCode).toBe(201);
      const stored = await ProductModel.findById(res.body.data.id).lean();
      expect(String(stored?.user)).toBe(caller.id);
    });
  });

  // [P29]: Mongoose's ObjectId comparison is binary, so it is inherently case-insensitive.
  describe('[P29] product ownership survives an id supplied in a different hex case', () => {
    test('the true owner succeeds, whatever case their own id is not even part of (the :id param is the product)', async () => {
      const owner = await createUser();
      const product = await createProduct({ user: owner });
      const token = await tokenFor(owner);
      const upperCaseId = product.id.toUpperCase();

      const res = await request(app)
        .put(`/api/product/${upperCaseId}`)
        .set(authHeader(token))
        .send({ name: 'RENAMED' });

      expect(res.statusCode).toBe(200);
    });

    test("a different real owner (not this product's creator) is still refused", async () => {
      const owner = await createUser();
      const attacker = await createUser(); // owns a *different* product, but not this one
      const product = await createProduct({ user: owner });
      const token = await tokenFor(attacker);

      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(authHeader(token))
        .send({ name: 'RENAMED' });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('AM-M6-4/§2.1: find-active-or-404 outranks ownership', () => {
    test('the creator of a soft-deleted product gets 404 on PUT, never 403 or 200', async () => {
      const owner = await createUser();
      const product = await createProduct({ user: owner });
      await ProductModel.updateOne({ _id: product.id }, { state: false });
      const token = await tokenFor(owner);

      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(authHeader(token))
        .send({ name: 'RENAMED' });

      expect(res.statusCode).toBe(404);
    });

    test('the creator of a soft-deleted product gets 404 on DELETE, never 403 or 200', async () => {
      const owner = await createUser();
      const product = await createProduct({ user: owner });
      await ProductModel.updateOne({ _id: product.id }, { state: false });
      const token = await tokenFor(owner);

      const res = await request(app).delete(`/api/product/${product.id}`).set(authHeader(token));

      expect(res.statusCode).toBe(404);
    });
  });

  describe('ADR-043: a demoted administrator loses access on their very next request, same still-valid token', () => {
    test('GET /api/user is 403 the instant role flips, with no tokenVersion bump', async () => {
      const demoted = await createAdmin();
      const otherAdmin = await createAdmin();
      const demotedToken = await tokenFor(demoted);
      const otherAdminToken = await tokenFor(otherAdmin);

      const before = await request(app).get('/api/user').set(authHeader(demotedToken));
      expect(before.statusCode).toBe(200); // still an administrator

      const demote = await request(app)
        .put(`/api/user/${demoted.id}`)
        .set(authHeader(otherAdminToken))
        .send({ role: 'USER_ROLE' });
      expect(demote.statusCode).toBe(200);

      const after = await request(app).get('/api/user').set(authHeader(demotedToken));
      expect(after.statusCode).toBe(403); // the same token; authenticate re-read role live
    });
  });

  describe('AM-M6-3: the last-administrator lockout guard', () => {
    test('a self role change is 403 (with exactly one active administrator)', async () => {
      const soleAdmin = await createAdmin();
      const token = await tokenFor(soleAdmin);

      const res = await request(app)
        .put(`/api/user/${soleAdmin.id}`)
        .set(authHeader(token))
        .send({ role: 'USER_ROLE' });

      expect(res.statusCode).toBe(403);
    });

    test('a self state:false is 403', async () => {
      const soleAdmin = await createAdmin();
      const token = await tokenFor(soleAdmin);

      const res = await request(app)
        .put(`/api/user/${soleAdmin.id}`)
        .set(authHeader(token))
        .send({ state: false });

      expect(res.statusCode).toBe(403);
    });

    test('a self DELETE is 403', async () => {
      const soleAdmin = await createAdmin();
      const token = await tokenFor(soleAdmin);

      const res = await request(app).delete(`/api/user/${soleAdmin.id}`).set(authHeader(token));

      expect(res.statusCode).toBe(403);
    });

    test('echoing the current role is accepted (AM-M6-3)', async () => {
      const soleAdmin = await createAdmin();
      const token = await tokenFor(soleAdmin);

      const res = await request(app)
        .put(`/api/user/${soleAdmin.id}`)
        .set(authHeader(token))
        .send({ role: 'ADMIN_ROLE' });

      expect(res.statusCode).toBe(200);
    });

    test('echoing state:true is accepted (AM-M6-3)', async () => {
      const soleAdmin = await createAdmin();
      const token = await tokenFor(soleAdmin);

      const res = await request(app)
        .put(`/api/user/${soleAdmin.id}`)
        .set(authHeader(token))
        .send({ state: true });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('IDOR sweep: a non-owner, non-privileged caller never reaches 200/204 on an ownership-checked route', () => {
    test('every :id write route in the fixture refuses a non-owner USER_ROLE caller', async () => {
      const owner = await createUser();
      const attacker = await createUser();
      const token = await tokenFor(attacker);
      stubMediaClient('https://example.test/img.png');

      const targetUser = await createUser();
      const category = await createCategory({ user: owner });
      const product = await createProduct({ user: owner });
      const mediaProduct = await createProduct({ user: owner });
      const idWriteRows = MATRIX.filter(
        (row) => (row.method === 'put' || row.method === 'delete') && row.path.includes(':id'),
      );
      expect(idWriteRows).toHaveLength(8);

      const attempts: Array<[string, () => Promise<{ statusCode: number }>]> = idWriteRows.map((row) => {
        let concretePath: string;
        if (row.path === '/api/user/:id') {
          concretePath = `/api/user/${targetUser.id}`;
        } else if (row.path === '/api/category/:id') {
          concretePath = `/api/category/${category.id}`;
        } else if (row.path === '/api/product/:id') {
          concretePath = `/api/product/${product.id}`;
        } else if (row.path === '/api/uploads/:collection/:id') {
          const ownerCase = row.cases.find((kase) => kase.owner !== undefined);
          const collection = ownerCase?.label?.match(/collection=([^, ]+)/)?.[1];
          if (collection === 'user') {
            concretePath = `/api/uploads/user/${targetUser.id}`;
          } else if (collection === 'product') {
            concretePath = `/api/uploads/product/${mediaProduct.id}`;
          } else {
            throw new Error(`IDOR sweep cannot identify the media collection for row ${row.id}`);
          }
        } else {
          throw new Error(`IDOR sweep has no request builder for :id write row ${row.id}`);
        }

        if (row.method === 'delete') {
          return [
            `${row.method.toUpperCase()} ${row.path} (not owner)`,
            () => request(app).delete(concretePath).set(authHeader(token)),
          ];
        }
        if (row.method === 'put' && row.path.startsWith('/api/uploads/')) {
          return [
            `${row.method.toUpperCase()} ${row.path} (not owner)`,
            () => request(app).put(concretePath).set(authHeader(token)).attach('file', JPEG, 'p.jpg'),
          ];
        }
        if (row.method === 'put') {
          return [
            `${row.method.toUpperCase()} ${row.path} (not owner)`,
            () => request(app).put(concretePath).set(authHeader(token)).send({ name: 'X' }),
          ];
        }
        throw new Error(`IDOR sweep has no request builder for ${row.method.toUpperCase()} ${row.path}`);
      });

      for (const [label, attempt] of attempts) {
        const res = await attempt();
        expect([200, 204]).not.toContain(res.statusCode);
        expect(res.statusCode, label).toBeGreaterThanOrEqual(400);
      }
    });
  });

  describe('authorization check order pinned by T6.1 and AM-M6-8', () => {
    // Source: T6.1 report, flipped assertion 7 (ADR-039): parameter validation runs before ownership.
    test('PUT /api/product/:id with a malformed id is 422 for a non-owner USER_ROLE caller', async () => {
      const attacker = await createUser();

      const res = await request(app)
        .put('/api/product/not-a-mongo-id')
        .set(authHeader(await tokenFor(attacker)))
        .send({ name: 'X' });

      expect(res.statusCode).toBe(422);
    });

    // Source: T6.1 report, flipped assertion 7 (ADR-039): parameter validation runs before ownership.
    test('DELETE /api/product/:id with a malformed id is 422 for a non-owner USER_ROLE caller', async () => {
      const attacker = await createUser();

      const res = await request(app)
        .delete('/api/product/not-a-mongo-id')
        .set(authHeader(await tokenFor(attacker)));

      expect(res.statusCode).toBe(422);
    });

    // Source: T6.1 report, flipped assertion 7 (ADR-039): an existing product reaches the ownership check.
    test('PUT /api/product/:id on an existing product the caller did not create is 403', async () => {
      const owner = await createUser();
      const attacker = await createUser();
      const product = await createProduct({ user: owner });

      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(authHeader(await tokenFor(attacker)))
        .send({ name: 'X' });

      expect(res.statusCode).toBe(403);
    });

    // Source: T6.1 report, flipped assertion 7 (ADR-039): an existing product reaches the ownership check.
    test('DELETE /api/product/:id on an existing product the caller did not create is 403', async () => {
      const owner = await createUser();
      const attacker = await createUser();
      const product = await createProduct({ user: owner });

      const res = await request(app)
        .delete(`/api/product/${product.id}`)
        .set(authHeader(await tokenFor(attacker)));

      expect(res.statusCode).toBe(403);
    });

    // Source: accepted residual AM-M6-8: the category existence check precedes the ownership check.
    test('PUT /api/product/:id with a category that does not exist is 404 for a non-owner USER_ROLE caller', async () => {
      const owner = await createUser();
      const attacker = await createUser();
      const product = await createProduct({ user: owner });
      const missingCategory = await createUser(); // Valid ObjectId, but not present in the categories collection.

      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(authHeader(await tokenFor(attacker)))
        .send({ category: missingCategory.id });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('ADR-040: VENTAS_ROLE gains catalog rights, loses user-delete', () => {
    test('PUT and DELETE succeed on a category it did not create', async () => {
      const ventas = await createUser({ role: 'VENTAS_ROLE' });
      const token = await tokenFor(ventas);
      const toUpdate = await createCategory();
      const toDelete = await createCategory();

      const put = await request(app)
        .put(`/api/category/${toUpdate.id}`)
        .set(authHeader(token))
        .send({ name: 'RENAMED' });
      const del = await request(app).delete(`/api/category/${toDelete.id}`).set(authHeader(token));

      expect(put.statusCode).toBe(200);
      expect(del.statusCode).toBe(204);
    });

    test('PUT and DELETE succeed on a product it did not create', async () => {
      const ventas = await createUser({ role: 'VENTAS_ROLE' });
      const token = await tokenFor(ventas);
      const toUpdate = await createProduct();
      const toDelete = await createProduct();

      const put = await request(app)
        .put(`/api/product/${toUpdate.id}`)
        .set(authHeader(token))
        .send({ name: 'RENAMED' });
      const del = await request(app).delete(`/api/product/${toDelete.id}`).set(authHeader(token));

      expect(put.statusCode).toBe(200);
      expect(del.statusCode).toBe(204);
    });

    test('PUT /api/uploads/product/:id succeeds', async () => {
      const ventas = await createUser({ role: 'VENTAS_ROLE' });
      const token = await tokenFor(ventas);
      const product = await createProduct();
      stubMediaClient('https://example.test/img.png');

      const res = await request(app)
        .put(`/api/uploads/product/${product.id}`)
        .set(authHeader(token))
        .attach('file', JPEG, 'p.jpg');

      expect(res.statusCode).toBe(200);
    });

    test('DELETE /api/user/:id is refused (breaking, ADR-040)', async () => {
      const ventas = await createUser({ role: 'VENTAS_ROLE' });
      const token = await tokenFor(ventas);
      const target = await createUser();

      const res = await request(app).delete(`/api/user/${target.id}`).set(authHeader(token));

      expect(res.statusCode).toBe(403);
    });
  });

  describe('§8 regression: an administrator editing a product or category does not reassign its creator', () => {
    test('a product keeps its original creator after an administrator edits it', async () => {
      const creator = await createUser();
      const admin = await createAdmin();
      const product = await createProduct({ user: creator });
      const token = await tokenFor(admin);

      const res = await request(app)
        .put(`/api/product/${product.id}`)
        .set(authHeader(token))
        .send({ name: 'RENAMED BY ADMIN' });

      expect(res.statusCode).toBe(200);
      const stored = await ProductModel.findById(product.id).lean();
      expect(String(stored?.user)).toBe(creator.id);
    });

    test('a category keeps its original creator after an administrator edits it', async () => {
      const creator = await createUser();
      const admin = await createAdmin();
      const category = await createCategory({ user: creator });
      const token = await tokenFor(admin);

      const res = await request(app)
        .put(`/api/category/${category.id}`)
        .set(authHeader(token))
        .send({ name: 'RENAMED BY ADMIN' });

      expect(res.statusCode).toBe(200);
      const stored = await CategoryModel.findById(category.id).lean();
      expect(String(stored?.user)).toBe(creator.id);
    });
  });

  describe('AM-M6-7: a self request with an upper-case id passes', () => {
    test('PUT /api/user/:id, self, upper-case id', async () => {
      const self = await createUser();
      const token = await tokenFor(self);
      const upperCaseId = self.id.toUpperCase();

      const res = await request(app)
        .put(`/api/user/${upperCaseId}`)
        .set(authHeader(token))
        .send({ name: 'RENAMED' });

      expect(res.statusCode).toBe(200);
    });

    test('PUT /api/uploads/user/:id, self, upper-case id', async () => {
      const self = await createUser();
      const token = await tokenFor(self);
      const upperCaseId = self.id.toUpperCase();
      stubMediaClient('https://example.test/img.png');

      const res = await request(app)
        .put(`/api/uploads/user/${upperCaseId}`)
        .set(authHeader(token))
        .attach('file', JPEG, 'p.jpg');

      expect(res.statusCode).toBe(200);
    });
  });
});
