import mongoose, { Schema, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

import { toJsonPlugin } from '../../core/database/to-json.plugin';

// M4 §2.2: timestamps, the name cap and casing; indexes are explicit (§3.1).
const categorySchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'The name is required'],
      trim: true,
      uppercase: true,
      maxlength: 120,
      unique: true,
    },
    state: { type: Boolean, required: true, default: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { versionKey: false, timestamps: true },
);

// §3.1: partial unique so a soft-deleted name is reusable; collated so case variants collide (duplicate check only).
toJsonPlugin(categorySchema); // id; no _id/__v; no uid alias (a category never exposed uid)

export type Category = InferSchemaType<typeof categorySchema>;
export type CategoryDocument = HydratedDocument<Category>;

// ADR-027: the sole registrant of 'Category'.
// The guard makes a second import idempotent (Vitest and tsx can load a file twice).
export const CategoryModel: Model<Category> =
  (mongoose.models.Category as Model<Category> | undefined) ??
  mongoose.model<Category>('Category', categorySchema);
