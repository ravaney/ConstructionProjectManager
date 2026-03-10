import { ProjectModel } from "../models/Project.js";

export async function ensureProject() {
  let project = await ProjectModel.findOne();

  if (!project) {
    project = await ProjectModel.create({
      name: "Dream Home",
      phase: "Phase 1",
      totalBudget: 100000,
      currency: "USD",
      notes: "Imported from phase worksheet"
    });
  }

  return project;
}