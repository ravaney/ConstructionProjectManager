import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { TaskModel } from "../models/Task.js";

const router = Router();

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  phase: z.string().optional(),
  status: z.enum(["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE"]).optional(),
  owner: z.string().optional(),
  dueDate: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  budgetImpact: z.coerce.number().min(0).optional()
});

const updateTaskSchema = createTaskSchema.partial();

router.get("/", async (_req, res, next) => {
  try {
    const tasks = await TaskModel.find().sort({ dueDate: 1, createdAt: -1 });
    res.json({ tasks });
  } catch (error) {
    next(error);
  }
});

router.post("/", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = createTaskSchema.parse(req.body);
    const task = await TaskModel.create({
      ...payload,
      description: payload.description ?? "",
      phase: payload.phase ?? "Phase 1",
      status: payload.status ?? "PLANNED",
      owner: payload.owner ?? "",
      dueDate: payload.dueDate ? new Date(payload.dueDate) : undefined,
      priority: payload.priority ?? "MEDIUM",
      budgetImpact: payload.budgetImpact ?? 0,
      createdBy: req.user?.id
    });

    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = updateTaskSchema.parse(req.body);
    const updatePayload: Record<string, unknown> = { ...payload };

    if (payload.dueDate) {
      updatePayload.dueDate = new Date(payload.dueDate);
    }

    const task = await TaskModel.findByIdAndUpdate(req.params.id, updatePayload, {
      new: true
    });

    if (!task) {
      res.status(404).json({ message: "Task not found" });
      return;
    }

    res.json({ task });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireRole("OWNER"), async (req, res, next) => {
  try {
    const deleted = await TaskModel.findByIdAndDelete(req.params.id);

    if (!deleted) {
      res.status(404).json({ message: "Task not found" });
      return;
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;