import { Schema, model } from "mongoose";

const estimateGroupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    totalAmount: { type: Number, required: true, default: 0, min: 0 },
    entryTotalAmount: { type: Number, required: true, default: 0, min: 0 },
    entryCurrency: { type: String, required: true, trim: true, default: "USD" },
    usdToEntryRate: { type: Number, required: true, min: 0, default: 1 },
    exchangeRateDate: { type: Date },
    paymentEntries: {
      type: [
        new Schema(
          {
            entryAmount: { type: Number, required: true, min: 0, default: 0 },
            amountUsd: { type: Number, required: true, min: 0, default: 0 },
            entryCurrency: { type: String, required: true, trim: true, default: "USD" },
            usdToEntryRate: { type: Number, required: true, min: 0, default: 1 },
            exchangeRateDate: { type: Date },
            recordedAt: { type: Date, required: true, default: Date.now },
            recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
            expenseId: { type: Schema.Types.ObjectId, ref: "Expense" }
          },
          { _id: false }
        )
      ],
      default: []
    },
    phase: { type: String, required: true, trim: true },
    phaseTaskId: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    section: { type: String, required: true, trim: true },
    sectionTaskId: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    taskIds: { type: [Schema.Types.ObjectId], ref: "Task", default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

estimateGroupSchema.index({ sectionTaskId: 1, updatedAt: -1 });
estimateGroupSchema.index({ phaseTaskId: 1, updatedAt: -1 });

export const EstimateGroupModel = model("EstimateGroup", estimateGroupSchema);
