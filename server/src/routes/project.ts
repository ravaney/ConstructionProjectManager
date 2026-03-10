import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { ensureProject } from "../utils/ensureProject.js";

const router = Router();

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  phase: z.string().min(1).optional(),
  totalBudget: z.coerce.number().positive(),
  currency: z.string().min(3).max(3).optional(),
  notes: z.string().optional()
});

router.get("/", async (_req, res, next) => {
  try {
    const project = await ensureProject();
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

router.put("/", requireRole("OWNER"), async (req, res, next) => {
  try {
    const payload = updateProjectSchema.parse(req.body);
    const project = await ensureProject();

    project.name = payload.name ?? project.name;
    project.phase = payload.phase ?? project.phase;
    project.totalBudget = payload.totalBudget;
    project.currency = payload.currency ?? project.currency;
    project.notes = payload.notes ?? project.notes;

    await project.save();
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

export default router;