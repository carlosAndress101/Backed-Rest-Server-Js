import { z } from 'zod';

// A well-formed id only: whether the record exists is the service's question (404), not validation's (VAL-01).
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a Mongo id');

/** The records that carry an image. Anything else is 422, and never reaches the parser (C10). */
export const mediaParams = z.object({ collection: z.enum(['user', 'product']), id: objectId });

export type MediaParams = z.infer<typeof mediaParams>;
export type MediaCollection = MediaParams['collection'];
