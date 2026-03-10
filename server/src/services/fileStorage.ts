import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { v2 as cloudinary } from "cloudinary";
import { env } from "../env.js";

export type StoredFile = {
  url: string;
  storage: "cloudinary" | "local";
  publicId?: string;
};

function hasCloudinaryConfig(): boolean {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

function configureCloudinary() {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET
  });
}

export function getUploadDirectory(): string {
  return path.resolve(process.cwd(), env.UPLOAD_DIR);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function saveFile(file: Express.Multer.File): Promise<StoredFile> {
  if (hasCloudinaryConfig()) {
    configureCloudinary();

    const upload = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "dream-home-construction",
          resource_type: "auto"
        },
        (error, result) => {
          if (error || !result) {
            reject(error ?? new Error("Cloudinary upload failed"));
            return;
          }

          resolve({ secure_url: result.secure_url, public_id: result.public_id });
        }
      );

      Readable.from(file.buffer).pipe(stream);
    });

    return {
      url: upload.secure_url,
      publicId: upload.public_id,
      storage: "cloudinary"
    };
  }

  const uploadDir = getUploadDirectory();
  await fs.mkdir(uploadDir, { recursive: true });

  const safeName = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}-${sanitizeFileName(file.originalname)}`;
  const absolutePath = path.join(uploadDir, safeName);

  await fs.writeFile(absolutePath, file.buffer);

  return {
    url: `/uploads/${safeName}`,
    storage: "local"
  };
}

export async function removeStoredFile(storage: "cloudinary" | "local", url: string, publicId?: string) {
  if (storage === "cloudinary") {
    if (publicId && hasCloudinaryConfig()) {
      configureCloudinary();
      await cloudinary.uploader.destroy(publicId, { resource_type: "auto" });
    }
    return;
  }

  const uploadDir = getUploadDirectory();
  const fileName = url.split("/").pop();
  if (!fileName) {
    return;
  }

  const absolutePath = path.join(uploadDir, fileName);
  try {
    await fs.unlink(absolutePath);
  } catch (_error) {
    // No-op if file was already removed.
  }
}