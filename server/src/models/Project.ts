import { Schema, model } from "mongoose";

const floorPlanPointSchema = new Schema(
  {
    x: { type: Number, required: true, min: 0, max: 1 },
    y: { type: Number, required: true, min: 0, max: 1 }
  },
  { _id: false }
);

const floorPlanStrokeSchema = new Schema(
  {
    color: { type: String, required: true },
    width: { type: Number, required: true, min: 1 },
    points: {
      type: [floorPlanPointSchema],
      default: []
    }
  },
  { _id: false }
);

const projectSchema = new Schema(
  {
    name: { type: String, required: true, default: "Dream Home" },
    phase: { type: String, required: true, default: "Phase 1" },
    totalBudget: { type: Number, required: true, default: 100000 },
    currency: { type: String, required: true, default: "USD" },
    notes: { type: String, default: "" },
    floorPlanMarkup: {
      type: {
        plans: {
          type: [
            {
              attachmentId: { type: String, required: true },
              name: { type: String, required: true },
              strokes: {
                type: [floorPlanStrokeSchema],
                default: []
              }
            }
          ],
          default: []
        },
        strokes: {
          type: [floorPlanStrokeSchema],
          default: []
        }
      },
      default: {
        plans: [],
        strokes: []
      }
    }
  },
  { timestamps: true }
);

export const ProjectModel = model("Project", projectSchema);
