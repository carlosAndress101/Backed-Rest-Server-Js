import mongoose, { Schema, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

import { toJsonPlugin } from '../../core/database/to-json.plugin';

// M4 §2.3: timestamps, caps, casing and `min: 0`; indexes are explicit (§3.1).
const productSchema = new Schema(
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
    price: { type: Number, default: 0, min: 0 },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    description: { type: String, trim: true, maxlength: 2000 },
    available: { type: Boolean, required: true, default: true },
    // AM-M4-4: no pattern validator (M3 stores a Cloudinary secure_url or a Google avatar), just a cap.
    image: { type: String, trim: true, maxlength: 2048 },
  },
  { versionKey: false, timestamps: true },
);

// §3.1: partial unique so a soft-deleted name is reusable; collated so case variants collide (duplicate check only).
toJsonPlugin(productSchema); // id; no _id/__v; no uid alias (a product never exposed uid)

export type Product = InferSchemaType<typeof productSchema>;
export type ProductDocument = HydratedDocument<Product>;

// ADR-027: the sole registrant of 'Product'.
// The guard makes a second import idempotent (Vitest and tsx can load a file twice).
export const ProductModel: Model<Product> =
  (mongoose.models.Product as Model<Product> | undefined) ??
  mongoose.model<Product>('Product', productSchema);
