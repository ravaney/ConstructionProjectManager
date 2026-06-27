import mongoose from "mongoose";
import { env } from "./env.js";

let isConnected = false;
let connectPromise: Promise<void> | null = null;
let lastConnectionError: string | null = null;

mongoose.set("bufferCommands", false);

export async function connectDatabase(): Promise<void> {
  if (isConnected) {
    return;
  }

  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = mongoose
    .connect(env.MONGODB_URI, {
      dbName: env.MONGODB_DB_NAME,
      serverSelectionTimeoutMS: 10000
    })
    .then(() => {
      isConnected = true;
      lastConnectionError = null;
    })
    .catch((error: unknown) => {
      isConnected = false;
      lastConnectionError = error instanceof Error ? error.message : "Unknown database connection error";
      throw error;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

export function isDatabaseConnected(): boolean {
  return isConnected && mongoose.connection.readyState === 1;
}

export function getDatabaseStatus() {
  return {
    connected: isDatabaseConnected(),
    readyState: mongoose.connection.readyState,
    lastError: lastConnectionError
  };
}
