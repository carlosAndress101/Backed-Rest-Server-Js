import { z } from 'zod';

import { passwordPolicy } from '../../core/security/password';

export { paginationQuerySchema } from '../../core/http/pagination';

// A well-formed id only: whether the user exists is the service's question (404), not validation's (VAL-01).
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a Mongo id');

export const userIdParams = z.object({ id: objectId });

// DB-02 (§10.3): the email is trimmed, checked, then lowercased, so the uniqueness pre-check matches the stored
// value (the schema lowercases too). The format check comes before the lowercasing: a non-ASCII look-alike such
// as the Kelvin sign (U+212A) is refused, never folded into an ASCII address. 254 mirrors the schema cap (AM-M4-5).
const email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((value) => value.toLowerCase());

// AM-M4-5: every schema cap has its DTO mirror, so oversize input is a 422, never the C1 400.
const name = z.string().trim().min(1).max(120);

// SEC-02: sign-up has no role field; anything else in the body is stripped.
export const createUserBody = z.object({
  name,
  email,
  password: passwordPolicy, // P26: 8 characters to 72 bytes
});

// Every field is optional, so an absent body is the empty update. role and state are applied, and role checked
// against ROLES, only for an administrator (the service, C6); for anyone else they are dropped.
export const updateUserBody = z
  .object({
    name: name.optional(),
    password: passwordPolicy.optional(),
    role: z.string().optional(),
    state: z.boolean().optional(),
  })
  .default({});

export type CreateUserDto = z.infer<typeof createUserBody>;
export type UpdateUserDto = z.infer<typeof updateUserBody>;
