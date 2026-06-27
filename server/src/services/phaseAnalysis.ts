import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../env.js";
import { ExpenseModel } from "../models/Expense.js";
import { TaskModel } from "../models/Task.js";
import { WorkerProfileModel } from "../models/WorkerProfile.js";
import {
  buildChangedFields,
  buildExpenseSnapshot,
  buildTaskSnapshot,
  recordHistoryEvent,
  toIdString as historyToIdString
} from "./history.js";
import { detachTaskFromEstimateGroup } from "./estimateGroups.js";
import { getTaskHierarchySnapshot, syncTaskHierarchyState } from "../utils/taskHierarchy.js";

type TaskStatus = "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "DONE";
type TaskPriority = "LOW" | "MEDIUM" | "HIGH";
type AssistantProvider = "openai" | "qwen";

type AssistantProviderConfig = {
  provider: AssistantProvider;
  model: string;
  apiKey?: string;
  endpoint: string;
};

class AssistantProviderError extends Error {
  provider: AssistantProvider;

  constructor(provider: AssistantProvider, message: string) {
    super(message);
    this.name = "AssistantProviderError";
    this.provider = provider;
  }
}

const taskStatusSchema = z.enum(["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE"]);
const taskPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

const createSectionOperationSchema = z.object({
  kind: z.literal("CREATE_SECTION"),
  summary: z.string().trim().min(1).max(240),
  sectionRef: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().max(1200).optional(),
  owner: z.string().trim().max(180).optional(),
  status: taskStatusSchema.optional(),
  afterSectionTaskId: z.string().trim().min(1).max(120).optional()
});

const updateSectionOperationSchema = z.object({
  kind: z.literal("UPDATE_SECTION"),
  summary: z.string().trim().min(1).max(240),
  sectionTaskId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(180).optional(),
  description: z.string().trim().max(1200).optional(),
  owner: z.string().trim().max(180).optional(),
  status: taskStatusSchema.optional()
});

const deleteSectionOperationSchema = z.object({
  kind: z.literal("DELETE_SECTION"),
  summary: z.string().trim().min(1).max(240),
  sectionTaskId: z.string().trim().min(1).max(120)
});

const createTaskOperationSchema = z.object({
  kind: z.literal("CREATE_TASK"),
  summary: z.string().trim().min(1).max(240),
  sectionTaskId: z.string().trim().min(1).max(120).optional(),
  targetSectionRef: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().max(2400).optional(),
  owner: z.string().trim().max(180).optional(),
  status: taskStatusSchema.optional(),
  dueDate: z.string().trim().max(120).optional(),
  priority: taskPrioritySchema.optional(),
  estimateAmount: z.coerce.number().min(0).max(1_000_000_000).optional(),
  afterTaskId: z.string().trim().min(1).max(120).optional()
});

const updateTaskOperationSchema = z.object({
  kind: z.literal("UPDATE_TASK"),
  summary: z.string().trim().min(1).max(240),
  taskId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(180).optional(),
  description: z.string().trim().max(2400).optional(),
  owner: z.string().trim().max(180).optional(),
  status: taskStatusSchema.optional(),
  dueDate: z.string().trim().max(120).optional(),
  priority: taskPrioritySchema.optional(),
  estimateAmount: z.coerce.number().min(0).max(1_000_000_000).optional()
});

const moveTaskOperationSchema = z.object({
  kind: z.literal("MOVE_TASK"),
  summary: z.string().trim().min(1).max(240),
  taskId: z.string().trim().min(1).max(120),
  targetSectionTaskId: z.string().trim().min(1).max(120).optional(),
  targetSectionRef: z.string().trim().min(1).max(80).optional(),
  afterTaskId: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1).max(180).optional(),
  description: z.string().trim().max(2400).optional(),
  owner: z.string().trim().max(180).optional(),
  status: taskStatusSchema.optional(),
  dueDate: z.string().trim().max(120).optional(),
  priority: taskPrioritySchema.optional(),
  estimateAmount: z.coerce.number().min(0).max(1_000_000_000).optional()
});

const deleteTaskOperationSchema = z.object({
  kind: z.literal("DELETE_TASK"),
  summary: z.string().trim().min(1).max(240),
  taskId: z.string().trim().min(1).max(120)
});

const rawPhaseAnalysisOperationSchema = z.discriminatedUnion("kind", [
  createSectionOperationSchema,
  updateSectionOperationSchema,
  deleteSectionOperationSchema,
  createTaskOperationSchema,
  updateTaskOperationSchema,
  moveTaskOperationSchema,
  deleteTaskOperationSchema
]);

const phaseAnalysisModelResponseSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  notes: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
  warnings: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
  operations: z.array(rawPhaseAnalysisOperationSchema).max(80).default([])
});

const phaseAnalysisSuggestionsModelResponseSchema = z.object({
  suggestions: z.array(z.string().trim().min(8).max(240)).max(6).default([])
});

const phaseAnalysisOperationSchema = z.discriminatedUnion("kind", [
  createSectionOperationSchema.extend({ id: z.string().trim().min(1).max(120) }),
  updateSectionOperationSchema.extend({ id: z.string().trim().min(1).max(120) }),
  deleteSectionOperationSchema.extend({ id: z.string().trim().min(1).max(120) }),
  createTaskOperationSchema.extend({ id: z.string().trim().min(1).max(120) }),
  updateTaskOperationSchema.extend({ id: z.string().trim().min(1).max(120) }),
  moveTaskOperationSchema.extend({ id: z.string().trim().min(1).max(120) }),
  deleteTaskOperationSchema.extend({ id: z.string().trim().min(1).max(120) })
]);

export type PhaseAnalysisOperation = z.infer<typeof phaseAnalysisOperationSchema>;

export type PhaseAnalysisPreview = {
  phaseTaskId: string;
  phaseTitle: string;
  instruction: string;
  summary: string;
  notes: string[];
  warnings: string[];
  operations: PhaseAnalysisOperation[];
  model: string;
  usedFallback: boolean;
  warning?: string;
};

export type PhaseAnalysisSuggestionsResult = {
  phaseTaskId: string;
  phaseTitle: string;
  suggestions: string[];
  model: string;
  usedFallback: boolean;
  warning?: string;
};

export type PhaseAnalysisApplyResult = {
  summary: string;
  appliedCount: number;
  counts: {
    createdSections: number;
    updatedSections: number;
    deletedSections: number;
    createdTasks: number;
    updatedTasks: number;
    movedTasks: number;
    deletedTasks: number;
  };
};

type PhaseTaskSummary = {
  _id: string;
  title: string;
  description: string;
  wbsId?: string;
  phase: string;
  section: string;
  nodeType: "PHASE" | "SECTION" | "TASK";
  parentTaskId?: string;
  phaseTaskId?: string;
  sectionTaskId?: string;
  status: TaskStatus;
  owner: string;
  dueDate?: string;
  priority: TaskPriority;
  estimateAmount: number;
  sortOrder: number;
};

type PhaseContext = {
  phase: PhaseTaskSummary;
  sections: PhaseTaskSummary[];
  tasks: PhaseTaskSummary[];
  tasksBySection: Map<string, PhaseTaskSummary[]>;
  sectionById: Map<string, PhaseTaskSummary>;
  taskById: Map<string, PhaseTaskSummary>;
};

function clipText(value: string | undefined, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isQwenModel(model?: string): boolean {
  return /^qwen/i.test((model ?? "").trim());
}

function resolveAssistantProvider(model?: string): AssistantProviderConfig {
  const selectedModel = (model ?? "").trim();
  if (isQwenModel(selectedModel)) {
    const baseUrl = trimTrailingSlash(env.DASHSCOPE_BASE_URL);
    return {
      provider: "qwen",
      model: selectedModel,
      apiKey: env.DASHSCOPE_API_KEY,
      endpoint: `${baseUrl}/chat/completions`
    };
  }

  return {
    provider: "openai",
    model: selectedModel || env.OPENAI_MODEL,
    apiKey: env.OPENAI_API_KEY,
    endpoint: "https://api.openai.com/v1/chat/completions"
  };
}

function extractJsonString(rawText: string): string {
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return rawText.slice(start, end + 1);
  }

  return rawText.trim();
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value ?? 0));
}

function sanitizeOwner(owner?: string): string {
  return typeof owner === "string" ? owner.trim() : "";
}

function getPrimaryOwnerName(owner: string | undefined) {
  if (!owner) {
    return "";
  }

  return owner
    .split("|")
    .map((value) => value.trim())
    .find(Boolean) ?? owner.trim();
}

function buildTaskCompletionNotes(task: { description?: string; owner?: string }) {
  const lines = [(task.description ?? "").trim()];
  const ownerName = getPrimaryOwnerName(task.owner);

  if (ownerName) {
    lines.push(`Completed by: ${ownerName}`);
  }

  return lines.filter((line) => line.length > 0).join("\n");
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

async function removeTaskCompletionExpenses(
  tasks: Array<{
    _id?: unknown;
    title?: string;
    nodeType?: "PHASE" | "SECTION" | "TASK";
    phase?: string;
    phaseTaskId?: unknown;
    section?: string;
    sectionTaskId?: unknown;
    completionExpenseId?: unknown;
  }>,
  actor?: { id?: string; name?: string; role?: string },
  operationId?: string
) {
  const tasksWithExpenses = tasks.filter((task) => historyToIdString(task.completionExpenseId));
  if (tasksWithExpenses.length === 0) {
    return;
  }

  const expenseIds = tasksWithExpenses
    .map((task) => task.completionExpenseId)
    .filter((value): value is NonNullable<(typeof tasksWithExpenses)[number]["completionExpenseId"]> => Boolean(value));

  if (expenseIds.length === 0) {
    return;
  }

  const expenses = await ExpenseModel.find({
    _id: { $in: expenseIds },
    source: "task-complete"
  });
  const expenseById = new Map(expenses.map((expense) => [historyToIdString(expense._id), expense]));

  for (const task of tasksWithExpenses) {
    const expense = expenseById.get(historyToIdString(task.completionExpenseId));
    if (!expense) {
      continue;
    }

    const beforeSnapshot = buildExpenseSnapshot(expense);
    await recordHistoryEvent({
      operationId,
      entityType: "EXPENSE",
      entityId: historyToIdString(expense._id),
      entityLabel: expense.name,
      action: "DELETE",
      summary: `Task-linked expense removed with ${task.title ?? "task"} deletion`,
      actor,
      scope: buildTaskHistoryScope(task),
      before: beforeSnapshot,
      moneyImpact: {
        label: "Expense Amount",
        before: Number(beforeSnapshot.amount ?? 0),
        after: 0
      },
      metadata: {
        source: "task-complete",
        linkedTaskId: historyToIdString(task._id)
      }
    });
  }

  await ExpenseModel.deleteMany({
    _id: { $in: expenseIds },
    source: "task-complete"
  });
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

async function createTaskNode(input: {
  title: string;
  description?: string;
  nodeType: "SECTION" | "TASK";
  parentTaskId: string;
  phase: string;
  section: string;
  phaseTaskId: string;
  sectionTaskId?: string;
  status?: TaskStatus;
  owner?: string;
  dueDate?: string;
  priority?: TaskPriority;
  estimateAmount?: number;
  createdBy?: string;
}) {
  const estimateAmount = Number(input.estimateAmount ?? 0);
  return TaskModel.create({
    title: input.title,
    description: input.description ?? "",
    nodeType: input.nodeType,
    parentTaskId: input.parentTaskId,
    phase: input.phase,
    section: input.section,
    phaseTaskId: input.phaseTaskId,
    sectionTaskId: input.sectionTaskId,
    status: input.status ?? "PLANNED",
    owner: sanitizeOwner(input.owner),
    dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
    priority: input.priority ?? "MEDIUM",
    budgetImpact: estimateAmount,
    estimateAmount,
    sortOrder: 9999,
    createdBy: input.createdBy
  });
}

async function resequenceChildren(parentTaskId: string, childIds: string[]) {
  for (const [index, childId] of childIds.entries()) {
    await TaskModel.updateOne({ _id: childId }, { $set: { sortOrder: index + 1 } });
  }
}

async function placeChildInParent(input: {
  parentTaskId: string;
  childId: string;
  nodeType: "SECTION" | "TASK";
  afterChildId?: string;
  excludeChildId?: string;
}) {
  const siblings = await TaskModel.find({
    parentTaskId: input.parentTaskId,
    nodeType: input.nodeType,
    ...(input.excludeChildId ? { _id: { $ne: input.excludeChildId } } : {})
  }).sort({ sortOrder: 1, createdAt: 1 });

  const orderedIds = siblings.map((task) => task._id.toString());
  const afterIndex = input.afterChildId ? orderedIds.findIndex((id) => id === input.afterChildId) : -1;
  const insertIndex = afterIndex >= 0 ? afterIndex + 1 : orderedIds.length;
  orderedIds.splice(insertIndex, 0, input.childId);
  await resequenceChildren(input.parentTaskId, orderedIds);
}

function buildPhaseContext(snapshot: Awaited<ReturnType<typeof getTaskHierarchySnapshot>>, phaseTaskId: string): PhaseContext {
  const phase = snapshot.tasks.find((task) => task._id === phaseTaskId && task.nodeType === "PHASE");
  if (!phase) {
    throw new Error("Selected phase was not found");
  }

  const sections = snapshot.tasks
    .filter((task) => task.nodeType === "SECTION" && task.phaseTaskId === phaseTaskId)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const tasks = snapshot.tasks
    .filter((task) => task.nodeType === "TASK" && task.phaseTaskId === phaseTaskId)
    .sort((left, right) => {
      if ((left.sectionTaskId ?? "") === (right.sectionTaskId ?? "")) {
        return left.sortOrder - right.sortOrder;
      }

      return `${left.sectionTaskId ?? ""}:${left.sortOrder}`.localeCompare(`${right.sectionTaskId ?? ""}:${right.sortOrder}`);
    });

  const sectionById = new Map(sections.map((section) => [section._id, section]));
  const taskById = new Map(tasks.map((task) => [task._id, task]));
  const tasksBySection = new Map<string, PhaseTaskSummary[]>();

  for (const task of tasks) {
    const key = task.sectionTaskId || "__phase__";
    const current = tasksBySection.get(key) ?? [];
    current.push(task);
    tasksBySection.set(key, current);
  }

  return {
    phase,
    sections,
    tasks,
    tasksBySection,
    sectionById,
    taskById
  };
}

function buildPhaseContextForModel(phaseContext: PhaseContext) {
  return {
    phase: {
      id: phaseContext.phase._id,
      title: phaseContext.phase.title,
      wbsId: phaseContext.phase.wbsId,
      description: clipText(phaseContext.phase.description, 220),
      status: phaseContext.phase.status,
      owner: phaseContext.phase.owner
    },
    namingConventions: {
      existingSectionTitles: phaseContext.sections.map((section) => section.title),
      sampleTaskTitles: phaseContext.tasks.slice(0, 30).map((task) => task.title),
      notes: [
        "Follow the existing capitalization, separators, qualifiers, and parenthetical style used by current section and task titles.",
        "WBS IDs are automatic. Do not create or edit WBS IDs directly."
      ]
    },
    sections: phaseContext.sections.map((section) => ({
      id: section._id,
      title: section.title,
      wbsId: section.wbsId,
      description: clipText(section.description, 220),
      status: section.status,
      owner: section.owner,
      sortOrder: section.sortOrder,
      tasks: (phaseContext.tasksBySection.get(section._id) ?? []).map((task) => ({
        id: task._id,
        title: task.title,
        wbsId: task.wbsId,
        description: clipText(task.description, 220),
        status: task.status,
        owner: task.owner,
        dueDate: task.dueDate,
        priority: task.priority,
        estimateAmount: task.estimateAmount,
        sortOrder: task.sortOrder
      }))
    })),
    phaseLevelTasks: (phaseContext.tasksBySection.get("__phase__") ?? []).map((task) => ({
      id: task._id,
      title: task.title,
      wbsId: task.wbsId,
      description: clipText(task.description, 220),
      status: task.status,
      owner: task.owner,
      dueDate: task.dueDate,
      priority: task.priority,
      estimateAmount: task.estimateAmount,
      sortOrder: task.sortOrder
    }))
  };
}

function buildOperationSummary(operation: z.infer<typeof rawPhaseAnalysisOperationSchema>, phaseContext: PhaseContext) {
  switch (operation.kind) {
    case "CREATE_SECTION":
      return `Create section "${operation.title}"`;
    case "UPDATE_SECTION":
      return `Update section ${phaseContext.sectionById.get(operation.sectionTaskId)?.title ?? operation.sectionTaskId}`;
    case "DELETE_SECTION":
      return `Delete section ${phaseContext.sectionById.get(operation.sectionTaskId)?.title ?? operation.sectionTaskId}`;
    case "CREATE_TASK":
      return `Create task "${operation.title}"`;
    case "UPDATE_TASK":
      return `Update task ${phaseContext.taskById.get(operation.taskId)?.title ?? operation.taskId}`;
    case "MOVE_TASK": {
      const taskTitle = phaseContext.taskById.get(operation.taskId)?.title ?? operation.taskId;
      const targetTitle =
        (operation.targetSectionTaskId ? phaseContext.sectionById.get(operation.targetSectionTaskId)?.title : undefined) ??
        operation.targetSectionRef ??
        "the target section";
      return `Move ${taskTitle} to ${targetTitle}`;
    }
    case "DELETE_TASK":
      return `Delete task ${phaseContext.taskById.get(operation.taskId)?.title ?? operation.taskId}`;
    default:
      return "Apply change";
  }
}

function normalizePhaseAnalysisOperations(
  rawOperations: z.infer<typeof rawPhaseAnalysisOperationSchema>[],
  phaseContext: PhaseContext
) {
  const normalized: PhaseAnalysisOperation[] = [];
  const warnings: string[] = [];
  const sectionRefs = new Set<string>();

  rawOperations.forEach((operation, index) => {
    if (operation.kind === "CREATE_SECTION") {
      if (sectionRefs.has(operation.sectionRef)) {
        warnings.push(`Skipped duplicate section reference "${operation.sectionRef}".`);
        return;
      }
      sectionRefs.add(operation.sectionRef);
    }

    const normalizedSummary = operation.summary.trim() || buildOperationSummary(operation, phaseContext);

    switch (operation.kind) {
      case "CREATE_SECTION":
        if (operation.afterSectionTaskId && !phaseContext.sectionById.has(operation.afterSectionTaskId)) {
          warnings.push("Skipped a section placement because the reference section no longer exists.");
          return;
        }
        normalized.push({
          id: `phase-analysis-op-${index + 1}`,
          ...operation,
          summary: normalizedSummary
        });
        return;

      case "UPDATE_SECTION":
      case "DELETE_SECTION":
        if (!phaseContext.sectionById.has(operation.sectionTaskId)) {
          warnings.push(`Skipped ${operation.kind.toLowerCase().replace(/_/g, " ")} because the section could not be found in the selected phase.`);
          return;
        }
        normalized.push({
          id: `phase-analysis-op-${index + 1}`,
          ...operation,
          summary: normalizedSummary
        });
        return;

      case "CREATE_TASK":
        if (!operation.sectionTaskId && !operation.targetSectionRef) {
          warnings.push(`Skipped create-task "${operation.title}" because no target section was provided.`);
          return;
        }
        if (operation.sectionTaskId && !phaseContext.sectionById.has(operation.sectionTaskId)) {
          warnings.push(`Skipped create-task "${operation.title}" because its target section was not found in the selected phase.`);
          return;
        }
        if (operation.targetSectionRef && !sectionRefs.has(operation.targetSectionRef)) {
          warnings.push(`Skipped create-task "${operation.title}" because it targets a new section reference that was not created earlier in the plan.`);
          return;
        }
        if (operation.afterTaskId && !phaseContext.taskById.has(operation.afterTaskId)) {
          warnings.push(`Skipped create-task "${operation.title}" because its placement task was not found.`);
          return;
        }
        normalized.push({
          id: `phase-analysis-op-${index + 1}`,
          ...operation,
          summary: normalizedSummary
        });
        return;

      case "UPDATE_TASK":
      case "DELETE_TASK":
        if (!phaseContext.taskById.has(operation.taskId)) {
          warnings.push(`Skipped ${operation.kind.toLowerCase().replace(/_/g, " ")} because the task could not be found in the selected phase.`);
          return;
        }
        normalized.push({
          id: `phase-analysis-op-${index + 1}`,
          ...operation,
          summary: normalizedSummary
        });
        return;

      case "MOVE_TASK":
        if (!phaseContext.taskById.has(operation.taskId)) {
          warnings.push("Skipped a task move because the source task could not be found in the selected phase.");
          return;
        }
        if (!operation.targetSectionTaskId && !operation.targetSectionRef) {
          warnings.push(`Skipped moving ${phaseContext.taskById.get(operation.taskId)?.title ?? "a task"} because no target section was provided.`);
          return;
        }
        if (operation.targetSectionTaskId && !phaseContext.sectionById.has(operation.targetSectionTaskId)) {
          warnings.push(`Skipped moving ${phaseContext.taskById.get(operation.taskId)?.title ?? "a task"} because the target section was not found.`);
          return;
        }
        if (operation.targetSectionRef && !sectionRefs.has(operation.targetSectionRef)) {
          warnings.push(`Skipped moving ${phaseContext.taskById.get(operation.taskId)?.title ?? "a task"} because the referenced new section was not created earlier in the plan.`);
          return;
        }
        if (operation.afterTaskId && !phaseContext.taskById.has(operation.afterTaskId)) {
          warnings.push("Skipped a task placement because the reference task was not found.");
          return;
        }
        normalized.push({
          id: `phase-analysis-op-${index + 1}`,
          ...operation,
          summary: normalizedSummary
        });
        return;

      default:
        return;
    }
  });

  return { operations: normalized, warnings };
}

function buildDestructiveWarnings(phaseContext: PhaseContext, operations: PhaseAnalysisOperation[]) {
  const warnings: string[] = [];

  for (const operation of operations) {
    if (operation.kind === "DELETE_TASK") {
      const task = phaseContext.taskById.get(operation.taskId);
      if (task) {
        warnings.push(`This plan deletes task ${task.wbsId ?? "--"} ${task.title}.`);
      }
    }

    if (operation.kind === "DELETE_SECTION") {
      const section = phaseContext.sectionById.get(operation.sectionTaskId);
      const childCount = (phaseContext.tasksBySection.get(operation.sectionTaskId) ?? []).length;
      if (section) {
        warnings.push(`Deleting section ${section.title} will also remove ${childCount} task${childCount === 1 ? "" : "s"} in that section.`);
      }
    }
  }

  return warnings;
}

function uniqueSuggestionList(values: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const suggestion = value.trim().replace(/\s+/g, " ");
    if (!suggestion) {
      continue;
    }

    const key = suggestion.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(suggestion);
  }

  return normalized;
}

function buildHeuristicPhaseSuggestions(phaseContext: PhaseContext) {
  const suggestions: string[] = [];
  const sections = phaseContext.sections;
  const tasks = phaseContext.tasks;

  const basementTasks = tasks.filter((task) => /basement/i.test(task.title));
  const basementSection = sections.find((section) => /basement/i.test(section.title));
  const basementOutsideSection = basementTasks.filter((task) => !/basement/i.test(task.section));
  if (basementOutsideSection.length >= 2) {
    suggestions.push(
      basementSection
        ? `Move the basement-related tasks into ${basementSection.title} and keep the existing naming style consistent.`
        : "Move the basement-related tasks into a new section called Basement and keep the naming style consistent."
    );
  }

  const envelopeTasks = tasks.filter((task) => /(waterproof|envelope)/i.test(task.title));
  const envelopeSection = sections.find((section) => /(waterproof|envelope)/i.test(section.title));
  const envelopeOutsideSection = envelopeTasks.filter((task) => !/(waterproof|envelope)/i.test(task.section));
  if (envelopeOutsideSection.length >= 2) {
    suggestions.push(
      envelopeSection
        ? `Move the waterproofing and envelope tasks into ${envelopeSection.title} and keep the naming consistent.`
        : "Create a Waterproofing & Envelope section and move the related tasks there."
    );
  }

  const plumbingTasks = tasks.filter((task) => /plumb|pipe|drain/i.test(task.title));
  const electricalTasks = tasks.filter((task) => /electri|conduit|wiring/i.test(task.title));
  const utilitiesSection = sections.find((section) => /(utilit|plumb|electri)/i.test(section.title));
  if ((plumbingTasks.length >= 2 || electricalTasks.length >= 2) && utilitiesSection) {
    const misplacedUtilityTasks = [...plumbingTasks, ...electricalTasks].filter((task) => task.section !== utilitiesSection.title);
    if (misplacedUtilityTasks.length >= 2) {
      suggestions.push(`Move the plumbing and electrical rough-in tasks into ${utilitiesSection.title} so the utility work is grouped together.`);
    }
  }

  const structuredTitles = sections.filter((section) => section.title.includes(" - "));
  if (structuredTitles.length >= 2) {
    const inconsistentTitles = sections.filter((section) => !section.title.includes(" - "));
    if (inconsistentTitles.length > 0) {
      suggestions.push("Rename any inconsistent section titles so they follow the existing section naming convention, then move any misplaced tasks.");
    }
  }

  if (suggestions.length === 0 && sections.length > 1 && tasks.length > 0) {
    suggestions.push(`Review the tasks in ${phaseContext.phase.title} and suggest any sections that should be split, merged, or renamed to better match the current naming pattern.`);
  }

  return uniqueSuggestionList(suggestions).slice(0, 4);
}

async function callPhaseAnalysisSuggestionsModel(input: {
  phaseContext: PhaseContext;
  model?: string;
}) {
  const provider = resolveAssistantProvider(input.model);
  if (!provider.apiKey) {
    return null;
  }

  const context = buildPhaseContextForModel(input.phaseContext);
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.25,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are Construction OS Phase Analysis suggestion mode. " +
            "Analyze one construction phase and suggest up to 4 useful restructuring instructions a user could run next. " +
            "Focus on likely misgrouped tasks, missing sections, naming consistency, or section cleanup opportunities. " +
            "Base every suggestion only on the provided phase data. " +
            "Write each suggestion as a short imperative instruction the user can click and run. " +
            "Do not mention ids, WBS creation, or markdown. Return strict JSON only."
        },
        {
          role: "system",
          content:
            'Return JSON with one key: suggestions. Example: { "suggestions": ["Move all basement-related tasks into a new section called Basement."] }'
        },
        {
          role: "user",
          content: `Selected phase data:\n${JSON.stringify(context, null, 2)}`
        }
      ]
    })
  });

  if (!response.ok) {
    const rawBody = await response.text();
    let details = rawBody.trim();
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody) as { error?: { message?: string }; message?: string };
        details = parsed.error?.message || parsed.message || details;
      } catch {
        details = rawBody.trim();
      }
    }

    const providerLabel = provider.provider === "qwen" ? "Qwen" : "OpenAI";
    throw new AssistantProviderError(provider.provider, `${providerLabel} request failed with ${response.status}${details ? `: ${details}` : ""}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };

  const content = payload.choices?.[0]?.message?.content;
  const rawText =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";

  if (!rawText) {
    return null;
  }

  return phaseAnalysisSuggestionsModelResponseSchema.parse(JSON.parse(extractJsonString(rawText)));
}

async function callPhaseAnalysisModel(input: {
  phaseContext: PhaseContext;
  instruction: string;
  model?: string;
}) {
  const provider = resolveAssistantProvider(input.model);
  if (!provider.apiKey) {
    return null;
  }

  const context = buildPhaseContextForModel(input.phaseContext);
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.15,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are Construction OS Phase Analysis Mode. " +
            "You analyze one selected construction phase and propose a safe set of section and task CRUD changes. " +
            "You are only drafting a plan for confirmation, not applying changes. " +
            "Prefer the smallest set of changes that solves the user's instruction. " +
            "Follow the existing section and task naming style closely. " +
            "Prefer moving or updating existing tasks instead of deleting and recreating them unless deletion is clearly requested. " +
            "Only operate within the selected phase. " +
            "If you create a new section and reference it later, give the create operation a stable sectionRef and reuse that sectionRef. " +
            "Return strict JSON only."
        },
        {
          role: "system",
          content:
            "Return JSON with keys summary, notes, warnings, operations.\n" +
            "Allowed operations:\n" +
            "- CREATE_SECTION: { kind, summary, sectionRef, title, description?, owner?, status?, afterSectionTaskId? }\n" +
            "- UPDATE_SECTION: { kind, summary, sectionTaskId, title?, description?, owner?, status? }\n" +
            "- DELETE_SECTION: { kind, summary, sectionTaskId }\n" +
            "- CREATE_TASK: { kind, summary, sectionTaskId? OR targetSectionRef?, title, description?, owner?, status?, dueDate?, priority?, estimateAmount?, afterTaskId? }\n" +
            "- UPDATE_TASK: { kind, summary, taskId, title?, description?, owner?, status?, dueDate?, priority?, estimateAmount? }\n" +
            "- MOVE_TASK: { kind, summary, taskId, targetSectionTaskId? OR targetSectionRef?, afterTaskId?, title?, description?, owner?, status?, dueDate?, priority?, estimateAmount? }\n" +
            "- DELETE_TASK: { kind, summary, taskId }\n" +
            "Never invent ids. Use the exact ids from the phase data. " +
            "WBS IDs are informational only and should not be edited. " +
            "Do not include markdown."
        },
        {
          role: "user",
          content:
            `Selected phase data:\n${JSON.stringify(context, null, 2)}\n\n` +
            `User instruction:\n${input.instruction.trim()}`
        }
      ]
    })
  });

  if (!response.ok) {
    const rawBody = await response.text();
    let details = rawBody.trim();
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody) as { error?: { message?: string }; message?: string };
        details = parsed.error?.message || parsed.message || details;
      } catch {
        details = rawBody.trim();
      }
    }

    const providerLabel = provider.provider === "qwen" ? "Qwen" : "OpenAI";
    throw new AssistantProviderError(provider.provider, `${providerLabel} request failed with ${response.status}${details ? `: ${details}` : ""}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };

  const content = payload.choices?.[0]?.message?.content;
  const rawText =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";

  if (!rawText) {
    return null;
  }

  return phaseAnalysisModelResponseSchema.parse(JSON.parse(extractJsonString(rawText)));
}

function buildFallbackPreview(input: {
  phaseTaskId: string;
  phaseTitle: string;
  instruction: string;
  warning?: string;
  model?: string;
}): PhaseAnalysisPreview {
  return {
    phaseTaskId: input.phaseTaskId,
    phaseTitle: input.phaseTitle,
    instruction: input.instruction,
    summary: "I could not build a safe phase-analysis proposal right now.",
    notes: [],
    warnings: [input.warning ?? "The selected AI model is unavailable, so no backend changes were proposed."],
    operations: [],
    model: input.model || env.OPENAI_MODEL,
    usedFallback: true,
    warning: input.warning
  };
}

function buildFallbackSuggestions(input: {
  phaseTaskId: string;
  phaseTitle: string;
  suggestions: string[];
  warning?: string;
  model?: string;
}): PhaseAnalysisSuggestionsResult {
  return {
    phaseTaskId: input.phaseTaskId,
    phaseTitle: input.phaseTitle,
    suggestions: uniqueSuggestionList(input.suggestions).slice(0, 4),
    model: input.model || env.OPENAI_MODEL,
    usedFallback: true,
    warning: input.warning
  };
}

export async function suggestPhaseAnalysisPrompts(input: {
  phaseTaskId: string;
  model?: string;
}): Promise<PhaseAnalysisSuggestionsResult> {
  const snapshot = await getTaskHierarchySnapshot();
  const phaseContext = buildPhaseContext(snapshot, input.phaseTaskId);
  const provider = resolveAssistantProvider(input.model);
  const heuristicSuggestions = buildHeuristicPhaseSuggestions(phaseContext);

  try {
    const modelResponse = await callPhaseAnalysisSuggestionsModel({
      phaseContext,
      model: input.model
    });

    if (!modelResponse) {
      return buildFallbackSuggestions({
        phaseTaskId: input.phaseTaskId,
        phaseTitle: phaseContext.phase.title,
        suggestions: heuristicSuggestions,
        warning: provider.provider === "qwen" ? "DASHSCOPE_API_KEY is not configured." : "OPENAI_API_KEY is not configured.",
        model: provider.model
      });
    }

    const suggestions = uniqueSuggestionList([...modelResponse.suggestions, ...heuristicSuggestions]).slice(0, 4);
    return {
      phaseTaskId: input.phaseTaskId,
      phaseTitle: phaseContext.phase.title,
      suggestions,
      model: provider.model,
      usedFallback: false
    };
  } catch (error) {
    const message = error instanceof AssistantProviderError ? error.message : error instanceof Error ? error.message : "Phase suggestion analysis failed.";
    return buildFallbackSuggestions({
      phaseTaskId: input.phaseTaskId,
      phaseTitle: phaseContext.phase.title,
      suggestions: heuristicSuggestions,
      warning: message,
      model: provider.model
    });
  }
}

export async function previewPhaseAnalysis(input: {
  phaseTaskId: string;
  instruction: string;
  model?: string;
}): Promise<PhaseAnalysisPreview> {
  const snapshot = await getTaskHierarchySnapshot();
  const phaseContext = buildPhaseContext(snapshot, input.phaseTaskId);
  const provider = resolveAssistantProvider(input.model);

  try {
    const rawProposal = await callPhaseAnalysisModel({
      phaseContext,
      instruction: input.instruction,
      model: input.model
    });

    if (!rawProposal) {
      return buildFallbackPreview({
        phaseTaskId: input.phaseTaskId,
        phaseTitle: phaseContext.phase.title,
        instruction: input.instruction,
        warning: provider.provider === "qwen" ? "DASHSCOPE_API_KEY is not configured." : "OPENAI_API_KEY is not configured.",
        model: provider.model
      });
    }

    const normalized = normalizePhaseAnalysisOperations(rawProposal.operations, phaseContext);
    const warnings = Array.from(new Set([...rawProposal.warnings, ...normalized.warnings, ...buildDestructiveWarnings(phaseContext, normalized.operations)]));

    return {
      phaseTaskId: input.phaseTaskId,
      phaseTitle: phaseContext.phase.title,
      instruction: input.instruction,
      summary: rawProposal.summary,
      notes: rawProposal.notes,
      warnings,
      operations: normalized.operations,
      model: provider.model,
      usedFallback: false
    };
  } catch (error) {
    const message = error instanceof AssistantProviderError ? error.message : error instanceof Error ? error.message : "Phase analysis failed.";
    return buildFallbackPreview({
      phaseTaskId: input.phaseTaskId,
      phaseTitle: phaseContext.phase.title,
      instruction: input.instruction,
      warning: message,
      model: provider.model
    });
  }
}

function assertFullProposalValidity(phaseContext: PhaseContext, operations: PhaseAnalysisOperation[]) {
  const sectionRefs = new Set<string>();

  for (const operation of operations) {
    if (operation.kind === "CREATE_SECTION") {
      sectionRefs.add(operation.sectionRef);
    }
  }

  for (const operation of operations) {
    switch (operation.kind) {
      case "CREATE_SECTION":
        if (operation.afterSectionTaskId && !phaseContext.sectionById.has(operation.afterSectionTaskId)) {
          throw new Error("The preview is stale. A referenced section no longer exists.");
        }
        break;
      case "UPDATE_SECTION":
      case "DELETE_SECTION":
        if (!phaseContext.sectionById.has(operation.sectionTaskId)) {
          throw new Error("The preview is stale. A referenced section is no longer in this phase.");
        }
        break;
      case "CREATE_TASK":
        if (!operation.sectionTaskId && !operation.targetSectionRef) {
          throw new Error("A proposed task is missing its target section.");
        }
        if (operation.sectionTaskId && !phaseContext.sectionById.has(operation.sectionTaskId)) {
          throw new Error("The preview is stale. A task target section no longer exists.");
        }
        if (operation.targetSectionRef && !sectionRefs.has(operation.targetSectionRef)) {
          throw new Error("A proposed task points to a new section that is not defined in this preview.");
        }
        if (operation.afterTaskId && !phaseContext.taskById.has(operation.afterTaskId)) {
          throw new Error("The preview is stale. A placement task no longer exists.");
        }
        break;
      case "UPDATE_TASK":
      case "DELETE_TASK":
        if (!phaseContext.taskById.has(operation.taskId)) {
          throw new Error("The preview is stale. A referenced task is no longer in this phase.");
        }
        break;
      case "MOVE_TASK":
        if (!phaseContext.taskById.has(operation.taskId)) {
          throw new Error("The preview is stale. A task to move is no longer in this phase.");
        }
        if (!operation.targetSectionTaskId && !operation.targetSectionRef) {
          throw new Error("A proposed task move is missing its target section.");
        }
        if (operation.targetSectionTaskId && !phaseContext.sectionById.has(operation.targetSectionTaskId)) {
          throw new Error("The preview is stale. A target section no longer exists.");
        }
        if (operation.targetSectionRef && !sectionRefs.has(operation.targetSectionRef)) {
          throw new Error("A proposed task move targets a new section that is not defined in this preview.");
        }
        if (operation.afterTaskId && !phaseContext.taskById.has(operation.afterTaskId)) {
          throw new Error("The preview is stale. A placement task no longer exists.");
        }
        break;
      default:
        break;
    }
  }
}

export async function applyPhaseAnalysis(input: {
  phaseTaskId: string;
  summary: string;
  operations: PhaseAnalysisOperation[];
  actor?: { id?: string; name?: string; role?: string };
}): Promise<PhaseAnalysisApplyResult> {
  await syncTaskHierarchyState();
  const snapshot = await getTaskHierarchySnapshot();
  const phaseContext = buildPhaseContext(snapshot, input.phaseTaskId);
  assertFullProposalValidity(phaseContext, input.operations);

  const operationId = randomUUID();
  const createdSectionIdByRef = new Map<string, string>();
  const affectedTaskIds = new Set<string>();
  const counts = {
    createdSections: 0,
    updatedSections: 0,
    deletedSections: 0,
    createdTasks: 0,
    updatedTasks: 0,
    movedTasks: 0,
    deletedTasks: 0
  };

  for (const operation of input.operations) {
    switch (operation.kind) {
      case "CREATE_SECTION": {
        const createdSection = await createTaskNode({
          title: operation.title,
          description: operation.description,
          nodeType: "SECTION",
          parentTaskId: phaseContext.phase._id,
          phase: phaseContext.phase.title,
          section: operation.title,
          phaseTaskId: phaseContext.phase._id,
          status: operation.status,
          owner: operation.owner,
          createdBy: input.actor?.id
        });
        await placeChildInParent({
          parentTaskId: phaseContext.phase._id,
          childId: createdSection._id.toString(),
          nodeType: "SECTION",
          afterChildId: operation.afterSectionTaskId
        });
        createdSectionIdByRef.set(operation.sectionRef, createdSection._id.toString());
        counts.createdSections += 1;
        const refreshedSection = await TaskModel.findById(createdSection._id);
        if (refreshedSection) {
          await recordHistoryEvent({
            operationId,
            entityType: "TASK",
            entityId: refreshedSection._id.toString(),
            entityLabel: refreshedSection.title,
            action: "CREATE",
            summary: operation.summary,
            actor: input.actor,
            scope: buildTaskHistoryScope(refreshedSection),
            after: buildTaskSnapshot(refreshedSection)
          });
        }
        break;
      }

      case "UPDATE_SECTION": {
        const section = await TaskModel.findById(operation.sectionTaskId);
        if (!section || section.nodeType !== "SECTION") {
          throw new Error("A section in this proposal no longer exists.");
        }
        const beforeSnapshot = buildTaskSnapshot(section);
        if (operation.title !== undefined) {
          section.title = operation.title;
        }
        if (operation.description !== undefined) {
          section.description = operation.description;
        }
        if (operation.owner !== undefined) {
          section.owner = sanitizeOwner(operation.owner);
        }
        if (operation.status !== undefined) {
          section.status = operation.status;
          section.closedAt = operation.status === "DONE" ? section.closedAt ?? new Date() : undefined;
        }
        await section.save();
        counts.updatedSections += 1;
        await syncTaskHierarchyState();
        const refreshedSection = await TaskModel.findById(operation.sectionTaskId);
        if (refreshedSection) {
          await recordHistoryEvent({
            operationId,
            entityType: "TASK",
            entityId: refreshedSection._id.toString(),
            entityLabel: refreshedSection.title,
            action: beforeSnapshot.status !== refreshedSection.status ? "STATUS_CHANGE" : "UPDATE",
            summary: operation.summary,
            actor: input.actor,
            scope: buildTaskHistoryScope(refreshedSection),
            before: beforeSnapshot,
            after: buildTaskSnapshot(refreshedSection),
            changedFields: buildChangedFields(beforeSnapshot, buildTaskSnapshot(refreshedSection))
          });
        }
        break;
      }

      case "DELETE_SECTION": {
        const section = await TaskModel.findById(operation.sectionTaskId);
        if (!section || section.nodeType !== "SECTION") {
          throw new Error("A section in this proposal no longer exists.");
        }
        const nodesToDelete = await TaskModel.find({ $or: [{ _id: section._id }, { sectionTaskId: section._id }] });
        const taskNodesToDelete = nodesToDelete.filter((entry) => entry.nodeType === "TASK");
        const taskIdsToDelete = taskNodesToDelete.map((entry) => entry._id.toString());
        const deletedEstimate = taskNodesToDelete
          .reduce((sum, entry) => sum + Number(entry.estimateAmount ?? entry.budgetImpact ?? 0), 0);
        await removeTaskCompletionExpenses(taskNodesToDelete, input.actor, operationId);
        for (const taskId of taskIdsToDelete) {
          await detachTaskFromEstimateGroup(taskId);
        }
        for (const taskNode of taskNodesToDelete) {
          const estimateAmount = Number(taskNode.estimateAmount ?? taskNode.budgetImpact ?? 0);
          await recordHistoryEvent({
            operationId,
            entityType: "TASK",
            entityId: taskNode._id.toString(),
            entityLabel: taskNode.title,
            action: "DELETE",
            summary: `${taskNode.title} deleted as part of ${section.title} removal`,
            actor: input.actor,
            scope: buildTaskHistoryScope(taskNode),
            before: buildTaskSnapshot(taskNode),
            moneyImpact:
              estimateAmount > 0
                ? {
                    label: "Removed Task Estimate",
                    before: estimateAmount,
                    after: 0
                  }
                : undefined,
            metadata: {
              deletedWithSectionId: section._id.toString(),
              deletedWithSectionTitle: section.title
            }
          });
        }
        await TaskModel.deleteMany({ $or: [{ _id: section._id }, { sectionTaskId: section._id }] });
        counts.deletedSections += 1;
        counts.deletedTasks += taskIdsToDelete.length;
        await recordHistoryEvent({
          operationId,
          entityType: "TASK",
          entityId: section._id.toString(),
          entityLabel: section.title,
          action: "DELETE",
          summary: operation.summary,
          actor: input.actor,
          scope: buildTaskHistoryScope(section),
          before: buildTaskSnapshot(section),
          moneyImpact:
            deletedEstimate > 0
              ? {
                  label: "Removed Task Estimate",
                  before: deletedEstimate,
                  after: 0
                }
              : undefined,
          metadata: {
            deletedTasks: taskIdsToDelete.length
          }
        });
        break;
      }

      case "CREATE_TASK": {
        const targetSectionId = operation.sectionTaskId ?? createdSectionIdByRef.get(operation.targetSectionRef ?? "");
        if (!targetSectionId) {
          throw new Error("A proposed task target section could not be resolved.");
        }
        const targetSection = await TaskModel.findById(targetSectionId);
        if (!targetSection || targetSection.nodeType !== "SECTION") {
          throw new Error("A proposed task target section no longer exists.");
        }
        const createdTask = await createTaskNode({
          title: operation.title,
          description: operation.description,
          nodeType: "TASK",
          parentTaskId: targetSection._id.toString(),
          phase: targetSection.phase,
          section: targetSection.title,
          phaseTaskId: historyToIdString(targetSection.phaseTaskId) || phaseContext.phase._id,
          sectionTaskId: targetSection._id.toString(),
          status: operation.status,
          owner: operation.owner,
          dueDate: operation.dueDate,
          priority: operation.priority,
          estimateAmount: operation.estimateAmount,
          createdBy: input.actor?.id
        });
        await placeChildInParent({
          parentTaskId: targetSection._id.toString(),
          childId: createdTask._id.toString(),
          nodeType: "TASK",
          afterChildId: operation.afterTaskId
        });
        affectedTaskIds.add(createdTask._id.toString());
        counts.createdTasks += 1;
        const refreshedTask = await TaskModel.findById(createdTask._id);
        if (refreshedTask) {
          const afterSnapshot = buildTaskSnapshot(refreshedTask);
          await recordHistoryEvent({
            operationId,
            entityType: "TASK",
            entityId: refreshedTask._id.toString(),
            entityLabel: refreshedTask.title,
            action: "CREATE",
            summary: operation.summary,
            actor: input.actor,
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
        break;
      }

      case "UPDATE_TASK":
      case "MOVE_TASK": {
        const task = await TaskModel.findById(operation.taskId);
        if (!task || task.nodeType !== "TASK") {
          throw new Error("A task in this proposal no longer exists.");
        }
        const beforeSnapshot = buildTaskSnapshot(task);
        if (task.estimateGroupId) {
          const movingAcrossSections =
            operation.kind === "MOVE_TASK" &&
            (
              (operation.targetSectionTaskId && operation.targetSectionTaskId !== historyToIdString(task.sectionTaskId)) ||
              (operation.targetSectionRef && createdSectionIdByRef.get(operation.targetSectionRef) !== historyToIdString(task.sectionTaskId))
            );
          if (movingAcrossSections) {
            await detachTaskFromEstimateGroup(task._id.toString());
            task.estimateGroupId = undefined;
          }
        }
        if (operation.kind === "MOVE_TASK") {
          const targetSectionId = operation.targetSectionTaskId ?? createdSectionIdByRef.get(operation.targetSectionRef ?? "");
          if (!targetSectionId) {
            throw new Error("A target section in this proposal could not be resolved.");
          }
          const targetSection = await TaskModel.findById(targetSectionId);
          if (!targetSection || targetSection.nodeType !== "SECTION") {
            throw new Error("A target section in this proposal no longer exists.");
          }
          task.parentTaskId = targetSection._id as any;
          task.sectionTaskId = targetSection._id as any;
          task.phaseTaskId = targetSection.phaseTaskId as any;
          task.phase = targetSection.phase;
          task.section = targetSection.title;
          await task.save();
          await placeChildInParent({
            parentTaskId: targetSection._id.toString(),
            childId: task._id.toString(),
            nodeType: "TASK",
            afterChildId: operation.afterTaskId,
            excludeChildId: task._id.toString()
          });
          counts.movedTasks += 1;
        }
        if (operation.title !== undefined) {
          task.title = operation.title;
        }
        if (operation.description !== undefined) {
          task.description = operation.description;
        }
        if (operation.owner !== undefined) {
          task.owner = sanitizeOwner(operation.owner);
        }
        if (operation.status !== undefined) {
          task.status = operation.status;
          task.closedAt = operation.status === "DONE" ? task.closedAt ?? new Date() : undefined;
        }
        if (operation.dueDate !== undefined) {
          task.dueDate = operation.dueDate ? new Date(operation.dueDate) : undefined;
        }
        if (operation.priority !== undefined) {
          task.priority = operation.priority;
        }
        if (operation.estimateAmount !== undefined) {
          task.estimateAmount = Number(operation.estimateAmount);
          task.budgetImpact = Number(operation.estimateAmount);
        }
        await task.save();
        affectedTaskIds.add(task._id.toString());
        if (operation.kind === "UPDATE_TASK") {
          counts.updatedTasks += 1;
        }
        await syncTaskHierarchyState();
        const refreshedTask = await TaskModel.findById(task._id);
        if (refreshedTask) {
          const afterSnapshot = buildTaskSnapshot(refreshedTask);
          await recordHistoryEvent({
            operationId,
            entityType: "TASK",
            entityId: refreshedTask._id.toString(),
            entityLabel: refreshedTask.title,
            action: beforeSnapshot.status !== afterSnapshot.status ? "STATUS_CHANGE" : "UPDATE",
            summary: operation.summary,
            actor: input.actor,
            scope: buildTaskHistoryScope(refreshedTask),
            before: beforeSnapshot,
            after: afterSnapshot,
            changedFields: buildChangedFields(beforeSnapshot, afterSnapshot),
            moneyImpact:
              beforeSnapshot.estimateAmount !== afterSnapshot.estimateAmount
                ? {
                    label: "Task Estimate",
                    before: Number(beforeSnapshot.estimateAmount ?? 0),
                    after: Number(afterSnapshot.estimateAmount ?? 0)
                  }
                : undefined
          });
        }
        break;
      }

      case "DELETE_TASK": {
        const task = await TaskModel.findById(operation.taskId);
        if (!task || task.nodeType !== "TASK") {
          throw new Error("A task in this proposal no longer exists.");
        }
        const estimateAmount = Number(task.estimateAmount ?? task.budgetImpact ?? 0);
        await removeTaskCompletionExpenses([task], input.actor, operationId);
        await detachTaskFromEstimateGroup(task._id.toString());
        await TaskModel.findByIdAndDelete(task._id);
        counts.deletedTasks += 1;
        await recordHistoryEvent({
          operationId,
          entityType: "TASK",
          entityId: task._id.toString(),
          entityLabel: task.title,
          action: "DELETE",
          summary: operation.summary,
          actor: input.actor,
          scope: buildTaskHistoryScope(task),
          before: buildTaskSnapshot(task),
          moneyImpact:
            estimateAmount > 0
              ? {
                  label: "Removed Task Estimate",
                  before: estimateAmount,
                  after: 0
                }
              : undefined
        });
        break;
      }

      default:
        break;
    }
  }

  await syncTaskHierarchyState();
  await syncTaskCompletionExpenses(Array.from(affectedTaskIds), input.actor?.id, input.actor, operationId);

  return {
    summary: input.summary,
    appliedCount: input.operations.length,
    counts
  };
}

export const phaseAnalysisApplyOperationSchema = phaseAnalysisOperationSchema;
