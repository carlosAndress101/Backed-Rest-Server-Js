// Test data factories, ported from the M1 e2e helpers (T1.4, T1.7, T1.8) with the same names, defaults and
// behaviour. They build with the modules' own models (ADR-027).
import bcrypt from 'bcrypt';
import mongoose, { type Model } from 'mongoose';

import { createTokenService } from '../../src/core/security/jwt';
import { CategoryModel, type CategoryDocument } from '../../src/modules/categories';
import { ProductModel, type ProductDocument } from '../../src/modules/products';
import { UserModel, type UserDocument } from '../../src/modules/users';

// Cheap on purpose: bcrypt cost only has to be verifiable, not strong, in tests.
export const BCRYPT_ROUNDS = 4;
export const TEST_PASSWORD = 'test-password-123';

export const uniqueSuffix = () => new mongoose.Types.ObjectId().toHexString();

export const hashPassword = (password = TEST_PASSWORD) => bcrypt.hashSync(password, BCRYPT_ROUNDS);

export const createUser = async (overrides: Record<string, unknown> = {}): Promise<UserDocument> =>
  UserModel.create({
    name: 'Test User',
    email: `user-${uniqueSuffix()}@example.com`,
    password: hashPassword(),
    role: 'USER_ROLE',
    state: true,
    ...overrides,
  });

export const createAdmin = async (overrides: Record<string, unknown> = {}): Promise<UserDocument> =>
  createUser({ name: 'Admin User', role: 'ADMIN_ROLE', ...overrides });

/** A user of any role; the named helpers below delegate here so each role literal lives in one place. */
export const createUserWithRole = async (
  role: 'USER_ROLE' | 'VENTAS_ROLE' | 'ADMIN_ROLE',
  overrides: Record<string, unknown> = {},
): Promise<UserDocument> => createUser({ name: `${role} User`, role, ...overrides });

export const createVentas = async (overrides: Record<string, unknown> = {}): Promise<UserDocument> =>
  createUserWithRole('VENTAS_ROLE', { name: 'Ventas User', ...overrides });

export const createCategory = async (overrides: Record<string, unknown> = {}): Promise<CategoryDocument> => {
  const { user, ...rest } = overrides as { user?: UserDocument };
  const owner = user || (await createUser());
  return CategoryModel.create({
    name: `CATEGORY ${uniqueSuffix()}`,
    user: owner._id,
    ...rest,
  });
};

export const createProduct = async (overrides: Record<string, unknown> = {}): Promise<ProductDocument> => {
  const { user, category, ...rest } = overrides as {
    user?: UserDocument;
    category?: string | mongoose.Types.ObjectId;
  };
  const owner = user || (await createUser());
  const cat = category || (await createCategory({ user: owner }))._id;
  return ProductModel.create({
    name: `PRODUCT ${uniqueSuffix()}`,
    user: owner._id,
    category: cat,
    ...rest,
  });
};

/**
 * Mints a JWT for a user (or any `{ id }`, even one that is not an ObjectId) without going through the
 * rate-limited login route: the core token service, with the test SECRET_KEY read on every call. It signs the
 * user's own tokenVersion (0 when the object has none), as login does (P21).
 */
export const tokenFor = (user: { id: string; tokenVersion?: number }) =>
  createTokenService(process.env.SECRET_KEY ?? '', { ttlSeconds: 4 * 60 * 60 }).sign(
    user.id,
    user.tokenVersion ?? 0,
  );

/** The M5 transport (ADR-032). x-token still works until 4.0.0; the tests that exercise it set it themselves. */
export const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Reads a stored record back; a missing one fails the test. */
export const reload = <T>(model: Model<T>, id: string) => model.findById(id).orFail();
