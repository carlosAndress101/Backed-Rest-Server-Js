import type { RequestHandler } from 'express';

import { envelope, pageEnvelope } from '../../core/http/envelope';
import type { PaginationQuery } from '../../core/http/pagination';
import type { CreateProductDto, UpdateProductDto } from './product.schemas';
import type { ProductsService } from './product.service';

export type ProductsController = ReturnType<typeof createProductsController>;

/**
 * Thin handlers: read the input validate already parsed, make one service call, send the envelope.
 * `req.user!` is safe because every handler that reads it is routed behind authenticate.
 */
export function createProductsController(service: ProductsService) {
  const list: RequestHandler = async (req, res) => {
    const query = req.query as unknown as PaginationQuery;
    const { items, total } = await service.list(query);
    res.status(200).json(pageEnvelope(items, { total, limit: query.limit, offset: query.offset }));
  };

  const getOne: RequestHandler = async (req, res) => {
    const { id } = req.params as { id: string };
    res.status(200).json(envelope(await service.getActive(id)));
  };

  const create: RequestHandler = async (req, res) => {
    const product = await service.create(req.body as CreateProductDto, req.user!.id);
    res.status(201).json(envelope(product));
  };

  const update: RequestHandler = async (req, res) => {
    const { id } = req.params as { id: string };
    const product = await service.update(id, req.body as UpdateProductDto, req.user!.id);
    res.status(200).json(envelope(product));
  };

  const remove: RequestHandler = async (req, res) => {
    const { id } = req.params as { id: string };
    await service.softDelete(id);
    res.status(204).end();
  };

  return { list, getOne, create, update, remove };
}
