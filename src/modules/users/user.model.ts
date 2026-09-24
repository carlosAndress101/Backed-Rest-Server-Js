import mongoose, { Schema, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

import { toJsonPlugin } from '../../core/database/to-json.plugin';
import { DEFAULT_ROLE, ROLES } from '../../core/security/roles';

// M4 §2.1: timestamps, length caps, the role enum and email normalization; indexes are explicit (§3.1).
// LOG-02 (T4.2G F1): every validator has a fixed message. Mongoose's defaults embed the rejected value, which
// reaches a log line through res.err.
const userSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'The name is required'],
      trim: true,
      maxlength: [120, 'The name must be at most 120 characters'],
    },
    email: {
      type: String,
      required: [true, 'The email is required'],
      trim: true,
      lowercase: true,
      maxlength: [254, 'The email must be at most 254 characters'],
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'The email format is invalid'],
    },
    // LOG-02 (AM-M3-2): no message on this path may carry the value. A cast failure would otherwise put a non-string
    // password into err.message and err.stack, which REDACT_PATHS does not cover.
    // AM-M4-1 / P20: never read unless a query asks for '+password' (only the login does), so no find, populate or
    // .lean() read can carry the hash, whatever serializes it.
    password: {
      type: String,
      required: [true, 'The password is required'],
      cast: 'The password must be a string',
      select: false,
    },
    // AM-M4-4: no pattern validator (Google avatar URLs are https://lh3.googleusercontent.com/…), just a cap.
    image: { type: String, trim: true, maxlength: [2048, 'The image must be at most 2048 characters'] },
    role: {
      type: String,
      required: true,
      enum: { values: ROLES, message: 'The role is not a valid role' },
      default: DEFAULT_ROLE,
    },
    state: { type: Boolean, required: true, default: true },
    google: { type: Boolean, required: true, default: false },
    // M5 revocation counter, hidden from JSON
    tokenVersion: {
      type: Number,
      required: true,
      default: 0,
      min: [0, 'The token version cannot be negative'],
    },
  },
  { versionKey: false, timestamps: true },
);

// §3.1: the plain unique email index is effectively case-insensitive because the field lowercases.
userSchema.index({ email: 1 }, { name: 'email_1', unique: true });
userSchema.index({ state: 1 }, { name: 'state_1' });

toJsonPlugin(userSchema, { hidden: ['password', 'tokenVersion'], uidAlias: true }); // id + the deprecated uid (4.0.0)

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;

// ADR-027: the sole registrant of 'User'.
// The guard makes a second import idempotent (Vitest and tsx can load a file twice).
export const UserModel: Model<User> =
  (mongoose.models.User as Model<User> | undefined) ?? mongoose.model<User>('User', userSchema);
