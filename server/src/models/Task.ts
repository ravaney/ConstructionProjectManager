import { Schema, model } from "mongoose";

const taskSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    phase: { type: String, default: "Phase 1", trim: true },
    status: {
      type: String,
      enum: ["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE"],
      default: "PLANNED"
    },
    owner: { type: String, default: "", trim: true },
    dueDate: { type: Date },
    priority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH"],
      default: "MEDIUM"
    },
    budgetImpact: { type: Number, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

export const TaskModel = model("Task", taskSchema);