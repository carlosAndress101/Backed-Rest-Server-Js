import type { Model, UpdateQuery } from 'mongoose';

import { ConflictError, NotFoundError } from '../../core/errors';
import type { PaginationQuery } from '../../core/http/pagination';
import type { Product, ProductDocument } from './product.model';
import type { CreateProductDto, UpdateProductDto } from './product.schemas';

/**
 * The slice of the categories model this module needs. The composition root injects it (§2.3 rule 4
 * forbids importing a sibling module); only the active-category existence check is used.
 */
export interface CategoryLookup {
  exists(filter: { _id: string; state: boolean }): Promise<unknown>;
}

export interface ProductsService {
  list(query: PaginationQuery): Promise<{ items: ProductDocument[]; total: number }>;
  getActive(id: string): Promise<ProductDocument>;
  create(dto: CreateProductDto, userId: string): Promise<ProductDocument>;
  update(id: string, dto: UpdateProductDto, userId: string): Promise<ProductDocument>;
  softDelete(id: string): Promise<void>;
}

// The collation of the name_active_unique index (§3.1): case variants are the same name.
const NAME_COLLATION = { locale: 'en', strength: 2 };

/**
 * The products rules and persistence (ADR-005: the models are injected; Category is a dependency,
 * never imported here). Throws AppErrors; knows nothing of HTTP.
 */
export function createProductsService(deps: {
  Product: Model<Product>;
  Category: CategoryLookup;
}): ProductsService {
  const { Product, Category } = deps;

  // find-active-or-404: a soft-deleted product is as missing as one that never existed.
  const activeOr404 = async (id: string) => {
    const doc = await Product.findOne({ _id: id, state: true })
      .populate('user', 'name')
      .populate('category', 'name');
    if (!doc) throw new NotFoundError('Product not found');
    return doc;
  };

  // A product must reference a category that exists and is active.
  const activeCategory = async (id: string) => {
    if (!(await Category.exists({ _id: id, state: true }))) throw new NotFoundError('Category not found');
  };

  return {
    async list(query) {
      const filter = { state: true };
      const [items, total] = await Promise.all([
        Product.find(filter)
          .skip(query.offset)
          .limit(query.limit)
          .populate('user', 'name')
          .populate('category', 'name'),
        Product.countDocuments(filter),
      ]);
      return { items, total };
    },

    getActive: activeOr404,

    async create(dto, userId) {
      const name = dto.name.trim().toUpperCase(); // as the schema stores it
      // §10.3: the pre-check compares as the unique index does, so a case variant gets this message. The index stays
      // the race backstop: E11000 is also a 409 (C1).
      if (await Product.exists({ name, state: true }).collation(NAME_COLLATION)) {
        throw new ConflictError('Product already exists');
      }
      await activeCategory(dto.category);
      return Product.create({
        name,
        user: userId,
        category: dto.category,
        price: dto.price,
        description: dto.description,
        available: dto.available,
      });
    },

    async update(id, dto, userId) {
      const update: UpdateQuery<Product> = { user: userId };
      if (dto.name !== undefined) update.name = dto.name.toUpperCase();
      if (dto.category !== undefined) {
        await activeCategory(dto.category);
        update.category = dto.category;
      }
      if (dto.price !== undefined) update.price = dto.price;
      if (dto.description !== undefined) update.description = dto.description;
      if (dto.available !== undefined) update.available = dto.available;

      // One atomic find-active-and-update: a product soft-deleted meanwhile is never renamed.
      const doc = await Product.findOneAndUpdate({ _id: id, state: true }, update, {
        returnDocument: 'after',
      })
        .populate('user', 'name')
        .populate('category', 'name');
      if (!doc) throw new NotFoundError('Product not found');
      return doc;
    },

    async softDelete(id) {
      const doc = await Product.findOneAndUpdate({ _id: id, state: true }, { state: false });
      if (!doc) throw new NotFoundError('Product not found');
    },
  };
}
