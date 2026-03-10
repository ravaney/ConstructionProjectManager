import { Schema, model } from "mongoose";

const attachmentSchema = new Schema(
  {
    fileName: { type: String, required: true },
    url: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    storage: {
      type: String,
      enum: ["cloudinary", "local"],
      required: true
    },
    publicId: { type: String },
    entityType: {
      type: String,
      enum: ["expense", "task"],
      required: true
    },
    entityId: { type: String, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: true }
);

export const AttachmentModel = model("Attachment", attachmentSchema);