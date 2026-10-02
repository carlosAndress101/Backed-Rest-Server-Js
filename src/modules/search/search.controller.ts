import type { RequestHandler } from 'express';

import { envelope } from '../../core/http/envelope';
import type { SearchService } from './search.service';

export type SearchController = ReturnType<typeof createSearchController>;

/**
 * One thin handler: read the input, make the one service call, send the envelope. The collection
 * policy lives in the routes (C8/SEC-05).
 */
export function createSearchController(service: SearchService) {
  const search: RequestHandler = async (req, res) => {
    const { collection, term } = req.params as { collection: string; term: string };
    res.status(200).json(envelope(await service.search(collection, term)));
  };

  return { search };
}
