import { Schema, model } from "mongoose";

const expenseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true, default: Date.now },
    vendor: { type: String, default: "", trim: true },
    phase: { type: String, default: "Phase 1", trim: true },
    phaseTaskId: { type: Schema.Types.ObjectId, ref: "Task" },
    section: { type: String, default: "", trim: true },
    sectionTaskId: { type: Schema.Types.ObjectId, ref: "Task" },
    subsection: { type: String, default: "", trim: true },
    subsectionTaskId: { type: Schema.Types.ObjectId, ref: "Task" },
    unit: { type: String, default: "", trim: true },
    unitPrice: { type: Number, default: 0, min: 0 },
    quantity: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: "", trim: true },
    source: { type: String, default: "manual", trim: true },
    workerRole: {
      type: String,
      enum: ["PLUMBER", "ELECTRICIAN", "CONTRACTOR", "STEELWORKER", "STEEL_MAN", "CARPENTER", "MASON", "LABORER", "OTHER"],
      default: "OTHER"
    },
    workerProfileId: { type: Schema.Types.ObjectId, ref: "WorkerProfile" },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice" },
    invoiceNumber: { type: String, default: "", trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

export const ExpenseModel = model("Expense", expenseSchema);
