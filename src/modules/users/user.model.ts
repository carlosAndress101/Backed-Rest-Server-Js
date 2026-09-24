import mongoose, { Schema, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

import { toJsonPlugin } from '../../core/database/to-json.plugin';
import { DEFAULT_ROLE } from '../../core/security/roles';

// The stored 2.x shape, field for field. M4 adds timestamps, indexes, the role enum and email
// normalisation to this schema.
const userSchema = new Schema({
  name: { type: String, required: [true, 'The name is required'] },
  email: { type: String, required: [true, 'The email is required'], unique: true },
  // LOG-02 (AM-M3-2): no message on this path may carry the value. A cast failure would otherwise put a non-string
  // password into err.message and err.stack, which REDACT_PATHS does not cover.
  password: {
    type: String,
    required: [true, 'The password is required'],
    cast: 'The password must be a string',
  },
  image: { type: String },
  role: { type: String, required: true, default: DEFAULT_ROLE },
  state: { type: Boolean, default: true },
  google: { type: Boolean, default: false },
});
toJsonPlugin(userSchema, { hidden: ['password'], uidAlias: true }); // id + the deprecated uid (4.0.0); never the password

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;

// ADR-027: the sole registrant of 'User'.
// The guard makes a second import idempotent (Vitest and tsx can load a file twice).
export const UserModel: Model<User> =
  (mongoose.models.User as Model<User> | undefined) ?? mongoose.model<User>('User', userSchema);
