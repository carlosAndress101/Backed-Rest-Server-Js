import type { RequestHandler } from 'express';

import { envelope, pageEnvelope } from '../../core/http/envelope';
import type { PaginationQuery } from '../../core/http/pagination';
import type { CreateUserDto, UpdateUserDto } from './user.schemas';
import type { UsersService } from './user.service';

export type UsersController = ReturnType<typeof createUsersController>;

/**
 * Thin handlers: read the input validate already parsed, make one service call, send the envelope.
 * `req.user!` is safe because every handler that reads it is routed behind authenticate.
 */
export function createUsersController(service: UsersService) {
  const list: RequestHandler = async (req, res) => {
    const query = req.query as unknown as PaginationQuery;
    const { items, total } = await service.list(query);
    res.status(200).json(pageEnvelope(items, { total, limit: query.limit, offset: query.offset }));
  };

  const create: RequestHandler = async (req, res) => {
    const user = await service.create(req.body as CreateUserDto);
    res.status(201).json(envelope(user));
  };

  const update: RequestHandler = async (req, res) => {
    const { id } = req.params as { id: string };
    const user = await service.update(id, req.body as UpdateUserDto, req.user!);
    res.status(200).json(envelope(user));
  };

  const remove: RequestHandler = async (req, res) => {
    const { id } = req.params as { id: string };
    await service.softDelete(id, req.user!);
    res.status(204).end();
  };

  return { list, create, update, remove };
}
