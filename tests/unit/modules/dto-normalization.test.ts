// DB-02 (M4 design §10.3, AM-M4-5): the DTOs normalize and cap each field the way the schema stores it. Mongoose also
// casts query filters through the schema's trim/lowercase/uppercase, so these transforms are a second layer: this file
// pins them where no Mongoose casting runs.
import { describe, expect, test } from 'vitest';
import type { ZodType } from 'zod';

import { loginBody } from '../../../src/modules/auth/auth.schemas';
import { createCategoryBody, updateCategoryBody } from '../../../src/modules/categories/category.schemas';
import { createProductBody, updateProductBody } from '../../../src/modules/products/product.schemas';
import { createUserBody, updateUserBody } from '../../../src/modules/users/user.schemas';

const CATEGORY = '64b7f0c2a1b2c3d4e5f60718';
const parse = (schema: ZodType, input: object) => schema.safeParse(input);
const paths = (schema: ZodType, input: object) => {
  const result = parse(schema, input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('email: trimmed, checked, then lowercased (sign-up and login alike)', () => {
  const signUp = (email: string) => ({ name: 'Ada', email, password: 'correct-horse-battery' });
  const login = (email: string) => ({ email, password: 'x' });

  test.each([
    ['sign-up', createUserBody, signUp],
    ['login', loginBody, login],
  ] as const)('%s stores and looks up the normalized address', (_dto, schema, body) => {
    expect(parse(schema, body('  Ada.Lovelace@Example.COM ')).data).toMatchObject({
      email: 'ada.lovelace@example.com',
    });
  });

  test.each([
    ['the Kelvin sign (U+212A), which lowercases to an ASCII k', 'Kda@example.com'],
    ['a Cyrillic a (U+0430)', 'аda@example.com'],
    ['a zero-width space (U+200B)', 'ada@example.com​'],
    ['no domain dot', 'ada@example'],
  ])('%s is refused on sign-up and login', (_case, email) => {
    expect(paths(createUserBody, signUp(email))).toEqual(['email']);
    expect(paths(loginBody, login(email))).toEqual(['email']);
  });

  test('254 characters is the cap, counted after trimming', () => {
    const at254 = `${'e'.repeat(242)}@example.com`;

    expect(parse(createUserBody, signUp(`  ${at254}  `)).success).toBe(true);
    expect(paths(createUserBody, signUp(`e${at254}`))).toEqual(['email']);
    expect(paths(loginBody, login(`e${at254}`))).toEqual(['email']);
  });
});

describe('names and descriptions: normalized as stored, then capped', () => {
  test.each([
    [
      'user sign-up',
      createUserBody,
      (name: string) => ({ name, email: 'a@example.com', password: 'correct-horse' }),
    ],
    ['user update', updateUserBody, (name: string) => ({ name })],
  ] as const)('a %s name is trimmed and at most 120 characters', (_dto, schema, body) => {
    expect(parse(schema, body(`  ${'n'.repeat(120)}  `)).data).toMatchObject({ name: 'n'.repeat(120) });
    expect(paths(schema, body('n'.repeat(121)))).toEqual(['name']);
  });

  test.each([
    ['category create', createCategoryBody, (name: string) => ({ name })],
    ['category update', updateCategoryBody, (name: string) => ({ name })],
    ['product create', createProductBody, (name: string) => ({ name, category: CATEGORY })],
    ['product update', updateProductBody, (name: string) => ({ name })],
  ] as const)('a %s name is trimmed, uppercased, then capped at 120', (_dto, schema, body) => {
    expect(parse(schema, body('  coffee  ')).data).toMatchObject({ name: 'COFFEE' });
    expect(parse(schema, body('ß'.repeat(60))).data).toMatchObject({ name: 'SS'.repeat(60) }); // 120 once stored
    expect(paths(schema, body('ß'.repeat(61)))).toEqual(['name']); // 122 once stored
    expect(paths(schema, body('   '))).toEqual(['name']);
  });

  test.each([
    ['product create', createProductBody, { name: 'P', category: CATEGORY }],
    ['product update', updateProductBody, {}],
  ] as const)('a %s description is trimmed, then capped at 2000', (_dto, schema, base) => {
    expect(parse(schema, { ...base, description: ` ${'d'.repeat(2000)} ` }).data).toMatchObject({
      description: 'd'.repeat(2000),
    });
    expect(paths(schema, { ...base, description: 'd'.repeat(2001) })).toEqual(['description']);
  });

  test('a price below 0 is refused', () => {
    expect(paths(createProductBody, { name: 'P', category: CATEGORY, price: -0.01 })).toEqual(['price']);
    expect(paths(updateProductBody, { price: -1 })).toEqual(['price']);
  });
});
