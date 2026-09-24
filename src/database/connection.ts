import mongoose from 'mongoose';

// SEC-14. Global for every model. Both options exist unchanged in Mongoose 7 and 9 (verified).
mongoose.set('strictQuery', true); // unknown filter paths are stripped (was false)
mongoose.set('sanitizeFilter', true); // `$`-operator objects in filter values are wrapped in $eq → CastError

export async function connectDatabase(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
