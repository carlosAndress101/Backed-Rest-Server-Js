import { z } from 'zod';

export { paginationQuerySchema } from '../../core/http/pagination';

// A well-formed id only: whether the product exists is the service's question (404), not validation's (VAL-01).
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a Mongo id');

export const productIdParams = z.object({ id: objectId });

// Each field is normalized as the schema stores it, then capped (AM-M4-5), so oversize input is a 422, never the
// C1 400. Uppercasing can lengthen a name ('ß' → 'SS'), so the name cap is checked on the stored form.
const name = z.string().trim().toUpperCase().min(1).max(120);
const description = z.string().trim().max(2000);

// No _id, no user, no image, no state: the missing fields are what closes the VAL-02 mass assignment.
export const createProductBody = z.object({
  name,
  price: z.number().min(0).optional(),
  category: objectId,
  description: description.optional(),
  available: z.boolean().optional(),
});

export const updateProductBody = z.object({
  name: name.optional(),
  price: z.number().min(0).optional(),
  category: objectId.optional(),
  description: description.optional(),
  available: z.boolean().optional(),
});

export type CreateProductDto = z.infer<typeof createProductBody>;
export type UpdateProductDto = z.infer<typeof updateProductBody>;
