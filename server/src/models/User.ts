import { Schema, model } from "mongoose";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ["OWNER", "CONTRACTOR"],
      default: "CONTRACTOR"
    }
  },
  { timestamps: true }
);

export const UserModel = model("User", userSchema);