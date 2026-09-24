// The first-admin seed (M4 design §6, D4 §8 #8, P20) against the users module's real model, through the M3 harness.
import bcrypt from 'bcrypt';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { createLogger } from '../../../src/core/logger';
import { seedFirstAdmin, type SeedResult } from '../../../src/database/seed';
import { UserModel } from '../../../src/modules/users';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';
import { hashPassword } from '../../helpers/factories';

const PASSWORD = 'seed-admin-secret-9f3c';
const EMAIL = 'admin@example.com';

let lines: string[];

const seed = (config: { adminEmail?: string; adminPassword?: string }): Promise<SeedResult> =>
  seedFirstAdmin({
    User: UserModel,
    config,
    log: createLogger({ logLevel: 'debug' }, { write: (line: string) => void lines.push(line) }),
  });
const messages = () => lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
const admins = () => UserModel.find({ role: 'ADMIN_ROLE' }).lean();

describe('seedFirstAdmin', () => {
  beforeAll(async () => {
    await startTestApp();
    await UserModel.init(); // the unique email_1 index, the backstop for a concurrent run
  });

  afterAll(stopTestApp);

  beforeEach(async () => {
    await clearDatabase();
    lines = [];
  });

  test('on an empty database it creates exactly one active admin, with the email normalized and the password hashed', async () => {
    const result = await seed({ adminEmail: '  Admin@Example.COM ', adminPassword: PASSWORD });

    const [admin, ...others] = await UserModel.find({}).select('+password').lean();
    expect(others).toEqual([]);
    expect(result).toEqual({ created: true, id: String(admin!._id) });
    expect(admin).toMatchObject({
      name: 'Administrator',
      email: EMAIL,
      role: 'ADMIN_ROLE',
      state: true,
      google: false,
      tokenVersion: 0,
    });
    expect(admin!.password).not.toBe(PASSWORD);
    expect(await bcrypt.compare(PASSWORD, admin!.password)).toBe(true);
    expect(messages()).toEqual(['seed: first admin created']);
  });

  test('run twice: still one admin, and the second run reports admin-exists', async () => {
    await seed({ adminEmail: EMAIL, adminPassword: PASSWORD });
    const [before] = await admins();

    expect(await seed({ adminEmail: EMAIL, adminPassword: PASSWORD })).toEqual({
      created: false,
      reason: 'admin-exists',
    });
    expect(await admins()).toEqual([before]);
  });

  test('an existing active admin, with another email: nothing is written', async () => {
    await UserModel.create({
      name: 'Boss',
      email: 'boss@example.com',
      password: hashPassword(),
      role: 'ADMIN_ROLE',
    });

    expect(await seed({ adminEmail: EMAIL, adminPassword: PASSWORD })).toEqual({
      created: false,
      reason: 'admin-exists',
    });
    expect(await UserModel.countDocuments()).toBe(1);
  });

  test('a soft-deleted admin does not count: the first active admin is created', async () => {
    await UserModel.create({
      name: 'Old',
      email: 'old@example.com',
      password: hashPassword(),
      role: 'ADMIN_ROLE',
      state: false,
    });

    expect(await seed({ adminEmail: EMAIL, adminPassword: PASSWORD })).toMatchObject({ created: true });
    expect(await UserModel.countDocuments({ role: 'ADMIN_ROLE', state: true })).toBe(1);
  });

  test('the configured email belongs to a non-admin (any case): nothing is written, that user is untouched', async () => {
    const user = await UserModel.create({
      name: 'Ada',
      email: EMAIL,
      password: hashPassword('users-own-password'),
    });
    const before = await UserModel.findById(user._id).select('+password').lean();

    expect(await seed({ adminEmail: ' ADMIN@example.com', adminPassword: PASSWORD })).toEqual({
      created: false,
      reason: 'email-exists',
    });
    expect(await UserModel.find({}).select('+password').lean()).toEqual([before]);
    expect(messages()).toEqual([
      'seed: the configured email belongs to an existing user, left untouched; no admin was created',
    ]);
  });

  test.each([
    ['a password under 8 characters', { adminEmail: EMAIL, adminPassword: 'seven77' }, 'weak-password'],
    ['no password', { adminEmail: EMAIL }, 'not-configured'],
    ['no email', { adminPassword: PASSWORD }, 'not-configured'],
    ['a blank email', { adminEmail: '   ', adminPassword: PASSWORD }, 'not-configured'],
  ] as const)('%s: refused, nothing created', async (_case, config, reason) => {
    expect(await seed(config)).toEqual({ created: false, reason });
    expect(await UserModel.countDocuments()).toBe(0);
  });

  test('the email taken between the check and the insert (a concurrent run): email-exists, nothing thrown', async () => {
    vi.spyOn(UserModel, 'create').mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
    );

    expect(await seed({ adminEmail: EMAIL, adminPassword: PASSWORD })).toEqual({
      created: false,
      reason: 'email-exists',
    });
  });

  test('any other failure to create rejects (the CLI logs it and exits 1)', async () => {
    await expect(seed({ adminEmail: 'not-an-email', adminPassword: PASSWORD })).rejects.toThrow(/email/);
    expect(await UserModel.countDocuments()).toBe(0);
  });

  test('P20: the password never reaches a log line, on any path', async () => {
    await seed({ adminEmail: EMAIL, adminPassword: PASSWORD }); // created
    await seed({ adminEmail: EMAIL, adminPassword: PASSWORD }); // admin-exists
    await clearDatabase();
    await UserModel.create({ name: 'Ada', email: EMAIL, password: hashPassword() });
    await seed({ adminEmail: EMAIL, adminPassword: PASSWORD }); // email-exists
    await seed({ adminEmail: EMAIL, adminPassword: PASSWORD.slice(0, 7) }); // weak-password
    await seed({ adminPassword: PASSWORD }); // not-configured
    await clearDatabase();
    vi.spyOn(UserModel, 'create').mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));
    await seed({ adminEmail: EMAIL, adminPassword: PASSWORD }); // email-exists, taken meanwhile

    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line).not.toContain(PASSWORD);
      expect(line).not.toContain(PASSWORD.slice(0, 7));
    }
  });
});
