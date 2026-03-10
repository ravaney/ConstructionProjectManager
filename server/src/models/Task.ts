import { Schema, model } from "mongoose";

const taskSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    phase: { type: String, default: "Phase 1", trim: true },
    section: { type: String, default: "", trim: true },
    nodeType: {
      type: String,
      enum: ["PHASE", "SECTION", "TASK"],
      default: "TASK"
    },
    parentTaskId: { type: Schema.Types.ObjectId, ref: "Task" },
    phaseTaskId: { type: Schema.Types.ObjectId, ref: "Task" },
    sectionTaskId: { type: Schema.Types.ObjectId, ref: "Task" },
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
    estimateAmount: { type: Number, default: 0, min: 0 },
    sortOrder: { type: Number, default: 0 },
    closedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

export const TaskModel = model("Task", taskSchema);
