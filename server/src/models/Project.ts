import { Schema, model } from "mongoose";

const projectSchema = new Schema(
  {
    name: { type: String, required: true, default: "Dream Home" },
    phase: { type: String, required: true, default: "Phase 1" },
    totalBudget: { type: Number, required: true, default: 100000 },
    currency: { type: String, required: true, default: "USD" },
    notes: { type: String, default: "" }
  },
  { timestamps: true }
);

export const ProjectModel = model("Project", projectSchema);