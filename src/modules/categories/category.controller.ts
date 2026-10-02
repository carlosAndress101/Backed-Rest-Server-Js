import type { RequestHandler } from 'express';

import { envelope, pageEnvelope } from '../../core/http/envelope';
import type { PaginationQuery } from '../../core/http/pagination';
import type { CreateCategoryDto, UpdateCategoryDto } from './category.schemas';
import type { CategoriesService } from './category.service';

export type CategoriesController = ReturnType<typeof createCategoriesController>;

/**
 * Thin handlers: read the input validate already parsed, make one service call, send the envelope.
 * `req.user!` is safe because every handler that reads it is routed behind authenticate.
 */
export function createCategoriesController(service: CategoriesService) {
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
    const category = await service.create(req.body as CreateCategoryDto, req.user!.id);
    res.status(201).json(envelope(category));
  };

  const update: RequestHandler = async (req, res) => {
    const { id } = req.params as { id: string };
    const category = await service.update(id, req.body as UpdateCategoryDto);
    res.status(200).json(envelope(category));
  };

  const remove: RequestHandler = async (req, res) => {
    const { id } = req.params as { id: string };
    await service.softDelete(id);
    res.status(204).end();
  };

  return { list, getOne, create, update, remove };
}
