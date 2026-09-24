import { isObjectIdOrHexString, type QueryFilter } from 'mongoose';

import { BadRequestError } from '../../core/errors';

/**
 * The slice of a Mongoose model search needs. The composition root injects the three models
 * (§2.3 rule 4: a module never imports a sibling module).
 */
export interface SearchableModel {
  find(filter: QueryFilter<unknown>): { limit(n: number): PromiseLike<unknown[]> };
  findOne(filter: QueryFilter<unknown>): PromiseLike<unknown> & {
    populate(path: string, select: string): PromiseLike<unknown>;
  };
}

export interface SearchService {
  search(collection: string, term: string): Promise<unknown[]>;
}

export const SEARCH_COLLECTIONS = ['user', 'category', 'product'] as const;
const MAX_RESULTS = 20;

// Regex metacharacters are escaped, so the term matches literally (C8, REL-01).
const escapeRegex = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Cross-model reads only: no schema and nothing of its own is persisted. Keeps the M1 behaviour
 * exactly (design §5.4): the allowlist, `isObjectIdOrHexString` id lookup (active only), the
 * escaped-regex substring search with `sanitizeFilter` on, and at most 20 text results.
 */
export function createSearchService(deps: {
  User: SearchableModel;
  Category: SearchableModel;
  Product: SearchableModel;
}): SearchService {
  const byCollection: Record<string, { model: SearchableModel; fields: string[] }> = {
    user: { model: deps.User, fields: ['name', 'email'] },
    category: { model: deps.Category, fields: ['name'] },
    product: { model: deps.Product, fields: ['name', 'description'] },
  };

  const search = async (collection: string, term: string): Promise<unknown[]> => {
    const target = byCollection[collection];
    if (!target) {
      // The legacy message, kept verbatim (controllers/search.js).
      throw new BadRequestError(`The permitted collections are: ${SEARCH_COLLECTIONS.join(',')}`);
    }

    if (isObjectIdOrHexString(term)) {
      const query = target.model.findOne({ _id: term, state: true });
      // Only the product populates its category, exactly as legacy does.
      const doc = collection === 'product' ? await query.populate('category', 'name') : await query;
      return doc ? [doc] : [];
    }

    const regex = new RegExp(escapeRegex(term), 'i');
    const filter: QueryFilter<unknown> = {
      $or: target.fields.map((field) => ({ [field]: regex })),
      $and: [{ state: true }],
    };
    return target.model.find(filter).limit(MAX_RESULTS);
  };

  return { search };
}
