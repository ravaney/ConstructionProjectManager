import { Schema, model } from "mongoose";

const vendorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

export const VendorModel = model("Vendor", vendorSchema);
