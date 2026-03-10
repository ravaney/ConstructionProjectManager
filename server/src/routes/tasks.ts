import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { TaskModel } from "../models/Task.js";
import { getTaskHierarchySnapshot, syncTaskHierarchyState } from "../utils/taskHierarchy.js";

const router = Router();

const taskNodeTypeSchema = z.enum(["PHASE", "SECTION", "TASK"]);
const taskStatusSchema = z.enum(["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE"]);

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  nodeType: taskNodeTypeSchema.optional(),
  parentTaskId: z.string().optional(),
  status: taskStatusSchema.optional(),
  owner: z.string().optional(),
  dueDate: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  budgetImpact: z.coerce.number().min(0).optional(),
  estimateAmount: z.coerce.number().min(0).optional(),
  sortOrder: z.coerce.number().int().min(0).optional()
});

const updateTaskSchema = createTaskSchema.partial();

function toEstimateAmount(payload: z.infer<typeof createTaskSchema> | z.infer<typeof updateTaskSchema>): number | undefined {
  if (typeof payload.estimateAmount === "number") {
    return payload.estimateAmount;
  }

  if (typeof payload.budgetImpact === "number") {
    return payload.budgetImpact;
  }

  return undefined;
}

router.get("/", async (_req, res, next) => {
  try {
    const snapshot = await getTaskHierarchySnapshot();
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});

router.post("/", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = createTaskSchema.parse(req.body);
    await syncTaskHierarchyState();

    const nodeType = payload.nodeType ?? "TASK";
    const parentTask = payload.parentTaskId ? await TaskModel.findById(payload.parentTaskId) : null;

    if (nodeType === "PHASE" && payload.parentTaskId) {
      res.status(400).json({ message: "Phases cannot have a parent node" });
      return;
    }

    if (nodeType === "SECTION" && (!parentTask || parentTask.nodeType !== "PHASE")) {
      res.status(400).json({ message: "Sections must be created under a phase" });
      return;
    }

    if (nodeType === "TASK" && (!parentTask || !["PHASE", "SECTION"].includes(parentTask.nodeType ?? ""))) {
      res.status(400).json({ message: "Tasks must be created under a phase or section" });
      return;
    }

    const siblingFilter =
      nodeType === "PHASE"
        ? { nodeType: "PHASE", $or: [{ parentTaskId: { $exists: false } }, { parentTaskId: null }] }
        : { parentTaskId: parentTask?._id };
    const siblingCount = await TaskModel.countDocuments(siblingFilter);
    const estimateAmount = toEstimateAmount(payload) ?? 0;
    const nextPhase = nodeType === "PHASE" ? payload.title : parentTask?.phase ?? "Phase 1";
    const nextSection =
      nodeType === "SECTION" ? payload.title : parentTask?.nodeType === "SECTION" ? parentTask.title : parentTask?.section ?? "";

    const task = await TaskModel.create({
      title: payload.title,
      description: payload.description ?? "",
      phase: nextPhase,
      section: nodeType === "PHASE" ? "" : nextSection,
      nodeType,
      parentTaskId: nodeType === "PHASE" ? undefined : parentTask?._id,
      status: payload.status ?? "PLANNED",
      owner: payload.owner ?? "",
      dueDate: payload.dueDate ? new Date(payload.dueDate) : undefined,
      priority: payload.priority ?? "MEDIUM",
      budgetImpact: estimateAmount,
      estimateAmount,
      sortOrder: payload.sortOrder ?? siblingCount + 1,
      createdBy: req.user?.id
    });

    await syncTaskHierarchyState();
    const refreshedTask = await TaskModel.findById(task._id);
    res.status(201).json({ task: refreshedTask });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = updateTaskSchema.parse(req.body);
    await syncTaskHierarchyState();

    const task = await TaskModel.findById(req.params.id);
    if (!task) {
      res.status(404).json({ message: "Task not found" });
      return;
    }

    const estimateAmount = toEstimateAmount(payload);
    const nextStatus = payload.status;

    if (task.nodeType !== "TASK" && nextStatus === "DONE") {
      const cascadeFilter =
        task.nodeType === "PHASE"
          ? { $or: [{ _id: task._id }, { phaseTaskId: task._id }] }
          : { $or: [{ _id: task._id }, { sectionTaskId: task._id }] };
      await TaskModel.updateMany(cascadeFilter, {
        $set: {
          status: "DONE",
          closedAt: new Date()
        }
      });
    } else {
      if (payload.title !== undefined) {
        task.title = payload.title;
      }
      if (payload.description !== undefined) {
        task.description = payload.description;
      }
      if (payload.owner !== undefined) {
        task.owner = payload.owner;
      }
      if (payload.dueDate !== undefined) {
        task.dueDate = payload.dueDate ? new Date(payload.dueDate) : undefined;
      }
      if (payload.priority !== undefined) {
        task.priority = payload.priority;
      }
      if (estimateAmount !== undefined) {
        task.estimateAmount = estimateAmount;
        task.budgetImpact = estimateAmount;
      }
      if (payload.sortOrder !== undefined) {
        task.sortOrder = payload.sortOrder;
      }
      if (nextStatus !== undefined) {
        task.status = nextStatus;
        task.closedAt = nextStatus === "DONE" ? task.closedAt ?? new Date() : undefined;
      }

      await task.save();
    }

    await syncTaskHierarchyState();
    const refreshedTask = await TaskModel.findById(req.params.id);
    res.json({ task: refreshedTask });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireRole("OWNER"), async (req, res, next) => {
  try {
    await syncTaskHierarchyState();
    const task = await TaskModel.findById(req.params.id);

    if (!task) {
      res.status(404).json({ message: "Task not found" });
      return;
    }

    if (task.nodeType === "PHASE") {
      await TaskModel.deleteMany({ $or: [{ _id: task._id }, { phaseTaskId: task._id }] });
    } else if (task.nodeType === "SECTION") {
      await TaskModel.deleteMany({ $or: [{ _id: task._id }, { sectionTaskId: task._id }] });
    } else {
      await TaskModel.findByIdAndDelete(task._id);
    }

    await syncTaskHierarchyState();
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
