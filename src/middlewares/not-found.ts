import type { RequestHandler } from 'express';

import { NotFoundError } from '../core/errors';

/** C2: every route nothing else answered. */
export const notFound: RequestHandler = () => {
  throw new NotFoundError('Route not found');
};
