import { Schema, model } from "mongoose";

const projectSchema = new Schema(
  {
    name: { type: String, required: true, default: "Dream Home" },
    phase: { type: String, required: true, default: "Phase 1" },
    totalBudget: { type: Number, required: true, default: 100000 },
    currency: { type: String, required: true, default: "USD" },
    notes: { type: String, default: "" },
    floorPlanMarkup: {
      type: {
        strokes: {
          type: [
            {
              color: { type: String, required: true },
              width: { type: Number, required: true, min: 1 },
              points: {
                type: [
                  {
                    x: { type: Number, required: true, min: 0, max: 1 },
                    y: { type: Number, required: true, min: 0, max: 1 }
                  }
                ],
                default: []
              }
            }
          ],
          default: []
        }
      },
      default: {
        strokes: []
      }
    }
  },
  { timestamps: true }
);

export const ProjectModel = model("Project", projectSchema);
