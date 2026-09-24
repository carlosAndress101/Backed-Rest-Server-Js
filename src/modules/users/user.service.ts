import type { Model } from 'mongoose';

import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import type { PaginationQuery } from '../../core/http/pagination';
import { hashPassword } from '../../core/security/password';
import { DEFAULT_ROLE, ROLES, isRole } from '../../core/security/roles';
import type { User, UserDocument } from './user.model';
import type { CreateUserDto, UpdateUserDto } from './user.schemas';

/** The authenticated caller (req.user), as far as the users rules need it. */
export interface Actor {
  /** The caller's own id: AM-M5-10 tells their own account from another's. */
  id: string;
  role: string;
}

// AM-M5-10: a token alone must not change its own password; that needs the current one (ADR-033).
const OWN_PASSWORD = 'change your own password with PUT /api/auth/password';

export interface UsersService {
  list(query: PaginationQuery): Promise<{ items: UserDocument[]; total: number }>;
  create(dto: CreateUserDto): Promise<UserDocument>;
  update(id: string, dto: UpdateUserDto, actor: Actor): Promise<UserDocument>;
  softDelete(id: string, actor: Actor): Promise<void>;
}

/** The users rules and persistence (ADR-005: the model is injected). Throws AppErrors; knows nothing of HTTP. */
export function createUsersService(deps: {
  User: Model<User>;
  /** config.auth.bcryptCost (ADR-035): every hash this service writes. */
  bcryptCost: number;
}): UsersService {
  const { User, bcryptCost } = deps;

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
      const password = await hashPassword(dto.password, bcryptCost);
      // SEC-02: a sign-up is always the default role, whatever the client sent.
      return User.create({ name: dto.name, email: dto.email, password, role: DEFAULT_ROLE });
    },

    async update(id, dto, actor) {
      const isAdmin = actor.role === 'ADMIN_ROLE';
      // The route id is hex in either case and Mongoose casts both to the same ObjectId, so compare it that way:
      // an administrator must not reach their own account through an uppercase spelling of their id.
      const isSelf = id.toLowerCase() === actor.id.toLowerCase();
      // AM-M5-10: a password here is only an administrator resetting someone else's (any role, admins included,
      // changes their own through PUT /api/auth/password). Checked before anything is hashed or written.
      if (dto.password !== undefined && (isSelf || !isAdmin)) {
        throw new ValidationError([{ path: 'password', message: OWN_PASSWORD }]);
      }
      // ADR-042, refined by AM-M6-3: an administrator may not use their own PUT to change what their own role or
      // active state actually is — the last-administrator-lockout guard. An echo of the current role, or
      // state: true, is not a real change and passes, so a client that PUTs a whole profile does not break.
      if (isSelf && isAdmin && ((dto.role !== undefined && dto.role !== actor.role) || dto.state === false)) {
        throw new ForbiddenError('Ask another administrator to change your own role or active state');
      }
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
      const reset = dto.password !== undefined;
      if (reset) changes.password = await hashPassword(dto.password!, bcryptCost);

      // One atomic find-and-update. An administrator also reaches a soft-deleted user, so state can be turned back on
      // (C6); anyone else acts only on themself (authorize's selfParam), who is active (authenticate). An administrator's
      // password reset bumps tokenVersion in that same write, so every session of the user dies with it (ADR-033).
      const filter = isAdmin ? { _id: id } : { _id: id, state: true };
      const update = reset ? { $set: changes, $inc: { tokenVersion: 1 } } : changes;
      const doc = await User.findOneAndUpdate(filter, update, { returnDocument: 'after' });
      if (!doc) throw new NotFoundError('User not found');
      return doc;
    },

    async softDelete(id, actor) {
      // ADR-042: nobody may target their own account with DELETE, whatever their role — no query, no race window.
      if (id.toLowerCase() === actor.id.toLowerCase()) {
        throw new ForbiddenError('You cannot delete your own account');
      }
      const doc = await User.findOneAndUpdate({ _id: id, state: true }, { state: false });
      if (!doc) throw new NotFoundError('User not found');
    },
  };
}
