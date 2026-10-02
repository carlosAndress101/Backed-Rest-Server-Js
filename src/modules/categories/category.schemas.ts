import { z } from 'zod';

export { paginationQuerySchema } from '../../core/http/pagination';

// A well-formed id only: whether the category exists is the service's question (404), not validation's (VAL-01).
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a Mongo id');

export const categoryIdParams = z.object({ id: objectId });

// Normalized as the schema stores it (trim, uppercase), then capped (AM-M4-5): uppercasing can lengthen a name
// ('ß' → 'SS'), so the cap is checked on the stored form and oversize input is a 422, never the C1 400.
const name = z.string().trim().toUpperCase().min(1).max(120);

export const createCategoryBody = z.object({ name });
export const updateCategoryBody = z.object({ name });

export type CreateCategoryDto = z.infer<typeof createCategoryBody>;
export type UpdateCategoryDto = z.infer<typeof updateCategoryBody>;
