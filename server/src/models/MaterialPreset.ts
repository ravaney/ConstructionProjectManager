import { Schema, model } from "mongoose";

const materialPresetHistorySchema = new Schema(
  {
    unitPrice: { type: Number, required: true, min: 0, default: 0 },
    changedAt: { type: Date, required: true, default: Date.now },
    previousUnitPrice: { type: Number, min: 0 }
  },
  { _id: false }
);

const materialPresetSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    unit: { type: String, default: "", trim: true },
    unitPrice: { type: Number, required: true, min: 0, default: 0 },
    priceHistory: { type: [materialPresetHistorySchema], default: [] },
    removed: { type: Boolean, default: false, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

export const MaterialPresetModel = model("MaterialPreset", materialPresetSchema);
