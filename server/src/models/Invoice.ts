import { Schema, model } from "mongoose";

const invoiceItemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    workerRole: {
      type: String,
      enum: ["PLUMBER", "ELECTRICIAN", "CONTRACTOR", "STEELWORKER", "STEEL_MAN", "CARPENTER", "MASON", "LABORER", "OTHER"],
      default: "OTHER"
    },
    quantity: { type: Number, default: 1, min: 0 },
    unit: { type: String, default: "", trim: true },
    unitPrice: { type: Number, default: 0, min: 0 },
    amount: { type: Number, required: true, min: 0 },
    materialLabel: { type: String, default: "", trim: true },
    trackToTally: { type: Boolean, default: false },
    recordOnly: { type: Boolean, default: false },
    paid: { type: Boolean, default: false },
    paidAt: { type: Date },
    paidExpenseId: { type: Schema.Types.ObjectId, ref: "Expense" }
  },
  { _id: false }
);

const invoiceSchema = new Schema(
  {
    vendor: { type: String, required: true, trim: true },
    invoiceNumber: { type: String, required: true, trim: true },
    issueDate: { type: Date, required: true, default: Date.now },
    dueDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["UNPAID", "PARTIALLY_PAID", "PAID"],
      default: "UNPAID"
    },
    currency: { type: String, default: "USD" },
    notes: { type: String, default: "", trim: true },
    items: { type: [invoiceItemSchema], default: [] },
    totalAmount: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, required: true, min: 0, default: 0 },
    paidAt: { type: Date },
    paidBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    generatedExpenseIds: { type: [Schema.Types.ObjectId], ref: "Expense", default: [] }
  },
  { timestamps: true }
);

export const InvoiceModel = model("Invoice", invoiceSchema);
