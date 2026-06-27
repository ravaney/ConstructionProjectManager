import { randomUUID } from "node:crypto";
import { Schema, model } from "mongoose";

const historyChangedFieldSchema = new Schema(
  {
    field: { type: String, required: true, trim: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed }
  },
  { _id: false }
);

const historyMoneyImpactSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    currency: { type: String, required: true, trim: true, default: "USD" },
    before: { type: Number, required: true, default: 0 },
    after: { type: Number, required: true, default: 0 },
    delta: { type: Number, required: true, default: 0 }
  },
  { _id: false }
);

const historyActorSchema = new Schema(
  {
    id: { type: String, default: "", trim: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, required: true, trim: true }
  },
  { _id: false }
);

const historyScopeSchema = new Schema(
  {
    phase: { type: String, default: "", trim: true },
    phaseTaskId: { type: String, default: "", trim: true },
    section: { type: String, default: "", trim: true },
    sectionTaskId: { type: String, default: "", trim: true },
    subsection: { type: String, default: "", trim: true },
    subsectionTaskId: { type: String, default: "", trim: true }
  },
  { _id: false }
);

const historyNarrativeSchema = new Schema(
  {
    detail: { type: String, default: "", trim: true },
    highlights: { type: [String], default: [] },
    provider: { type: String, enum: ["openai", "fallback"], default: "fallback" }
  },
  { _id: false }
);

const historyEntrySchema = new Schema(
  {
    historyId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: () => randomUUID()
    },
    operationId: {
      type: String,
      required: true,
      index: true
    },
    entityType: {
      type: String,
      required: true,
      enum: ["PROJECT", "TASK", "EXPENSE", "INVOICE", "ESTIMATE_GROUP"]
    },
    entityId: { type: String, required: true, trim: true, index: true },
    entityLabel: { type: String, required: true, trim: true },
    action: {
      type: String,
      required: true,
      enum: ["CREATE", "UPDATE", "DELETE", "STATUS_CHANGE", "MARK_PAID", "BUDGET_CHANGE", "BUILD_PLAN", "CLEAR_PHASES"]
    },
    summary: { type: String, required: true, trim: true },
    changedFields: { type: [historyChangedFieldSchema], default: [] },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    moneyImpact: { type: historyMoneyImpactSchema },
    actor: { type: historyActorSchema, required: true },
    scope: { type: historyScopeSchema, default: undefined },
    narrative: { type: historyNarrativeSchema, default: undefined },
    metadata: { type: Schema.Types.Mixed }
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

historyEntrySchema.index({ entityType: 1, createdAt: -1 });
historyEntrySchema.index({ action: 1, createdAt: -1 });
historyEntrySchema.index({ "actor.id": 1, createdAt: -1 });
historyEntrySchema.index({ "scope.phaseTaskId": 1, createdAt: -1 });

export const HistoryEntryModel = model("HistoryEntry", historyEntrySchema);
