import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DB_NAME: z.string().min(1).default("dream-home"),
  JWT_SECRET: z.string().min(12, "JWT_SECRET must be at least 12 characters"),
  TOKEN_TTL: z.string().default("7d"),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  UPLOAD_DIR: z.string().default("uploads")
});

export const env = envSchema.parse(process.env);
