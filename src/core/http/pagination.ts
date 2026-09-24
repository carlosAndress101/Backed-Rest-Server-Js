import { z } from 'zod';

/** The one list-route query schema (DUP-01): categories, products and users. */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(5),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
