import { z } from 'zod';

export { paginationQuerySchema } from '../../core/http/pagination';

// A well-formed id only: whether the category exists is the service's question (404), not validation's (VAL-01).
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a Mongo id');

export const categoryIdParams = z.object({ id: objectId });
export const createCategoryBody = z.object({ name: z.string().trim().min(1) });
export const updateCategoryBody = z.object({ name: z.string().trim().min(1) });

export type CreateCategoryDto = z.infer<typeof createCategoryBody>;
export type UpdateCategoryDto = z.infer<typeof updateCategoryBody>;
