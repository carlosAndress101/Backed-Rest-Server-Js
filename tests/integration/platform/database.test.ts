import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { clearDatabase, startTestApp, stopTestApp } from '../../helpers/app';

describe('SEC-14: query hardening applies to every model', () => {
  beforeAll(async () => {
    await startTestApp(); // loads src/app, which registers every model
  });

  beforeEach(clearDatabase);

  afterAll(stopTestApp);

  test('strictQuery and sanitizeFilter are on', () => {
    expect(mongoose.get('strictQuery')).toBe(true);
    expect(mongoose.get('sanitizeFilter')).toBe(true);
  });

  test('an operator object in a filter value rejects with CastError instead of matching', async () => {
    const User = mongoose.model('User');
    await User.create({ name: 'Victim', email: 'victim@example.com', password: 'x', role: 'USER_ROLE' });

    await expect(User.findOne({ email: { $ne: null } })).rejects.toMatchObject({ name: 'CastError' });
  });

  test('a filter on a path outside the schema is stripped, not matched', async () => {
    const Category = mongoose.model('Category');
    const owner = new mongoose.Types.ObjectId();
    await Category.create([
      { name: 'STRICT ONE', user: owner },
      { name: 'STRICT TWO', user: owner },
    ]);

    await expect(Category.countDocuments({ notInTheSchema: 'anything' })).resolves.toBe(2);
  });

  test('top-level $or/$and with regular expressions still work (the legacy search filters)', async () => {
    const Category = mongoose.model('Category');
    await Category.create({ name: 'ESPRESSO', user: new mongoose.Types.ObjectId() });

    const found = await Category.find({ $or: [{ name: /press/i }], $and: [{ state: true }] });

    expect(found.map((category) => category.get('name'))).toEqual(['ESPRESSO']);
  });
});
