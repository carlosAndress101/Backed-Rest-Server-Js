// Test data factories, ported from e2e/helpers/db.js (T1.4, T1.7, T1.8) with the same names, defaults and behaviour.
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';

import { generarJWT, legacyModels, type LegacyDoc } from './legacy';

const { User, Role, Category, Product } = legacyModels();

// Cheap on purpose: bcrypt cost only has to be verifiable, not strong, in tests.
export const BCRYPT_ROUNDS = 4;
export const TEST_PASSWORD = 'test-password-123';

export const uniqueSuffix = () => new mongoose.Types.ObjectId().toHexString();

export const hashPassword = (password = TEST_PASSWORD) => bcrypt.hashSync(password, BCRYPT_ROUNDS);

export const createUser = async (overrides: Record<string, unknown> = {}): Promise<LegacyDoc> =>
  User.create({
    name: 'Test User',
    email: `user-${uniqueSuffix()}@example.com`,
    password: hashPassword(),
    role: 'USER_ROLE',
    state: true,
    ...overrides,
  });

export const createAdmin = async (overrides: Record<string, unknown> = {}): Promise<LegacyDoc> =>
  createUser({ name: 'Admin User', role: 'ADMIN_ROLE', ...overrides });

export const seedRoles = async (...roles: string[]): Promise<LegacyDoc[]> => {
  const wanted = roles.length ? roles : ['ADMIN_ROLE', 'USER_ROLE'];
  return Promise.all(wanted.map((role) => Role.create({ role })));
};

export const createCategory = async (overrides: Record<string, unknown> = {}): Promise<LegacyDoc> => {
  const { user, ...rest } = overrides as { user?: LegacyDoc };
  const owner = user || (await createUser());
  return Category.create({
    name: `CATEGORY ${uniqueSuffix()}`,
    user: owner._id,
    ...rest,
  });
};

export const createProduct = async (overrides: Record<string, unknown> = {}): Promise<LegacyDoc> => {
  const { user, category, ...rest } = overrides as { user?: LegacyDoc; category?: unknown };
  const owner = user || (await createUser());
  const cat = category || (await createCategory({ user: owner }))._id;
  return Product.create({
    name: `PRODUCT ${uniqueSuffix()}`,
    user: owner._id,
    category: cat,
    ...rest,
  });
};

/** Mints a JWT for a user without going through the rate-limited login route. */
export const tokenFor = (user: LegacyDoc) => generarJWT(user.id);

/** M1 still uses the custom `x-token` header (SEC-11 is a later milestone). */
export const authHeader = (token: string) => ({ 'x-token': token });

export const reload = (model: ReturnType<typeof legacyModels>['User'], id: string) => model.findById(id);
