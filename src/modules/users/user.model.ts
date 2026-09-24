import mongoose, { Schema, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

import { toJsonPlugin } from '../../core/database/to-json.plugin';
import { DEFAULT_ROLE, ROLES } from '../../core/security/roles';

// M4 §2.1: timestamps, length caps, the role enum and email normalization; indexes are explicit (§3.1).
const userSchema = new Schema(
  {
    name: { type: String, required: [true, 'The name is required'], trim: true, maxlength: 120 },
    email: {
      type: String,
      required: [true, 'The email is required'],
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      unique: true,
    },
    // LOG-02 (AM-M3-2): no message on this path may carry the value. A cast failure would otherwise put a non-string
    // password into err.message and err.stack, which REDACT_PATHS does not cover.
    // AM-M4-1: `select: false` lands in T4.3, in the same commit as the auth `+password` read.
    password: {
      type: String,
      required: [true, 'The password is required'],
      cast: 'The password must be a string',
    },
    // AM-M4-4: no pattern validator (Google avatar URLs are https://lh3.googleusercontent.com/…), just a cap.
    image: { type: String, trim: true, maxlength: 2048 },
    role: { type: String, required: true, enum: ROLES, default: DEFAULT_ROLE },
    state: { type: Boolean, required: true, default: true },
    google: { type: Boolean, required: true, default: false },
    tokenVersion: { type: Number, required: true, default: 0, min: 0 }, // M5 revocation counter, hidden from JSON
  },
  { versionKey: false, timestamps: true },
);

toJsonPlugin(userSchema, { hidden: ['password', 'tokenVersion'], uidAlias: true }); // id + the deprecated uid (4.0.0)

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;

// ADR-027: the sole registrant of 'User'.
// The guard makes a second import idempotent (Vitest and tsx can load a file twice).
export const UserModel: Model<User> =
  (mongoose.models.User as Model<User> | undefined) ?? mongoose.model<User>('User', userSchema);
