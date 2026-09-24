import bcrypt from 'bcrypt';
import type { Model } from 'mongoose';

import { ConflictError, NotFoundError, ValidationError } from '../../core/errors';
import type { PaginationQuery } from '../../core/http/pagination';
import { DEFAULT_ROLE, ROLES, isRole } from '../../core/security/roles';
import type { User, UserDocument } from './user.model';
import type { CreateUserDto, UpdateUserDto } from './user.schemas';

const BCRYPT_ROUNDS = 10; // as helpers and controllers hash today; async and tuned in M5 (PERF-01)

/** The authenticated caller, as far as the users rules need it. */
export interface Actor {
  role: string;
}

export interface UsersService {
  list(query: PaginationQuery): Promise<{ items: UserDocument[]; total: number }>;
  create(dto: CreateUserDto): Promise<UserDocument>;
  update(id: string, dto: UpdateUserDto, actor: Actor): Promise<UserDocument>;
  softDelete(id: string): Promise<void>;
}

/** The users rules and persistence (ADR-005: the model is injected). Throws AppErrors; knows nothing of HTTP. */
export function createUsersService(deps: { User: Model<User> }): UsersService {
  const { User } = deps;

  return {
    async list(query) {
      const filter = { state: true };
      const [items, total] = await Promise.all([
        User.find(filter).skip(query.offset).limit(query.limit),
        User.countDocuments(filter),
      ]);
      return { items, total };
    },

    async create(dto) {
      // Any account, active or not, owns its email; the unique index is the race backstop (E11000 is also a 409, C1).
      if (await User.exists({ email: dto.email })) throw new ConflictError('Email already registered');
      const password = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
      // SEC-02: a sign-up is always the default role, whatever the client sent.
      return User.create({ name: dto.name, email: dto.email, password, role: DEFAULT_ROLE });
    },

    async update(id, dto, actor) {
      const isAdmin = actor.role === 'ADMIN_ROLE';
      // C6: an explicit whitelist. email, google, image and _id are never writable here; role and state only by an
      // administrator, and silently dropped for anyone else.
      const changes: Partial<User> = {};
      if (isAdmin && dto.role !== undefined) {
        // ADR-007: roles are the code-level enum, not the Role collection.
        if (!isRole(dto.role)) {
          throw new ValidationError([{ path: 'role', message: `must be one of ${ROLES.join(', ')}` }]);
        }
        changes.role = dto.role;
      }
      if (isAdmin && dto.state !== undefined) changes.state = dto.state;
      if (dto.name !== undefined) changes.name = dto.name;
      if (dto.password !== undefined) changes.password = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

      // One atomic find-and-update. An administrator also reaches a soft-deleted user, so state can be turned back on
      // (C6); anyone else acts only on themself (requireSelfOrAdmin), who is active (authenticate).
      const filter = isAdmin ? { _id: id } : { _id: id, state: true };
      const doc = await User.findOneAndUpdate(filter, changes, { returnDocument: 'after' });
      if (!doc) throw new NotFoundError('User not found');
      return doc;
    },

    async softDelete(id) {
      const doc = await User.findOneAndUpdate({ _id: id, state: true }, { state: false });
      if (!doc) throw new NotFoundError('User not found');
    },
  };
}
