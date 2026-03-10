import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { AttachmentModel } from "../models/Attachment.js";
import { removeStoredFile, saveFile } from "../services/fileStorage.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

const querySchema = z.object({
  entityType: z.enum(["expense", "task"]),
  entityId: z.string().optional()
});

router.get("/", async (req, res, next) => {
  try {
    const { entityType, entityId } = querySchema.parse(req.query);
    const filters: Record<string, string> = { entityType };

    if (entityId) {
      filters.entityId = entityId;
    }

    const attachments = await AttachmentModel.find(filters).sort({ createdAt: -1 });
    res.json({ attachments });
  } catch (error) {
    next(error);
  }
});

router.post("/upload", requireRole("OWNER", "CONTRACTOR"), upload.single("file"), async (req, res, next) => {
  try {
    const bodySchema = z.object({
      entityType: z.enum(["expense", "task"]),
      entityId: z.string().min(1)
    });

    const payload = bodySchema.parse(req.body);

    if (!req.file) {
      res.status(400).json({ message: "No file uploaded" });
      return;
    }

    const stored = await saveFile(req.file);

    const attachment = await AttachmentModel.create({
      fileName: req.file.originalname,
      url: stored.url,
      mimeType: req.file.mimetype,
      size: req.file.size,
      storage: stored.storage,
      publicId: stored.publicId,
      entityType: payload.entityType,
      entityId: payload.entityId,
      uploadedBy: req.user?.id
    });

    res.status(201).json({ attachment });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const attachment = await AttachmentModel.findById(req.params.id);

    if (!attachment) {
      res.status(404).json({ message: "Attachment not found" });
      return;
    }

    const isOwner = req.user?.role === "OWNER";
    const isUploader = String(attachment.uploadedBy) === req.user?.id;

    if (!isOwner && !isUploader) {
      res.status(403).json({ message: "You can only remove your own attachments" });
      return;
    }

    await removeStoredFile(attachment.storage, attachment.url, attachment.publicId ?? undefined);
    await attachment.deleteOne();

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;