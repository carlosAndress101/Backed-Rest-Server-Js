// The M4 user indexes and DB-backed model behaviour (design §3.1, §10.6) through the M3 harness (D-11).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { UserModel } from '../../../src/modules/users';
import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';

describe('UserModel (database)', () => {
  beforeAll(async () => {
    await startTestApp();
    await UserModel.init(); // build the schema indexes from §3.1
  });

  afterAll(stopTestApp);

  beforeEach(clearDatabase);

  test('the built indexes equal the §3.1 catalogue', async () => {
    const indexes = await UserModel.listIndexes();

    expect(indexes.map((index) => index.name).sort()).toEqual(['_id_', 'email_1', 'state_1']);
    expect(indexes.find((index) => index.name === 'email_1')).toMatchObject({
      key: { email: 1 },
      unique: true,
    });
    const state = indexes.find((index) => index.name === 'state_1');
    expect(state).toMatchObject({ key: { state: 1 } });
    expect(state?.unique).toBeFalsy();
  });

  test('a case-variant duplicate email is 11000, and the stored email is lowercased', async () => {
    await UserModel.create({ name: 'Ada', email: 'Ada@Example.com', password: 'hash' });

    expect((await UserModel.findOne({ email: 'ada@example.com' }))?.email).toBe('ada@example.com');

    await expect(
      UserModel.create({ name: 'Grace', email: 'ADA@EXAMPLE.COM', password: 'hash' }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  test('toJSON hides password and tokenVersion and exposes id, uid and state', async () => {
    const user = await UserModel.create({ name: 'Ada', email: 'ada@example.com', password: 'hash' });

    const json = JSON.parse(JSON.stringify(user)) as Record<string, unknown>;

    expect(json).toMatchObject({
      id: user.id,
      uid: user.id,
      name: 'Ada',
      email: 'ada@example.com',
      state: true,
    });
    expect(json).not.toHaveProperty('password');
    expect(json).not.toHaveProperty('tokenVersion');
    expect(json).not.toHaveProperty('_id');
  });
});
