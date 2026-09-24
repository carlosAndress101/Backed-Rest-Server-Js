import type { Model } from 'mongoose';

import { ConflictError, NotFoundError } from '../../core/errors';
import type { PaginationQuery } from '../../core/http/pagination';
import type { Category, CategoryDocument } from './category.model';
import type { CreateCategoryDto, UpdateCategoryDto } from './category.schemas';

export interface CategoriesService {
  list(query: PaginationQuery): Promise<{ items: CategoryDocument[]; total: number }>;
  getActive(id: string): Promise<CategoryDocument>;
  create(dto: CreateCategoryDto, userId: string): Promise<CategoryDocument>;
  update(id: string, dto: UpdateCategoryDto, userId: string): Promise<CategoryDocument>;
  softDelete(id: string): Promise<void>;
}

// The collation of the name_active_unique index (§3.1): case variants are the same name.
const NAME_COLLATION = { locale: 'en', strength: 2 };

/** The categories rules and persistence (ADR-005: the model is injected). Throws AppErrors; knows nothing of HTTP. */
export function createCategoriesService(deps: { Category: Model<Category> }): CategoriesService {
  const { Category } = deps;

  // find-active-or-404: a soft-deleted category is as missing as one that never existed.
  const activeOr404 = async (id: string) => {
    const doc = await Category.findOne({ _id: id, state: true }).populate('user', 'name');
    if (!doc) throw new NotFoundError('Category not found');
    return doc;
  };

  return {
    async list(query) {
      const filter = { state: true };
      const [items, total] = await Promise.all([
        Category.find(filter).skip(query.offset).limit(query.limit).populate('user', 'name'),
        Category.countDocuments(filter),
      ]);
      return { items, total };
    },

    getActive: activeOr404,

    async create(dto, userId) {
      const name = dto.name.trim().toUpperCase(); // as the schema stores it
      // §10.3: the pre-check compares as the unique index does, so a case variant gets this message. The index stays
      // the race backstop: E11000 is also a 409 (C1).
      if (await Category.exists({ name, state: true }).collation(NAME_COLLATION)) {
        throw new ConflictError('Category already exists');
      }
      return Category.create({ name, user: userId });
    },

    async update(id, dto, userId) {
      // One atomic find-active-and-update: a category soft-deleted meanwhile is never renamed.
      const doc = await Category.findOneAndUpdate(
        { _id: id, state: true },
        { name: dto.name.toUpperCase(), user: userId },
        { returnDocument: 'after' },
      ).populate('user', 'name');
      if (!doc) throw new NotFoundError('Category not found');
      return doc;
    },

    async softDelete(id) {
      const doc = await Category.findOneAndUpdate({ _id: id, state: true }, { state: false });
      if (!doc) throw new NotFoundError('Category not found');
    },
  };
}
