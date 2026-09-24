import { z } from 'zod';

export { paginationQuerySchema } from '../../core/http/pagination';

// A well-formed id only: whether the product exists is the service's question (404), not validation's (VAL-01).
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a Mongo id');

export const productIdParams = z.object({ id: objectId });

// No _id, no user, no image, no state: the missing fields are what closes the VAL-02 mass assignment.
export const createProductBody = z.object({
  name: z.string().trim().min(1),
  price: z.number().min(0).optional(),
  category: objectId,
  description: z.string().optional(),
  available: z.boolean().optional(),
});

export const updateProductBody = z.object({
  name: z.string().trim().min(1).optional(),
  price: z.number().min(0).optional(),
  category: objectId.optional(),
  description: z.string().optional(),
  available: z.boolean().optional(),
});

export type CreateProductDto = z.infer<typeof createProductBody>;
export type UpdateProductDto = z.infer<typeof updateProductBody>;
