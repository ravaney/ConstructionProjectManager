import mongoose from "mongoose";
import { env } from "./env.js";

let isConnected = false;

export async function connectDatabase(): Promise<void> {
  if (isConnected) {
    return;
  }

  await mongoose.connect(env.MONGODB_URI, {
    dbName: env.MONGODB_DB_NAME
  });
  isConnected = true;
}
