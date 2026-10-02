import mongoose from 'mongoose';

// SEC-14. Global for every model. Both options exist unchanged in Mongoose 7 and 9 (verified).
mongoose.set('strictQuery', true); // unknown filter paths are stripped (was false)
mongoose.set('sanitizeFilter', true); // `$`-operator objects in filter values are wrapped in $eq → CastError

/**
 * `autoIndex` (default true) lets Mongoose build the schema indexes on connect: dev and test rely on it.
 * Production passes false and builds them through the migrations instead (M4 design §10.1).
 */
export async function connectDatabase(
  uri: string,
  options: { autoIndex?: boolean } = {},
): Promise<typeof mongoose> {
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: options.autoIndex ?? true });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
