import type { Schema } from 'mongoose';

export interface ToJsonOptions {
  hidden?: readonly string[];
  uidAlias?: boolean;
}

/**
 * P13, shared with M4: every API resource serializes with a string `id` and never `_id`/`__v`.
 * `hidden` fields are dropped; `uidAlias` keeps the deprecated `uid` where the legacy model exposed it (User, until 4.0.0).
 */
export function toJsonPlugin(schema: Schema, options: ToJsonOptions = {}): void {
  const hidden = new Set(options.hidden ?? []);
  schema.set('toJSON', {
    virtuals: false,
    versionKey: false,
    transform(_doc, ret: Record<string, unknown>) {
      const id = String(ret._id);
      delete ret._id;
      delete ret.__v;
      for (const f of hidden) delete ret[f];
      return { id, ...(options.uidAlias ? { uid: id } : {}), ...ret };
    },
  });
}
