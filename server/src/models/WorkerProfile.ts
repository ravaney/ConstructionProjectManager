import { Schema, model } from "mongoose";

const workerProfileSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ["PLUMBER", "ELECTRICIAN", "CONTRACTOR", "STEELWORKER", "STEEL_MAN", "CARPENTER", "MASON", "LABORER", "OTHER"],
      required: true,
      default: "OTHER"
    },
    phone: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true },
    company: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

export const WorkerProfileModel = model("WorkerProfile", workerProfileSchema);
