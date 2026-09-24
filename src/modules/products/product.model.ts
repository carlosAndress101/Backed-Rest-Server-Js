import mongoose, { Schema, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

import { toJsonPlugin } from '../../core/database/to-json.plugin';

// The stored 2.x shape, field for field. M4 adds timestamps and indexes to this schema.
const productSchema = new Schema(
  {
    name: { type: String, required: [true, 'The name is required'], unique: true },
    state: { type: Boolean, required: true, default: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    price: { type: Number, default: 0 },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    description: { type: String },
    available: { type: Boolean, default: true },
    image: { type: String },
  },
  { versionKey: false },
);
toJsonPlugin(productSchema); // id; no _id/__v; no uid alias (a product never exposed uid)

export type Product = InferSchemaType<typeof productSchema>;
export type ProductDocument = HydratedDocument<Product>;

// ADR-027: the sole registrant of 'Product'.
// The guard makes a second import idempotent (Vitest and tsx can load a file twice).
export const ProductModel: Model<Product> =
  (mongoose.models.Product as Model<Product> | undefined) ??
  mongoose.model<Product>('Product', productSchema);
