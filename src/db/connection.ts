import mongoose from 'mongoose';

export async function connectDb(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri);
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
