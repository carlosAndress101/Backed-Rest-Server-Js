import mongoose from 'mongoose';

// The legacy query behaviour of database/config.js, unchanged until SEC-14.
mongoose.set('strictQuery', false);

export async function connectDatabase(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
