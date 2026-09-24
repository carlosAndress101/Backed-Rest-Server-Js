// The registry seam (ADR-027, P14), the stored shape (M3 design §1.2, §5.1) and LOG-02 (AM-M3-2). No database needed.
import mongoose from 'mongoose';
import { describe, expect, test, vi } from 'vitest';

import { UserModel } from '../../../src/modules/users';

const SECRET = 'correct-horse-battery-staple';

describe('UserModel', () => {
  test('is the one registered User (ADR-027)', () => {
    expect(mongoose.model('User')).toBe(UserModel);
  });

  test('a second import of the model file reuses the registration instead of throwing OverwriteModelError', async () => {
    vi.resetModules(); // the next import evaluates user.model.ts again; the mongoose registry is kept
    const reloaded = await import('../../../src/modules/users/user.model.js');

    expect(reloaded.UserModel).toBe(UserModel);
    expect(mongoose.modelNames().filter((name) => name === 'User')).toHaveLength(1);
  });

  test('stores the legacy shape, version key included (M4 owns schema changes)', () => {
    const { schema } = UserModel;

    expect(Object.keys(schema.paths).sort()).toEqual([
      '__v',
      '_id',
      'email',
      'google',
      'image',
      'name',
      'password',
      'role',
      'state',
    ]);
    expect(schema.path('name').options).toMatchObject({
      type: String,
      required: [true, 'The name is required'],
    });
    expect(schema.path('email').options).toMatchObject({
      type: String,
      required: [true, 'The email is required'],
      unique: true,
    });
    expect(schema.path('password').options).toMatchObject({
      type: String,
      required: [true, 'The password is required'],
    });
    expect(schema.path('image').options).toEqual({ type: String });
    expect(schema.path('role').options).toMatchObject({ type: String, required: true, default: 'USER_ROLE' });
    expect(schema.path('state').options).toMatchObject({ type: Boolean, default: true });
    expect(schema.path('google').options).toMatchObject({ type: Boolean, default: false });
  });

  test('serializes with id and the uid alias first, and never _id, __v or the password (P13)', () => {
    const user = UserModel.hydrate({
      _id: new mongoose.Types.ObjectId(),
      name: 'Ada',
      email: 'ada@example.com',
      password: '$2b$10$hash',
      role: 'USER_ROLE',
      state: true,
      google: false,
      __v: 0,
    });

    const json = JSON.parse(JSON.stringify(user)) as Record<string, unknown>;

    expect(json).toEqual({
      id: user.id,
      uid: user.id,
      name: 'Ada',
      email: 'ada@example.com',
      role: 'USER_ROLE',
      state: true,
      google: false,
    });
    expect(Object.keys(json).slice(0, 2)).toEqual(['id', 'uid']);
  });

  // AM-M3-2 / LOG-02: a rejected password must not reach err.message or err.stack (REDACT_PATHS covers only
  // err.errors.password.value). Without the path's `cast` message, a cast failure prints the value in all three.
  test.each([
    ['an array', [SECRET]],
    ['an object', { secret: SECRET }],
  ])(
    'a rejected password (%s) never appears in the ValidationError message or stack',
    async (_case, password) => {
      const doc = new UserModel({ name: 'Ada', email: 'ada@example.com', password });

      const error = await doc.validate().then(
        () => undefined,
        (rejection: unknown) => rejection,
      );

      expect(error).toBeInstanceOf(mongoose.Error.ValidationError);
      const { message, stack, errors } = error as mongoose.Error.ValidationError;
      expect(errors.password?.message).toBe('The password must be a string');
      for (const text of [message, stack, errors.password?.message]) expect(text).not.toContain(SECRET);
    },
  );

  test('a missing password fails with a message that carries no value', async () => {
    const error = await new UserModel({ name: 'Ada', email: 'ada@example.com' }).validate().then(
      () => undefined,
      (rejection: unknown) => rejection as mongoose.Error.ValidationError,
    );

    expect(error?.errors.password?.message).toBe('The password is required');
  });
});
