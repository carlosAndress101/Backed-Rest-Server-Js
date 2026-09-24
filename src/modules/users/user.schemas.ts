import { z } from 'zod';

export { paginationQuerySchema } from '../../core/http/pagination';

// A well-formed id only: whether the user exists is the service's question (404), not validation's (VAL-01).
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a Mongo id');

export const userIdParams = z.object({ id: objectId });

// SEC-02: sign-up has no role field; anything else in the body is stripped.
export const createUserBody = z.object({
  name: z.string().trim().min(1),
  email: z.email(),
  password: z.string().min(8),
});

// Every field is optional, so an absent body is the empty update. role and state are applied, and role checked
// against ROLES, only for an administrator (the service, C6); for anyone else they are dropped.
export const updateUserBody = z
  .object({
    name: z.string().trim().min(1).optional(),
    password: z.string().min(8).optional(),
    role: z.string().optional(),
    state: z.boolean().optional(),
  })
  .default({});

export type CreateUserDto = z.infer<typeof createUserBody>;
export type UpdateUserDto = z.infer<typeof updateUserBody>;
