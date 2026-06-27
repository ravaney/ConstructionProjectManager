import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { EstimateGroupModel } from "../models/EstimateGroup.js";
import { ExpenseModel } from "../models/Expense.js";
import { InvoiceModel } from "../models/Invoice.js";
import { TaskModel } from "../models/Task.js";
import { WorkerProfileModel } from "../models/WorkerProfile.js";
import { generatePhasePlanFromPrompt } from "../services/phasePlanGenerator.js";
import {
  buildChangedFields,
  buildExpenseSnapshot,
  buildTaskSnapshot,
  recordHistoryEvent,
  toIdString as historyToIdString
} from "../services/history.js";
import { detachTaskFromEstimateGroup } from "../services/estimateGroups.js";
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
  resources: z.array(z.string()).optional(),
  plannedStartDate: z.string().optional(),
  plannedEndDate: z.string().optional(),
  actualStartDate: z.string().optional(),
  actualEndDate: z.string().optional(),
  dueDate: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  budgetImpact: z.coerce.number().min(0).optional(),
  estimateAmount: z.coerce.number().min(0).optional(),
  sortOrder: z.coerce.number().int().min(0).optional()
});

const updateTaskSchema = createTaskSchema.partial();
const reorderTasksSchema = z.object({
  sectionTaskId: z.string().min(1),
  taskIds: z.array(z.string().min(1)).min(1)
});

const generatedTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: taskStatusSchema.optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  estimateAmount: z.coerce.number().min(0).optional(),
  resources: z.array(z.string()).optional(),
  wbsId: z.string().optional(),
  predecessor: z.string().optional(),
  deliverable: z.string().optional()
});

const generatedSectionSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: taskStatusSchema.optional(),
  owner: z.string().optional(),
  resources: z.array(z.string()).optional(),
  estimateAmount: z.coerce.number().min(0).optional(),
  tasks: z.array(generatedTaskSchema).default([])
});

const generatedPhaseSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: taskStatusSchema.optional(),
  owner: z.string().optional(),
  resources: z.array(z.string()).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  plannedStartDate: z.string().optional(),
  plannedEndDate: z.string().optional(),
  dueDate: z.string().optional(),
  estimateAmount: z.coerce.number().min(0).optional(),
  wbsId: z.string().optional(),
  sections: z.array(generatedSectionSchema).default([])
});

const generatedPlanSchema = z.object({
  phases: z.array(generatedPhaseSchema).min(1),
  assumptions: z.array(z.string()).default([]),
  verificationQuestions: z.array(z.string()).default([])
});

const generatePlanRequestSchema = z.object({
  prompt: z.string().min(10).max(6000),
  maxPhases: z.coerce.number().int().min(1).max(12).default(6)
});

const buildPlanRequestSchema = z.object({
  plan: generatedPlanSchema
});

function toEstimateAmount(payload: z.infer<typeof createTaskSchema> | z.infer<typeof updateTaskSchema>): number | undefined {
  if (typeof payload.estimateAmount === "number") {
    return payload.estimateAmount;
  }

  if (typeof payload.budgetImpact === "number") {
    return payload.budgetImpact;
  }

  return undefined;
}

function isStatusOnlyUpdate(
  payload: z.infer<typeof updateTaskSchema>,
  estimateAmount: number | undefined
): boolean {
  return (
    payload.status !== undefined &&
    payload.title === undefined &&
    payload.description === undefined &&
    payload.owner === undefined &&
    payload.resources === undefined &&
    payload.parentTaskId === undefined &&
    payload.nodeType === undefined &&
    payload.plannedStartDate === undefined &&
    payload.plannedEndDate === undefined &&
    payload.actualStartDate === undefined &&
    payload.actualEndDate === undefined &&
    payload.dueDate === undefined &&
    payload.priority === undefined &&
    estimateAmount === undefined &&
    payload.sortOrder === undefined
  );
}

function normalizeResourceList(resources: string[] | undefined): string[] {
  if (!Array.isArray(resources)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of resources) {
    const name = value.trim();
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(name);
  }

  return normalized;
}

function toOwnerFromResources(owner: string | undefined, resources: string[] | undefined): string | undefined {
  const normalizedResources = normalizeResourceList(resources);
  if (normalizedResources.length > 0) {
    return normalizedResources.join(" | ");
  }

  if (typeof owner !== "string") {
    return owner;
  }

  return owner.trim();
}

function composeGeneratedTaskDescription(task: z.infer<typeof generatedTaskSchema>): string {
  const lines = [
    task.description?.trim() ?? "",
    typeof task.predecessor === "string" && task.predecessor.trim()
      ? `Predecessor: ${task.predecessor.trim()}`
      : "",
    typeof task.deliverable === "string" && task.deliverable.trim()
      ? `Deliverable: ${task.deliverable.trim()}`
      : ""
  ].filter((line) => line.length > 0);

  return lines.join("\n");
}

function getPrimaryOwnerName(owner: string | undefined): string {
  if (!owner) {
    return "";
  }

  return normalizeResourceList(owner.split("|"))[0] ?? owner.trim();
}

function buildTaskCompletionNotes(task: {
  description?: string;
  owner?: string;
}) {
  const lines = [(task.description ?? "").trim()];
  const ownerName = getPrimaryOwnerName(task.owner);

  if (ownerName) {
    lines.push(`Completed by: ${ownerName}`);
  }

  return lines.filter((line) => line.length > 0).join("\n");
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value ?? 0));
}

function buildTaskHistoryScope(task: {
  _id?: unknown;
  title?: string;
  nodeType?: "PHASE" | "SECTION" | "TASK";
  phase?: string;
  phaseTaskId?: unknown;
  section?: string;
  sectionTaskId?: unknown;
}) {
  return {
    phase: task.phase ?? "",
    phaseTaskId: historyToIdString(task.phaseTaskId),
    section: task.section ?? "",
    sectionTaskId: historyToIdString(task.sectionTaskId),
    subsection: task.nodeType === "TASK" ? task.title ?? "" : "",
    subsectionTaskId: task.nodeType === "TASK" ? historyToIdString(task._id) : ""
  };
}

function getTaskNodeLabel(nodeType: "PHASE" | "SECTION" | "TASK" | undefined): string {
  switch (nodeType) {
    case "PHASE":
      return "Phase";
    case "SECTION":
      return "Section";
    default:
      return "Task";
  }
}

function summarizeTaskUpdate(
  beforeSnapshot: ReturnType<typeof buildTaskSnapshot>,
  afterSnapshot: ReturnType<typeof buildTaskSnapshot>,
  options?: { cascadeTaskCount?: number }
) {
  if (beforeSnapshot.status !== afterSnapshot.status) {
    if ((options?.cascadeTaskCount ?? 0) > 0 && afterSnapshot.nodeType !== "TASK" && afterSnapshot.status === "DONE") {
      return `${getTaskNodeLabel(afterSnapshot.nodeType)} ${afterSnapshot.title} marked complete and cascaded to ${options?.cascadeTaskCount} task(s)`;
    }

    return `${getTaskNodeLabel(afterSnapshot.nodeType)} ${afterSnapshot.title} status changed from ${beforeSnapshot.status} to ${afterSnapshot.status}`;
  }

  if (
    beforeSnapshot.nodeType === "TASK" &&
    (
      beforeSnapshot.parentTaskId !== afterSnapshot.parentTaskId ||
      beforeSnapshot.sectionTaskId !== afterSnapshot.sectionTaskId ||
      beforeSnapshot.phaseTaskId !== afterSnapshot.phaseTaskId
    )
  ) {
    const beforeLocation = [beforeSnapshot.phase, beforeSnapshot.section].filter(Boolean).join(" / ") || "Unassigned";
    const afterLocation = [afterSnapshot.phase, afterSnapshot.section].filter(Boolean).join(" / ") || "Unassigned";
    return `Task ${afterSnapshot.title} moved from ${beforeLocation} to ${afterLocation}`;
  }

  if (beforeSnapshot.estimateAmount !== afterSnapshot.estimateAmount) {
    return `Estimate updated for ${afterSnapshot.title} from ${formatMoney(Number(beforeSnapshot.estimateAmount ?? 0))} to ${formatMoney(Number(afterSnapshot.estimateAmount ?? 0))}`;
  }

  return `${getTaskNodeLabel(afterSnapshot.nodeType)} ${afterSnapshot.title} updated`;
}

function summarizeTaskReorder(
  afterSnapshot: ReturnType<typeof buildTaskSnapshot>,
  position: number,
  sectionTitle: string
) {
  return `Task ${afterSnapshot.title} reordered to position ${position} in ${sectionTitle}`;
}

async function syncTaskCompletionExpenses(
  taskIds: string[],
  createdBy?: string,
  actor?: { id?: string; name?: string; role?: string },
  operationId?: string
) {
  const uniqueTaskIds = Array.from(new Set(taskIds.filter(Boolean)));
  if (uniqueTaskIds.length === 0) {
    return;
  }

  const tasks = await TaskModel.find({
    _id: { $in: uniqueTaskIds },
    nodeType: "TASK"
  });
  if (tasks.length === 0) {
    return;
  }

  const expenseIds = tasks
    .map((task) => task.completionExpenseId)
    .filter((value): value is NonNullable<(typeof tasks)[number]["completionExpenseId"]> => Boolean(value));
  const existingExpenses = expenseIds.length > 0 ? await ExpenseModel.find({ _id: { $in: expenseIds } }) : [];
  const expenseById = new Map(existingExpenses.map((expense) => [expense._id.toString(), expense]));

  const workers = await WorkerProfileModel.find({ isActive: true }).select("_id name role company");
  const workerByName = new Map(workers.map((worker) => [worker.name.trim().toLowerCase(), worker]));

  for (const task of tasks) {
    const estimateAmount = Number(task.estimateAmount ?? task.budgetImpact ?? 0);
    const existingExpenseId = task.completionExpenseId?.toString();
    const existingExpense = existingExpenseId ? expenseById.get(existingExpenseId) : undefined;

    if (!existingExpense && task.completionExpenseId) {
      task.completionExpenseId = undefined;
      await task.save();
    }

    if (!existingExpense && (task.status !== "DONE" || estimateAmount <= 0)) {
      continue;
    }

    const primaryOwnerName = getPrimaryOwnerName(task.owner);
    const assignedWorker = primaryOwnerName ? workerByName.get(primaryOwnerName.toLowerCase()) : undefined;
    const completionDate = existingExpense?.date ?? task.actualEndDate ?? task.closedAt ?? new Date();
    const expensePayload = {
      name: task.title,
      category: "Labour Cost",
      amount: Number(estimateAmount.toFixed(2)),
      date: completionDate,
      vendor: assignedWorker?.company?.trim() || primaryOwnerName || "",
      phase: task.phase,
      phaseTaskId: task.phaseTaskId,
      section: task.section,
      sectionTaskId: task.sectionTaskId,
      subsection: task.title,
      subsectionTaskId: task._id,
      unit: "task",
      unitPrice: Number(estimateAmount.toFixed(2)),
      quantity: 1,
      notes: buildTaskCompletionNotes(task),
      source: "task-complete",
      workerRole: assignedWorker?.role ?? "OTHER",
      workerProfileId: assignedWorker?._id,
      createdBy
    };

    if (existingExpense && existingExpense.source === "task-complete") {
      const beforeSnapshot = buildExpenseSnapshot(existingExpense);
      existingExpense.name = expensePayload.name;
      existingExpense.category = expensePayload.category;
      existingExpense.amount = expensePayload.amount;
      existingExpense.date = expensePayload.date;
      existingExpense.vendor = expensePayload.vendor;
      existingExpense.phase = expensePayload.phase;
      existingExpense.phaseTaskId = expensePayload.phaseTaskId as any;
      existingExpense.section = expensePayload.section;
      existingExpense.sectionTaskId = expensePayload.sectionTaskId as any;
      existingExpense.subsection = expensePayload.subsection;
      existingExpense.subsectionTaskId = expensePayload.subsectionTaskId as any;
      existingExpense.unit = expensePayload.unit;
      existingExpense.unitPrice = expensePayload.unitPrice;
      existingExpense.quantity = expensePayload.quantity;
      existingExpense.notes = expensePayload.notes;
      existingExpense.workerRole = expensePayload.workerRole;
      existingExpense.workerProfileId = expensePayload.workerProfileId as any;
      await existingExpense.save();
      const afterSnapshot = buildExpenseSnapshot(existingExpense);
      const changedFields = buildChangedFields(beforeSnapshot, afterSnapshot);
      if (changedFields.length > 0) {
        await recordHistoryEvent({
          operationId,
          entityType: "EXPENSE",
          entityId: String(existingExpense._id),
          entityLabel: existingExpense.name,
          action: "UPDATE",
          summary: `Task-linked expense updated from ${task.title}`,
          actor,
          scope: buildTaskHistoryScope(task),
          before: beforeSnapshot,
          after: afterSnapshot,
          changedFields,
          moneyImpact:
            beforeSnapshot.amount !== afterSnapshot.amount
              ? {
                  label: "Expense Amount",
                  before: Number(beforeSnapshot.amount ?? 0),
                  after: Number(afterSnapshot.amount ?? 0)
                }
              : undefined,
          metadata: {
            source: "task-complete",
            linkedTaskId: String(task._id)
          }
        });
      }
      continue;
    }

    if (task.status !== "DONE") {
      continue;
    }

    const createdExpense = await ExpenseModel.create(expensePayload);
    task.completionExpenseId = createdExpense._id;
    await task.save();
    const afterSnapshot = buildExpenseSnapshot(createdExpense);
    await recordHistoryEvent({
      operationId,
      entityType: "EXPENSE",
      entityId: String(createdExpense._id),
      entityLabel: createdExpense.name,
      action: "CREATE",
      summary: `Task-linked expense created from ${task.title}`,
      actor,
      scope: buildTaskHistoryScope(task),
      after: afterSnapshot,
      moneyImpact: {
        label: "Expense Amount",
        before: 0,
        after: Number(afterSnapshot.amount ?? 0)
      },
      metadata: {
        source: "task-complete",
        linkedTaskId: String(task._id)
      }
    });
  }
}

async function removeTaskCompletionExpenses(taskIds: string[]) {
  const uniqueTaskIds = Array.from(new Set(taskIds.filter(Boolean)));
  if (uniqueTaskIds.length === 0) {
    return;
  }

  const tasks = await TaskModel.find({
    _id: { $in: uniqueTaskIds },
    nodeType: "TASK",
    completionExpenseId: { $exists: true, $ne: null }
  }).select("_id completionExpenseId");

  const expenseIds = tasks
    .map((task) => task.completionExpenseId)
    .filter((value): value is NonNullable<(typeof tasks)[number]["completionExpenseId"]> => Boolean(value));

  if (expenseIds.length > 0) {
    await ExpenseModel.deleteMany({
      _id: { $in: expenseIds },
      source: "task-complete"
    });
  }
}

async function createTaskNode(payload: {
  title: string;
  description?: string;
  nodeType: "PHASE" | "SECTION" | "TASK";
  parentTask?: {
    _id: unknown;
    nodeType?: "PHASE" | "SECTION" | "TASK";
    phase?: string;
    section?: string;
    title?: string;
  } | null;
  status?: z.infer<typeof taskStatusSchema>;
  owner?: string;
  resources?: string[];
  plannedStartDate?: string;
  plannedEndDate?: string;
  actualStartDate?: string;
  actualEndDate?: string;
  dueDate?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH";
  estimateAmount?: number;
  sortOrder?: number;
  createdBy?: string;
}) {
  const { nodeType, parentTask } = payload;
  const siblingFilter =
    nodeType === "PHASE"
      ? { nodeType: "PHASE", $or: [{ parentTaskId: { $exists: false } }, { parentTaskId: null }] }
      : { parentTaskId: parentTask?._id };
  const siblingCount = await TaskModel.countDocuments(siblingFilter);
  const estimateAmount = payload.estimateAmount ?? 0;
  const nextPhase = nodeType === "PHASE" ? payload.title : parentTask?.phase ?? "Phase 1";
  const nextSection =
    nodeType === "SECTION" ? payload.title : parentTask?.nodeType === "SECTION" ? parentTask.title ?? "" : parentTask?.section ?? "";

  return TaskModel.create({
    title: payload.title,
    description: payload.description ?? "",
    phase: nextPhase,
    section: nodeType === "PHASE" ? "" : nextSection,
    nodeType,
    parentTaskId: nodeType === "PHASE" ? undefined : parentTask?._id,
    status: payload.status ?? "PLANNED",
    owner: toOwnerFromResources(payload.owner, payload.resources) ?? "",
    plannedStartDate: payload.plannedStartDate ? new Date(payload.plannedStartDate) : undefined,
    plannedEndDate: payload.plannedEndDate ? new Date(payload.plannedEndDate) : undefined,
    actualStartDate: payload.actualStartDate
      ? new Date(payload.actualStartDate)
      : (payload.status ?? "PLANNED") !== "PLANNED"
        ? new Date()
        : undefined,
    actualEndDate: payload.actualEndDate
      ? new Date(payload.actualEndDate)
      : (payload.status ?? "PLANNED") === "DONE"
        ? new Date()
        : undefined,
    dueDate: payload.dueDate ? new Date(payload.dueDate) : undefined,
    priority: payload.priority ?? "MEDIUM",
    budgetImpact: estimateAmount,
    estimateAmount,
    sortOrder: payload.sortOrder ?? siblingCount + 1,
    createdBy: payload.createdBy
  });
}

router.get("/", async (_req, res, next) => {
  try {
    const snapshot = await getTaskHierarchySnapshot();
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});

router.post("/generate-plan", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = generatePlanRequestSchema.parse(req.body);
    const result = await generatePhasePlanFromPrompt(payload.prompt, payload.maxPhases);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/build-plan", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const operationId = randomUUID();
    const payload = buildPlanRequestSchema.parse(req.body);
    await syncTaskHierarchyState();

    let createdPhases = 0;
    let createdSections = 0;
    let createdTasks = 0;
    const createdTaskIds: string[] = [];

    for (const phase of payload.plan.phases) {
      const phaseOwner = toOwnerFromResources(phase.owner, phase.resources);
      const createdPhase = await createTaskNode({
        title: phase.title,
        description: phase.description,
        nodeType: "PHASE",
        status: phase.status ?? "PLANNED",
        owner: phaseOwner,
        resources: phase.resources,
        plannedStartDate: phase.plannedStartDate,
        plannedEndDate: phase.plannedEndDate,
        dueDate: phase.dueDate,
        priority: phase.priority,
        estimateAmount: phase.estimateAmount,
        createdBy: req.user?.id
      });
      createdPhases += 1;

      for (const section of phase.sections) {
        const sectionOwner = toOwnerFromResources(section.owner, section.resources) || phaseOwner;
        const createdSection = await createTaskNode({
          title: section.title,
          description: section.description,
          nodeType: "SECTION",
          parentTask: createdPhase,
          status: section.status ?? "PLANNED",
          owner: sectionOwner,
          resources: section.resources,
          priority: phase.priority,
          estimateAmount: section.estimateAmount,
          createdBy: req.user?.id
        });
        createdSections += 1;

        for (const task of section.tasks) {
          const composedTaskDescription = composeGeneratedTaskDescription(task);
          const createdTask = await createTaskNode({
            title: task.title,
            description: composedTaskDescription,
            nodeType: "TASK",
            parentTask: createdSection,
            status: task.status ?? "PLANNED",
            owner: toOwnerFromResources(undefined, task.resources) || sectionOwner,
            resources: task.resources,
            priority: task.priority ?? phase.priority,
            estimateAmount: task.estimateAmount,
            createdBy: req.user?.id
          });
          if (createdTask?._id) {
            createdTaskIds.push(createdTask._id.toString());
          }
          createdTasks += 1;
        }
      }
    }

    await syncTaskHierarchyState();
    await syncTaskCompletionExpenses(createdTaskIds, req.user?.id, req.user, operationId);
    await recordHistoryEvent({
      operationId,
      entityType: "PROJECT",
      entityId: "project-plan",
      entityLabel: "Project Plan",
      action: "BUILD_PLAN",
      summary: `Built project plan with ${createdPhases} phase(s), ${createdSections} section(s), and ${createdTasks} task(s)`,
      actor: req.user,
      after: {
        phases: createdPhases,
        sections: createdSections,
        tasks: createdTasks
      },
      metadata: {
        phases: createdPhases,
        sections: createdSections,
        tasks: createdTasks
      }
    });

    res.status(201).json({
      created: {
        phases: createdPhases,
        sections: createdSections,
        tasks: createdTasks
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const operationId = randomUUID();
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

    const estimateAmount = toEstimateAmount(payload) ?? 0;
    const task = await createTaskNode({
      title: payload.title,
      description: payload.description,
      nodeType,
      parentTask,
      status: payload.status,
      owner: payload.owner,
      resources: payload.resources,
      plannedStartDate: payload.plannedStartDate,
      plannedEndDate: payload.plannedEndDate,
      actualStartDate: payload.actualStartDate,
      actualEndDate: payload.actualEndDate,
      dueDate: payload.dueDate,
      priority: payload.priority,
      estimateAmount,
      sortOrder: payload.sortOrder,
      createdBy: req.user?.id
    });

    await syncTaskHierarchyState();
    if (nodeType === "TASK") {
      await syncTaskCompletionExpenses([task._id.toString()], req.user?.id, req.user, operationId);
    }
    const refreshedTask = await TaskModel.findById(task._id);
    if (refreshedTask) {
      const afterSnapshot = buildTaskSnapshot(refreshedTask);
      await recordHistoryEvent({
        operationId,
        entityType: "TASK",
        entityId: String(refreshedTask._id),
        entityLabel: refreshedTask.title,
        action: "CREATE",
        summary: `${getTaskNodeLabel(refreshedTask.nodeType)} ${refreshedTask.title} created`,
        actor: req.user,
        scope: buildTaskHistoryScope(refreshedTask),
        after: afterSnapshot,
        moneyImpact:
          Number(afterSnapshot.estimateAmount ?? 0) > 0
            ? {
                label: "Task Estimate",
                before: 0,
                after: Number(afterSnapshot.estimateAmount ?? 0)
              }
            : undefined
      });
    }
    res.status(201).json({ task: refreshedTask });
  } catch (error) {
    next(error);
  }
});

router.post("/reorder", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const operationId = randomUUID();
    const payload = reorderTasksSchema.parse(req.body);
    await syncTaskHierarchyState();

    const sectionTask = await TaskModel.findById(payload.sectionTaskId);
    if (!sectionTask || sectionTask.nodeType !== "SECTION") {
      res.status(404).json({ message: "Section not found" });
      return;
    }

    const sectionTasks = await TaskModel.find({
      parentTaskId: sectionTask._id,
      nodeType: "TASK"
    }).sort({ sortOrder: 1, createdAt: 1 });

    if (sectionTasks.length === 0) {
      res.status(400).json({ message: "There are no tasks to reorder in this section" });
      return;
    }

    const existingTaskIds = sectionTasks.map((task) => historyToIdString(task._id));
    const submittedTaskIds = payload.taskIds.map((taskId) => taskId.trim()).filter((taskId) => taskId.length > 0);

    if (
      submittedTaskIds.length !== existingTaskIds.length ||
      submittedTaskIds.some((taskId) => !existingTaskIds.includes(taskId)) ||
      existingTaskIds.some((taskId) => !submittedTaskIds.includes(taskId))
    ) {
      res.status(400).json({ message: "Reorder payload must include every task in the section exactly once" });
      return;
    }

    const taskById = new Map(sectionTasks.map((task) => [historyToIdString(task._id), task]));
    const beforeSnapshots = new Map(sectionTasks.map((task) => [historyToIdString(task._id), buildTaskSnapshot(task)]));
    const changedTaskIds: string[] = [];

    for (const [index, taskId] of submittedTaskIds.entries()) {
      const task = taskById.get(taskId);
      if (!task) {
        continue;
      }

      const nextSortOrder = index + 1;
      if (Number(task.sortOrder ?? 0) === nextSortOrder) {
        continue;
      }

      task.sortOrder = nextSortOrder;
      await task.save();
      changedTaskIds.push(taskId);
    }

    if (changedTaskIds.length === 0) {
      res.json({ reorderedCount: 0 });
      return;
    }

    await syncTaskHierarchyState();
    const refreshedTasks = await TaskModel.find({ _id: { $in: changedTaskIds } });

    for (const refreshedTask of refreshedTasks) {
      const taskId = historyToIdString(refreshedTask._id);
      const beforeSnapshot = beforeSnapshots.get(taskId);
      if (!beforeSnapshot) {
        continue;
      }

      const afterSnapshot = buildTaskSnapshot(refreshedTask);
      const changedFields = buildChangedFields(beforeSnapshot, afterSnapshot);
      if (changedFields.length === 0) {
        continue;
      }

      await recordHistoryEvent({
        operationId,
        entityType: "TASK",
        entityId: taskId,
        entityLabel: refreshedTask.title,
        action: "UPDATE",
        summary: summarizeTaskReorder(
          afterSnapshot,
          Number(refreshedTask.sortOrder ?? 0),
          refreshedTask.section || sectionTask.title || "this section"
        ),
        actor: req.user,
        scope: buildTaskHistoryScope(refreshedTask),
        before: beforeSnapshot,
        after: afterSnapshot,
        changedFields
      });
    }

    res.json({ reorderedCount: changedTaskIds.length });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const operationId = randomUUID();
    const payload = updateTaskSchema.parse(req.body);
    await syncTaskHierarchyState();

    const task = await TaskModel.findById(req.params.id);
    if (!task) {
      res.status(404).json({ message: "Task not found" });
      return;
    }

    const estimateAmount = toEstimateAmount(payload);
    const nextStatus = payload.status;
    const beforeSnapshot = buildTaskSnapshot(task);
    let affectedTaskIds: string[] = task.nodeType === "TASK" ? [task._id.toString()] : [];
    const currentParentTaskId = historyToIdString(task.parentTaskId);
    let nextParentTask:
      | {
          _id: unknown;
          nodeType?: "PHASE" | "SECTION" | "TASK";
        }
      | null
      | undefined;

    if (payload.parentTaskId !== undefined) {
      if (task.nodeType !== "TASK") {
        res.status(400).json({ message: "Only tasks can be moved between sections" });
        return;
      }

      nextParentTask = payload.parentTaskId ? await TaskModel.findById(payload.parentTaskId).select("_id nodeType") : null;
      if (!nextParentTask || !["PHASE", "SECTION"].includes(nextParentTask.nodeType ?? "")) {
        res.status(400).json({ message: "Tasks must be moved under a valid phase or section" });
        return;
      }

      if (historyToIdString(nextParentTask._id) === historyToIdString(task._id)) {
        res.status(400).json({ message: "A task cannot be moved into itself" });
        return;
      }
    }

    const shouldCascadeCloseHierarchy =
      task.nodeType !== "TASK" &&
      nextStatus === "DONE" &&
      task.status !== "DONE" &&
      isStatusOnlyUpdate(payload, estimateAmount);

    if (shouldCascadeCloseHierarchy) {
      const cascadeFilter =
        task.nodeType === "PHASE"
          ? { $or: [{ _id: task._id }, { phaseTaskId: task._id }] }
          : { $or: [{ _id: task._id }, { sectionTaskId: task._id }] };
      const affectedTasks = await TaskModel.find(cascadeFilter).select("_id nodeType");
      affectedTaskIds = affectedTasks
        .filter((entry) => entry.nodeType === "TASK")
        .map((entry) => entry._id.toString());
      await TaskModel.updateMany(cascadeFilter, {
        $set: {
          status: "DONE",
          closedAt: new Date(),
          actualStartDate: new Date(),
          actualEndDate: new Date()
        }
      });
    } else {
      if (payload.title !== undefined) {
        task.title = payload.title;
      }
      if (payload.description !== undefined) {
        task.description = payload.description;
      }
      if (payload.parentTaskId !== undefined && nextParentTask) {
        if (historyToIdString(nextParentTask._id) !== currentParentTaskId && historyToIdString(task.estimateGroupId)) {
          await detachTaskFromEstimateGroup(task._id.toString());
          task.estimateGroupId = undefined;
        }
        task.parentTaskId = nextParentTask._id as any;
        if (historyToIdString(nextParentTask._id) !== currentParentTaskId && payload.sortOrder === undefined) {
          const siblingCount = await TaskModel.countDocuments({
            _id: { $ne: task._id },
            parentTaskId: nextParentTask._id
          });
          task.sortOrder = siblingCount + 1;
        }
      }
      if (payload.owner !== undefined || payload.resources !== undefined) {
        task.owner = toOwnerFromResources(payload.owner, payload.resources) ?? "";
      }
      if (payload.plannedStartDate !== undefined) {
        task.plannedStartDate = payload.plannedStartDate ? new Date(payload.plannedStartDate) : undefined;
      }
      if (payload.plannedEndDate !== undefined) {
        task.plannedEndDate = payload.plannedEndDate ? new Date(payload.plannedEndDate) : undefined;
      }
      if (payload.actualStartDate !== undefined) {
        task.actualStartDate = payload.actualStartDate ? new Date(payload.actualStartDate) : undefined;
      }
      if (payload.actualEndDate !== undefined) {
        task.actualEndDate = payload.actualEndDate ? new Date(payload.actualEndDate) : undefined;
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
        if (nextStatus !== "PLANNED" && !task.actualStartDate) {
          task.actualStartDate = new Date();
        }
        if (nextStatus === "DONE" && !task.actualEndDate) {
          task.actualEndDate = new Date();
        }
        if (nextStatus !== "DONE" && task.actualEndDate) {
          task.actualEndDate = undefined;
        }
      }

      await task.save();
    }

    await syncTaskHierarchyState();
    await syncTaskCompletionExpenses(affectedTaskIds, req.user?.id, req.user, operationId);
    const refreshedTask = await TaskModel.findById(req.params.id);
    if (refreshedTask) {
      const afterSnapshot = buildTaskSnapshot(refreshedTask);
      const changedFields = buildChangedFields(beforeSnapshot, afterSnapshot);
      if (changedFields.length > 0 || shouldCascadeCloseHierarchy) {
        await recordHistoryEvent({
          operationId,
          entityType: "TASK",
          entityId: String(refreshedTask._id),
          entityLabel: refreshedTask.title,
          action: beforeSnapshot.status !== afterSnapshot.status ? "STATUS_CHANGE" : "UPDATE",
          summary: summarizeTaskUpdate(beforeSnapshot, afterSnapshot, {
            cascadeTaskCount: shouldCascadeCloseHierarchy ? affectedTaskIds.length : 0
          }),
          actor: req.user,
          scope: buildTaskHistoryScope(refreshedTask),
          before: beforeSnapshot,
          after: afterSnapshot,
          changedFields,
          moneyImpact:
            beforeSnapshot.estimateAmount !== afterSnapshot.estimateAmount
              ? {
                  label: "Task Estimate",
                  before: Number(beforeSnapshot.estimateAmount ?? 0),
                  after: Number(afterSnapshot.estimateAmount ?? 0)
                }
              : undefined,
          metadata:
            shouldCascadeCloseHierarchy
              ? {
                  cascadeTaskCount: affectedTaskIds.length
                }
              : undefined
        });
      }
    }
    res.json({ task: refreshedTask });
  } catch (error) {
    next(error);
  }
});

router.delete("/clear-phases", requireRole("OWNER"), async (req, res, next) => {
  try {
    const operationId = randomUUID();
    await syncTaskHierarchyState();
    const snapshot = await getTaskHierarchySnapshot();
    const taskIds = snapshot.tasks.filter((task) => task.nodeType === "TASK").map((task) => task._id);
    const phaseCount = snapshot.tasks.filter((task) => task.nodeType === "PHASE").length;
    const sectionCount = snapshot.tasks.filter((task) => task.nodeType === "SECTION").length;
    const taskCount = snapshot.tasks.filter((task) => task.nodeType === "TASK").length;
    const totalTaskEstimate = snapshot.tasks
      .filter((task) => task.nodeType === "TASK")
      .reduce((sum, task) => sum + Number(task.estimateAmount ?? 0), 0);

    if (snapshot.tasks.length > 0) {
      await removeTaskCompletionExpenses(taskIds);
      await EstimateGroupModel.deleteMany({});
      await TaskModel.deleteMany({});
      await ExpenseModel.updateMany(
        {},
        {
          $unset: {
            phaseTaskId: "",
            sectionTaskId: "",
            subsectionTaskId: ""
          }
        }
      );
      await InvoiceModel.updateMany(
        {},
        {
          $unset: {
            phaseTaskId: "",
            sectionTaskId: "",
            subsectionTaskId: ""
          }
        }
      );
    }

    await syncTaskHierarchyState();
    await recordHistoryEvent({
      operationId,
      entityType: "PROJECT",
      entityId: "project-phases",
      entityLabel: "Project Phases",
      action: "CLEAR_PHASES",
      summary: `Cleared all phases, removing ${phaseCount} phase(s), ${sectionCount} section(s), and ${taskCount} task(s)`,
      actor: req.user,
      before: {
        phases: phaseCount,
        sections: sectionCount,
        tasks: taskCount
      },
      after: {
        phases: 0,
        sections: 0,
        tasks: 0
      },
      moneyImpact:
        totalTaskEstimate > 0
          ? {
              label: "Task Estimates Removed",
              before: totalTaskEstimate,
              after: 0
            }
          : undefined,
      metadata: {
        phases: phaseCount,
        sections: sectionCount,
        tasks: taskCount
      }
    });
    res.json({
      deleted: {
        phases: phaseCount,
        sections: sectionCount,
        tasks: taskCount
      }
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireRole("OWNER"), async (req, res, next) => {
  try {
    const operationId = randomUUID();
    await syncTaskHierarchyState();
    const task = await TaskModel.findById(req.params.id);

    if (!task) {
      res.status(404).json({ message: "Task not found" });
      return;
    }

    const nodesToDelete =
      task.nodeType === "PHASE"
        ? await TaskModel.find({ $or: [{ _id: task._id }, { phaseTaskId: task._id }] })
        : task.nodeType === "SECTION"
          ? await TaskModel.find({ $or: [{ _id: task._id }, { sectionTaskId: task._id }] })
          : [task];

    const taskIdsToDelete =
      task.nodeType === "TASK"
        ? [task._id.toString()]
        : nodesToDelete.filter((entry) => entry.nodeType === "TASK").map((entry) => entry._id.toString());
    const deletedCounts = {
      phases: nodesToDelete.filter((entry) => entry.nodeType === "PHASE").length,
      sections: nodesToDelete.filter((entry) => entry.nodeType === "SECTION").length,
      tasks: nodesToDelete.filter((entry) => entry.nodeType === "TASK").length
    };
    const deletedEstimate = nodesToDelete
      .filter((entry) => entry.nodeType === "TASK")
      .reduce((sum, entry) => sum + Number(entry.estimateAmount ?? entry.budgetImpact ?? 0), 0);
    const beforeSnapshot = buildTaskSnapshot(task);
    await removeTaskCompletionExpenses(taskIdsToDelete);
    for (const taskId of taskIdsToDelete) {
      await detachTaskFromEstimateGroup(taskId);
    }

    if (task.nodeType === "PHASE") {
      await TaskModel.deleteMany({ $or: [{ _id: task._id }, { phaseTaskId: task._id }] });
    } else if (task.nodeType === "SECTION") {
      await TaskModel.deleteMany({ $or: [{ _id: task._id }, { sectionTaskId: task._id }] });
    } else {
      await TaskModel.findByIdAndDelete(task._id);
    }

    await syncTaskHierarchyState();
    await recordHistoryEvent({
      operationId,
      entityType: "TASK",
      entityId: String(task._id),
      entityLabel: task.title,
      action: "DELETE",
      summary: `${getTaskNodeLabel(task.nodeType)} ${task.title} deleted`,
      actor: req.user,
      scope: buildTaskHistoryScope(task),
      before: beforeSnapshot,
      moneyImpact:
        deletedEstimate > 0
          ? {
              label: "Removed Task Estimate",
              before: deletedEstimate,
              after: 0
            }
          : undefined,
      metadata: deletedCounts
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
