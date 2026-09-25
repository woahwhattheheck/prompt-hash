import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

const globalForMongoose = global as typeof globalThis & {
  mongoose?: MongooseCache;
};

let cached = globalForMongoose.mongoose;

if (!cached) {
  cached = globalForMongoose.mongoose = { conn: null, promise: null };
}

async function connectDb(): Promise<typeof mongoose> {
  if (!MONGODB_URI) {
    throw new Error("Please define the MONGODB_URI environment variable");
  }

  if (cached!.conn) {
    console.log("🚀 Using cached MongoDB connection");
    return cached!.conn;
  }

  if (!cached!.promise) {
    const opts = {
      bufferCommands: false,
    };

    cached!.promise = mongoose
      .connect(MONGODB_URI, opts)
      .then((m) => {
        console.log("✅ MongoDB connected successfully");
        return m;
      })
      .catch((error: Error) => {
        console.error("❌ MongoDB connection error:", error);
        throw error;
      });
  }

  try {
    cached!.conn = await cached!.promise;
    return cached!.conn;
  } catch (error) {
    cached!.promise = null;
    throw error;
  }
}

/**
 * Close the mongoose connection pool and clear the module cache.
 * Safe to call when never connected. Used by graceful shutdown (#171).
 */
export async function disconnectDb(): Promise<void> {
  const readyState = mongoose.connection.readyState;
  // 0 = disconnected, 99 = uninitialized in some versions — treat as already closed.
  if (readyState !== 0) {
    await mongoose.disconnect();
  }
  if (cached) {
    cached.conn = null;
    cached.promise = null;
  }
}

export default connectDb;
