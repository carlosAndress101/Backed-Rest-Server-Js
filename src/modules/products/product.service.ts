import type { Model, QueryFilter, UpdateQuery } from 'mongoose';

import { ConflictError, ForbiddenError, NotFoundError } from '../../core/errors';
import type { PaginationQuery } from '../../core/http/pagination';
import { CATALOG_ROLES, type Role } from '../../core/security/roles';
import type { Product, ProductDocument } from './product.model';
import type { CreateProductDto, UpdateProductDto } from './product.schemas';

/**
 * The slice of the categories model this module needs. The composition root injects it (§2.3 rule 4
 * forbids importing a sibling module); only the active-category existence check is used.
 */
export interface CategoryLookup {
  exists(filter: { _id: string; state: boolean }): Promise<unknown>;
}

/** The authenticated caller (req.user), as far as ownership needs it (ADR-039, P31). */
export interface Actor {
  id: string;
  role: string;
}

export interface ProductsService {
  list(query: PaginationQuery): Promise<{ items: ProductDocument[]; total: number }>;
  getActive(id: string): Promise<ProductDocument>;
  create(dto: CreateProductDto, userId: string): Promise<ProductDocument>;
  update(id: string, dto: UpdateProductDto, actor: Actor): Promise<ProductDocument>;
  softDelete(id: string, actor: Actor): Promise<void>;
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

  /**
   * ADR-039: ownership enforced in the write's own filter — a privileged caller's filter never carries `user`,
   * so it reaches (and may change) any active product; anyone else only reaches their own.
   */
  const ownedFilter = (id: string, actor: Actor): QueryFilter<Product> => {
    const filter: QueryFilter<Product> = { _id: id, state: true };
    if (!CATALOG_ROLES.includes(actor.role as Role)) filter.user = actor.id;
    return filter;
  };

  /**
   * When the ownership-filtered write matched nothing, one unprivileged existence check (the same shape
   * `activeOr404` uses) disambiguates 403 (exists, not yours) from 404 (missing or soft-deleted) — the only
   * place this service adds a second read, and only for a non-privileged caller (ADR-039).
   */
  const forbiddenOrMissing = async (
    id: string,
    filter: QueryFilter<Product>,
    action: 'update' | 'delete',
  ): Promise<never> => {
    if (filter.user && (await Product.exists({ _id: id, state: true }))) {
      throw new ForbiddenError(
        `Only the creator, an administrator or VENTAS_ROLE may ${action} this product`,
      );
    }
    throw new NotFoundError('Product not found');
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

    async update(id, dto, actor) {
      const filter = ownedFilter(id, actor);
      const update: UpdateQuery<Product> = {}; // ADR-041: no more `user: actor.id` reassignment
      if (dto.name !== undefined) update.name = dto.name.toUpperCase();
      if (dto.category !== undefined) {
        await activeCategory(dto.category);
        update.category = dto.category;
      }
      if (dto.price !== undefined) update.price = dto.price;
      if (dto.description !== undefined) update.description = dto.description;
      if (dto.available !== undefined) update.available = dto.available;

      // One atomic ownership-filtered find-and-update: a product soft-deleted meanwhile is never renamed, and
      // an owner and a privileged role both succeed with no race between "check" and "write" (ADR-039).
      const doc = await Product.findOneAndUpdate(filter, update, { returnDocument: 'after' })
        .populate('user', 'name')
        .populate('category', 'name');
      if (doc) return doc;
      return forbiddenOrMissing(id, filter, 'update');
    },

    async softDelete(id, actor) {
      const filter = ownedFilter(id, actor);
      const doc = await Product.findOneAndUpdate(filter, { state: false });
      if (doc) return;
      await forbiddenOrMissing(id, filter, 'delete');
    },
  };
}
