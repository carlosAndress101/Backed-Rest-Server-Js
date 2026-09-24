// The registry seam (ADR-027, P14), the M4 stored shape (design §2.1) and LOG-02 (AM-M3-2). No database needed.
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

  test('stores the M4 shape: timestamps, caps, the role enum and tokenVersion, and no __v', () => {
    const { schema } = UserModel;

    expect(Object.keys(schema.paths).sort()).toEqual([
      '_id',
      'createdAt',
      'email',
      'google',
      'image',
      'name',
      'password',
      'role',
      'state',
      'tokenVersion',
      'updatedAt',
    ]);
    expect(schema.path('name').options).toMatchObject({
      type: String,
      required: [true, 'The name is required'],
      trim: true,
      maxlength: 120,
    });
    expect(schema.path('email').options).toMatchObject({
      type: String,
      required: [true, 'The email is required'],
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: expect.any(RegExp),
    });
    expect(schema.path('password').options).toMatchObject({
      type: String,
      required: [true, 'The password is required'],
    });
    expect(schema.path('image').options).toMatchObject({ type: String, trim: true, maxlength: 2048 });
    expect(schema.path('role').options).toMatchObject({
      type: String,
      required: true,
      default: 'USER_ROLE',
      enum: ['ADMIN_ROLE', 'USER_ROLE', 'VENTAS_ROLE'],
    });
    expect(schema.path('state').options).toMatchObject({ type: Boolean, required: true, default: true });
    expect(schema.path('google').options).toMatchObject({ type: Boolean, required: true, default: false });
    expect(schema.path('tokenVersion').options).toMatchObject({
      type: Number,
      required: true,
      default: 0,
      min: 0,
    });
    expect(schema.get('versionKey')).toBe(false);
    expect(schema.get('timestamps')).toBe(true);
  });

  test('serializes with id and the uid alias first, hides password and tokenVersion, and keeps the timestamps', () => {
    const created = new Date('2026-09-24T00:00:00.000Z');
    const updated = new Date('2026-09-24T01:00:00.000Z');
    const user = UserModel.hydrate({
      _id: new mongoose.Types.ObjectId(),
      name: 'Ada',
      email: 'ada@example.com',
      password: '$2b$10$hash',
      role: 'USER_ROLE',
      state: true,
      google: false,
      tokenVersion: 3,
      createdAt: created,
      updatedAt: updated,
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
      createdAt: created.toISOString(),
      updatedAt: updated.toISOString(),
    });
    expect(Object.keys(json).slice(0, 2)).toEqual(['id', 'uid']);
    expect(json).not.toHaveProperty('password');
    expect(json).not.toHaveProperty('tokenVersion');
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
