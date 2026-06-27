import { ExpenseModel } from "../models/Expense.js";
import { InvoiceModel } from "../models/Invoice.js";
import { ProjectModel } from "../models/Project.js";
import { TaskModel } from "../models/Task.js";

type TaskStatus = "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "DONE";
type TaskNodeType = "PHASE" | "SECTION" | "TASK";

type TaskDocumentLike = {
  _id: { toString(): string };
  title?: string;
  description?: string;
  phase?: string;
  section?: string;
  nodeType?: TaskNodeType;
  parentTaskId?: { toString(): string } | string | null;
  phaseTaskId?: { toString(): string } | string | null;
  sectionTaskId?: { toString(): string } | string | null;
  status?: TaskStatus;
  owner?: string;
  plannedStartDate?: Date | null;
  plannedEndDate?: Date | null;
  actualStartDate?: Date | null;
  actualEndDate?: Date | null;
  dueDate?: Date | null;
  priority?: "LOW" | "MEDIUM" | "HIGH";
  budgetImpact?: number;
  estimateAmount?: number;
  estimateGroupId?: { toString(): string } | string | null;
  sortOrder?: number;
  closedAt?: Date | null;
  createdAt?: Date | null;
};

type TaskNodeSummary = {
  _id: string;
  title: string;
  description: string;
  wbsId?: string;
  predecessorWbsId?: string;
  phase: string;
  section: string;
  nodeType: TaskNodeType;
  parentTaskId?: string;
  phaseTaskId?: string;
  sectionTaskId?: string;
  status: TaskStatus;
  owner: string;
  resources: string[];
  plannedStartDate?: string;
  plannedEndDate?: string;
  actualStartDate?: string;
  actualEndDate?: string;
  dueDate?: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  budgetImpact: number;
  estimateAmount: number;
  estimateGroupId?: string;
  sortOrder: number;
  closedAt?: string;
  financials: {
    directSpent: number;
    directCommitted: number;
    rolledSpent: number;
    rolledCommitted: number;
    rolledEstimate: number;
    remaining: number;
  };
  progress: {
    totalTasks: number;
    completedTasks: number;
    percentComplete: number;
  };
};

type HierarchySnapshot = {
  tasks: TaskNodeSummary[];
  currentPhaseId?: string;
  currentSectionId?: string;
};

type ScopeInput = {
  phaseTaskId?: string;
  sectionTaskId?: string;
  subsectionTaskId?: string;
  phase?: string;
  section?: string;
  subsection?: string;
};

type ScopeFields = {
  phaseTaskId?: string;
  sectionTaskId?: string;
  subsectionTaskId?: string;
  phase: string;
  section: string;
  subsection: string;
};

const DEFAULT_PHASE_TITLE = "Phase 1";
const DEFAULT_SECTION_TITLE = "General";

function toIdString(value: unknown): string {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null && "toString" in value) {
    return value.toString();
  }

  return "";
}

function toMoney(value: number): number {
  return Number(value.toFixed(2));
}

function sanitizeTitle(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").trim();
  return normalized || fallback;
}

function parseTaskResources(owner: string | undefined): string[] {
  if (typeof owner !== "string") {
    return [];
  }

  const seen = new Set<string>();
  const resources: string[] = [];

  for (const part of owner.split("|")) {
    const normalized = part.trim();
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    resources.push(normalized);
  }

  return resources;
}

function stripStaticTaskDetailLines(description: string | undefined): string {
  if (typeof description !== "string" || description.trim().length === 0) {
    return "";
  }

  const filteredLines = description
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*wbs\s*id\s*:/i.test(line) &&
        !/^\s*wbsid\s*:/i.test(line) &&
        !/^\s*predecessor\s*:/i.test(line)
    );

  return filteredLines.join("\n").trim();
}

function sortNodes<T extends TaskDocumentLike>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const orderDiff = Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0);
    if (orderDiff !== 0) {
      return orderDiff;
    }

    const leftCreated = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightCreated = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return leftCreated - rightCreated;
  });
}

function buildSectionKey(phaseId: string, title: string): string {
  return `${phaseId}:${title.trim().toLowerCase()}`;
}

function deriveParentStatus(childStatuses: TaskStatus[]): TaskStatus {
  if (childStatuses.length === 0) {
    return "PLANNED";
  }

  if (childStatuses.every((status) => status === "DONE")) {
    return "DONE";
  }

  if (childStatuses.some((status) => status === "IN_PROGRESS")) {
    return "IN_PROGRESS";
  }

  const hasDone = childStatuses.some((status) => status === "DONE");
  const hasBlocked = childStatuses.some((status) => status === "BLOCKED");
  if (hasBlocked && !hasDone && childStatuses.every((status) => status !== "PLANNED")) {
    return "BLOCKED";
  }

  if (hasDone || hasBlocked) {
    return "IN_PROGRESS";
  }

  return "PLANNED";
}

async function ensureLegacyTaskHierarchy() {
  const legacyTasks = await TaskModel.find({
    $or: [{ nodeType: { $exists: false } }, { nodeType: null }]
  }).sort({ createdAt: 1 });

  if (legacyTasks.length === 0) {
    return;
  }

  const existingNodes = await TaskModel.find({ nodeType: { $in: ["PHASE", "SECTION"] } }).sort({ createdAt: 1 });
  const phaseByTitle = new Map<string, any>();
  const sectionByKey = new Map<string, any>();

  for (const node of existingNodes) {
    const nodeId = toIdString(node._id);
    if (node.nodeType === "PHASE") {
      phaseByTitle.set(node.title, node);
    }

    if (node.nodeType === "SECTION") {
      const phaseId = toIdString(node.phaseTaskId) || toIdString(node.parentTaskId);
      sectionByKey.set(buildSectionKey(phaseId, node.title), node);
    }
  }

  for (const legacyTask of legacyTasks) {
    const phaseTitle = sanitizeTitle(legacyTask.phase, DEFAULT_PHASE_TITLE);
    let phaseNode = phaseByTitle.get(phaseTitle);

    if (!phaseNode) {
      phaseNode = await TaskModel.create({
        title: phaseTitle,
        description: "",
        phase: phaseTitle,
        section: "",
        nodeType: "PHASE",
        status: "PLANNED",
        owner: "",
        priority: "MEDIUM",
        budgetImpact: 0,
        estimateAmount: 0,
        sortOrder: phaseByTitle.size + 1
      });
      phaseByTitle.set(phaseTitle, phaseNode);
    }

    const phaseId = toIdString(phaseNode._id);
    const sectionKey = buildSectionKey(phaseId, DEFAULT_SECTION_TITLE);
    let sectionNode = sectionByKey.get(sectionKey);

    if (!sectionNode) {
      sectionNode = await TaskModel.create({
        title: DEFAULT_SECTION_TITLE,
        description: "Migrated from the legacy flat task board",
        phase: phaseTitle,
        section: DEFAULT_SECTION_TITLE,
        nodeType: "SECTION",
        parentTaskId: phaseNode._id,
        phaseTaskId: phaseNode._id,
        status: "PLANNED",
        owner: "",
        priority: "MEDIUM",
        budgetImpact: 0,
        estimateAmount: 0,
        sortOrder: 1
      });
      sectionByKey.set(sectionKey, sectionNode);
    }

    const estimateAmount = Number(legacyTask.estimateAmount ?? legacyTask.budgetImpact ?? 0);
    await TaskModel.updateOne(
      { _id: legacyTask._id },
      {
        $set: {
          nodeType: "TASK",
          parentTaskId: sectionNode._id,
          phaseTaskId: phaseNode._id,
          sectionTaskId: sectionNode._id,
          phase: phaseTitle,
          section: DEFAULT_SECTION_TITLE,
          estimateAmount,
          budgetImpact: estimateAmount
        }
      }
    );
  }
}

async function syncScopedFinancialNames(taskMap: Map<string, TaskDocumentLike>) {
  const scopedExpenses = await ExpenseModel.find({
    $or: [{ phaseTaskId: { $exists: true, $ne: null } }, { sectionTaskId: { $exists: true, $ne: null } }]
  });
  const scopedInvoices = await InvoiceModel.find({
    $or: [{ phaseTaskId: { $exists: true, $ne: null } }, { sectionTaskId: { $exists: true, $ne: null } }]
  });

  const expenseOps: any[] = scopedExpenses
    .map((expense) => {
      const phaseId = toIdString(expense.phaseTaskId);
      const sectionId = toIdString(expense.sectionTaskId);
      const subsectionId = toIdString(expense.subsectionTaskId);
      const phaseTitle = phaseId ? sanitizeTitle(taskMap.get(phaseId)?.title, sanitizeTitle(expense.phase, DEFAULT_PHASE_TITLE)) : sanitizeTitle(expense.phase, DEFAULT_PHASE_TITLE);
      const sectionTitle = sectionId ? sanitizeTitle(taskMap.get(sectionId)?.title, "") : sanitizeTitle(expense.section, "");
      const subsectionTitle = subsectionId ? sanitizeTitle(taskMap.get(subsectionId)?.title, "") : sanitizeTitle(expense.subsection, "");

      if (expense.phase === phaseTitle && (expense.section ?? "") === sectionTitle && (expense.subsection ?? "") === subsectionTitle) {
        return null;
      }

      return {
        updateOne: {
          filter: { _id: expense._id },
          update: {
            $set: {
              phase: phaseTitle,
              section: sectionTitle,
              subsection: subsectionTitle
            }
          }
        }
      };
    })
    .filter(Boolean);

  const invoiceOps: any[] = scopedInvoices
    .map((invoice) => {
      const phaseId = toIdString(invoice.phaseTaskId);
      const sectionId = toIdString(invoice.sectionTaskId);
      const subsectionId = toIdString(invoice.subsectionTaskId);
      const phaseTitle = phaseId ? sanitizeTitle(taskMap.get(phaseId)?.title, sanitizeTitle(invoice.phase, DEFAULT_PHASE_TITLE)) : sanitizeTitle(invoice.phase, DEFAULT_PHASE_TITLE);
      const sectionTitle = sectionId ? sanitizeTitle(taskMap.get(sectionId)?.title, "") : sanitizeTitle(invoice.section, "");
      const subsectionTitle = subsectionId ? sanitizeTitle(taskMap.get(subsectionId)?.title, "") : sanitizeTitle(invoice.subsection, "");

      if (invoice.phase === phaseTitle && (invoice.section ?? "") === sectionTitle && (invoice.subsection ?? "") === subsectionTitle) {
        return null;
      }

      return {
        updateOne: {
          filter: { _id: invoice._id },
          update: {
            $set: {
              phase: phaseTitle,
              section: sectionTitle,
              subsection: subsectionTitle
            }
          }
        }
      };
    })
    .filter(Boolean);

  if (expenseOps.length > 0) {
    await ExpenseModel.bulkWrite(expenseOps);
  }

  if (invoiceOps.length > 0) {
    await InvoiceModel.bulkWrite(invoiceOps);
  }
}

export async function syncTaskHierarchyState() {
  await ensureLegacyTaskHierarchy();

  const tasks = sortNodes(await TaskModel.find());
  if (tasks.length === 0) {
    const project = await ProjectModel.findOne();
    if (project && project.phase !== DEFAULT_PHASE_TITLE) {
      project.phase = DEFAULT_PHASE_TITLE;
      await project.save();
    }
    return;
  }

  const taskMap = new Map<string, any>(tasks.map((task) => [toIdString(task._id), task]));
  const childrenMap = new Map<string, any[]>();

  for (const task of tasks) {
    const parentId = toIdString(task.parentTaskId);
    if (!parentId) {
      continue;
    }

    const current = childrenMap.get(parentId) ?? [];
    current.push(task);
    childrenMap.set(parentId, current);
  }

  for (const [parentId, children] of childrenMap.entries()) {
    childrenMap.set(parentId, sortNodes(children));
  }

  const ops: any[] = [];
  const computedStatus = new Map<string, TaskStatus>();
  const roots = sortNodes(tasks.filter((task) => task.nodeType === "PHASE" || !task.parentTaskId));

  function queueTaskUpdate(taskId: string, changes: Record<string, unknown>) {
    if (Object.keys(changes).length === 0) {
      return;
    }

    ops.push({
      updateOne: {
        filter: { _id: taskId },
        update: {
          $set: changes
        }
      }
    });
  }

  function walk(task: any, currentPhase?: any, currentSection?: any) {
    const taskId = toIdString(task._id);
    const nodeType: TaskNodeType = (task.nodeType ?? "TASK") as TaskNodeType;
    const nextPhase = nodeType === "PHASE" ? task : currentPhase;
    const nextSection = nodeType === "SECTION" ? task : nodeType === "PHASE" ? undefined : currentSection;
    const expectedParentId = nodeType === "PHASE" ? "" : toIdString(task.parentTaskId);
    const expectedPhaseTitle = sanitizeTitle(nextPhase?.title, sanitizeTitle(task.phase, DEFAULT_PHASE_TITLE));
    const expectedSectionTitle = nodeType === "SECTION" ? sanitizeTitle(task.title, DEFAULT_SECTION_TITLE) : sanitizeTitle(nextSection?.title, nodeType === "TASK" ? sanitizeTitle(task.section, "") : "");
    const expectedPhaseId = toIdString(nextPhase?._id);
    const expectedSectionId = toIdString(nextSection?._id);
    const estimateAmount = Number(task.estimateAmount ?? task.budgetImpact ?? 0);
    const lineageChanges: Record<string, unknown> = {};

    if (task.phase !== expectedPhaseTitle) {
      lineageChanges.phase = expectedPhaseTitle;
    }

    if ((task.section ?? "") !== (nodeType === "PHASE" ? "" : expectedSectionTitle)) {
      lineageChanges.section = nodeType === "PHASE" ? "" : expectedSectionTitle;
    }

    if (toIdString(task.phaseTaskId) !== (nodeType === "PHASE" ? taskId : expectedPhaseId)) {
      lineageChanges.phaseTaskId = nodeType === "PHASE" ? task._id : nextPhase?._id;
    }

    if (toIdString(task.sectionTaskId) !== (nodeType === "SECTION" ? taskId : expectedSectionId)) {
      lineageChanges.sectionTaskId = nodeType === "SECTION" ? task._id : nextSection?._id;
    }

    if (nodeType === "PHASE") {
      if (task.parentTaskId) {
        lineageChanges.parentTaskId = undefined;
      }
    } else if (!expectedParentId) {
      // Keep the existing parent if the hierarchy is currently invalid but recoverable.
    }

    if (Number(task.budgetImpact ?? 0) !== estimateAmount) {
      lineageChanges.budgetImpact = estimateAmount;
    }

    if (Number(task.estimateAmount ?? 0) !== estimateAmount) {
      lineageChanges.estimateAmount = estimateAmount;
    }

    queueTaskUpdate(taskId, lineageChanges);

    const children = childrenMap.get(taskId) ?? [];
    const childStatuses = children.map((child) => walk(child, nextPhase, nextSection));
    let nextStatus = (task.status ?? "PLANNED") as TaskStatus;

    if (nodeType !== "TASK" && children.length > 0) {
      nextStatus = deriveParentStatus(childStatuses);
    }

    computedStatus.set(taskId, nextStatus);
    return nextStatus;
  }

  for (const root of roots) {
    walk(root);
  }

  const phaseNodes = roots.filter((task) => (task.nodeType ?? "TASK") === "PHASE");
  const currentPhase = phaseNodes.find((phase) => computedStatus.get(toIdString(phase._id)) !== "DONE");
  if (currentPhase) {
    const currentPhaseId = toIdString(currentPhase._id);
    if (computedStatus.get(currentPhaseId) === "PLANNED") {
      computedStatus.set(currentPhaseId, "IN_PROGRESS");
    }

    const phaseChildren = childrenMap.get(currentPhaseId) ?? [];
    const currentSection = phaseChildren.find((child) => computedStatus.get(toIdString(child._id)) !== "DONE");
    if (currentSection) {
      const currentSectionId = toIdString(currentSection._id);
      if (computedStatus.get(currentSectionId) === "PLANNED") {
        computedStatus.set(currentSectionId, "IN_PROGRESS");
      }
    }

    const project = await ProjectModel.findOne();
    const phaseTitle = sanitizeTitle(currentPhase.title, DEFAULT_PHASE_TITLE);
    if (project && project.phase !== phaseTitle) {
      project.phase = phaseTitle;
      await project.save();
    }
  }

  for (const task of tasks) {
    const taskId = toIdString(task._id);
    const nextStatus = computedStatus.get(taskId) ?? (task.status ?? "PLANNED");
    const nextClosedAt = nextStatus === "DONE" ? task.closedAt ?? new Date() : undefined;
    const statusChanges: Record<string, unknown> = {};

    if (task.status !== nextStatus) {
      statusChanges.status = nextStatus;
    }

    if (nextStatus === "DONE" && !task.closedAt) {
      statusChanges.closedAt = nextClosedAt;
    }

    if (nextStatus !== "DONE" && task.closedAt) {
      statusChanges.closedAt = undefined;
    }

    if (nextStatus !== "PLANNED" && !task.actualStartDate) {
      statusChanges.actualStartDate = new Date();
    }

    if (nextStatus === "DONE" && !task.actualEndDate) {
      statusChanges.actualEndDate = new Date();
    }

    if (nextStatus !== "DONE" && task.actualEndDate) {
      statusChanges.actualEndDate = undefined;
    }

    queueTaskUpdate(taskId, statusChanges);
  }

  if (ops.length > 0) {
    await TaskModel.bulkWrite(ops);
  }

  const refreshedTasks = sortNodes((await TaskModel.find()) as any[]);
  await syncScopedFinancialNames(new Map(refreshedTasks.map((task) => [toIdString(task._id), task])));
}

export async function resolveTaskScope(input: ScopeInput): Promise<ScopeFields> {
  await ensureLegacyTaskHierarchy();

  const subsectionId = sanitizeTitle(input.subsectionTaskId, "");
  const sectionId = sanitizeTitle(input.sectionTaskId, "");
  const phaseId = sanitizeTitle(input.phaseTaskId, "");
  const ids = [subsectionId, sectionId, phaseId].filter(Boolean);
  const linkedTasks = ids.length > 0 ? await TaskModel.find({ _id: { $in: ids } }) : [];
  const taskMap = new Map(linkedTasks.map((task) => [toIdString(task._id), task]));

  const linkedSubsection = subsectionId ? taskMap.get(subsectionId) : undefined;
  if (linkedSubsection && linkedSubsection.nodeType === "TASK") {
    const resolvedSectionId = toIdString(linkedSubsection.sectionTaskId) || toIdString(linkedSubsection.parentTaskId) || sectionId;
    const linkedSection =
      resolvedSectionId ? taskMap.get(resolvedSectionId) ?? (await TaskModel.findById(resolvedSectionId)) : undefined;
    const resolvedPhaseId = toIdString(linkedSubsection.phaseTaskId) || toIdString(linkedSection?.phaseTaskId) || phaseId;
    const linkedPhase = resolvedPhaseId ? taskMap.get(resolvedPhaseId) ?? (await TaskModel.findById(resolvedPhaseId)) : undefined;

    return {
      phaseTaskId: resolvedPhaseId || undefined,
      sectionTaskId: resolvedSectionId || undefined,
      subsectionTaskId: toIdString(linkedSubsection._id),
      phase: sanitizeTitle(linkedPhase?.title, sanitizeTitle(input.phase, sanitizeTitle(linkedSubsection.phase, DEFAULT_PHASE_TITLE))),
      section: sanitizeTitle(linkedSection?.title, sanitizeTitle(input.section, sanitizeTitle(linkedSubsection.section, ""))),
      subsection: sanitizeTitle(linkedSubsection.title, sanitizeTitle(input.subsection, ""))
    };
  }

  const linkedSection = sectionId ? taskMap.get(sectionId) : undefined;
  if (linkedSection && linkedSection.nodeType === "SECTION") {
    const resolvedPhaseId = toIdString(linkedSection.phaseTaskId) || phaseId;
    const linkedPhase = resolvedPhaseId ? taskMap.get(resolvedPhaseId) ?? (await TaskModel.findById(resolvedPhaseId)) : undefined;
    return {
      phaseTaskId: resolvedPhaseId || undefined,
      sectionTaskId: toIdString(linkedSection._id),
      subsectionTaskId: undefined,
      phase: sanitizeTitle(linkedPhase?.title, sanitizeTitle(input.phase, sanitizeTitle(linkedSection.phase, DEFAULT_PHASE_TITLE))),
      section: sanitizeTitle(linkedSection.title, sanitizeTitle(input.section, "")),
      subsection: ""
    };
  }

  const linkedPhase = phaseId ? taskMap.get(phaseId) : undefined;
  if (linkedPhase && linkedPhase.nodeType === "PHASE") {
    return {
      phaseTaskId: toIdString(linkedPhase._id),
      phase: sanitizeTitle(linkedPhase.title, sanitizeTitle(input.phase, DEFAULT_PHASE_TITLE)),
      sectionTaskId: undefined,
      section: "",
      subsectionTaskId: undefined,
      subsection: ""
    };
  }

  return {
    phaseTaskId: phaseId || undefined,
    sectionTaskId: sectionId || undefined,
    subsectionTaskId: subsectionId || undefined,
    phase: sanitizeTitle(input.phase, DEFAULT_PHASE_TITLE),
    section: sanitizeTitle(input.section, ""),
    subsection: sanitizeTitle(input.subsection, "")
  };
}

export async function getTaskHierarchySnapshot(): Promise<HierarchySnapshot> {
  await syncTaskHierarchyState();

  const [tasks, expenses, invoices] = await Promise.all([
    TaskModel.find().sort({ sortOrder: 1, createdAt: 1 }),
    ExpenseModel.find().sort({ createdAt: 1 }),
    InvoiceModel.find().sort({ createdAt: 1 })
  ]);

  const normalizedTasks = sortNodes(tasks as any[]);
  const taskMap = new Map<string, any>(normalizedTasks.map((task) => [toIdString(task._id), task]));
  const childrenMap = new Map<string, any[]>();

  for (const task of normalizedTasks) {
    const parentId = toIdString(task.parentTaskId);
    if (!parentId) {
      continue;
    }

    const current = childrenMap.get(parentId) ?? [];
    current.push(task);
    childrenMap.set(parentId, current);
  }

  for (const [parentId, children] of childrenMap.entries()) {
    childrenMap.set(parentId, sortNodes(children));
  }

  const phaseWbsMap = new Map<string, string>();
  const sectionWbsMap = new Map<string, string>();
  const taskWbsMap = new Map<string, string>();
  const taskPredecessorWbsMap = new Map<string, string>();
  const phaseNodes = normalizedTasks.filter((task) => (task.nodeType ?? "TASK") === "PHASE");

  phaseNodes.forEach((phaseTask, phaseIndex) => {
    const phaseId = toIdString(phaseTask._id);
    const phaseNumber = phaseIndex + 1;
    phaseWbsMap.set(phaseId, `${phaseNumber}.0`);

    const phaseSections = (childrenMap.get(phaseId) ?? []).filter((child) => (child.nodeType ?? "TASK") === "SECTION");
    phaseSections.forEach((sectionTask, sectionIndex) => {
      const sectionId = toIdString(sectionTask._id);
      const sectionNumber = sectionIndex + 1;
      const sectionWbs = `${phaseNumber}.${sectionNumber}`;
      sectionWbsMap.set(sectionId, sectionWbs);

      const sectionTasks = (childrenMap.get(sectionId) ?? []).filter((child) => (child.nodeType ?? "TASK") === "TASK");
      sectionTasks.forEach((childTask, taskIndex) => {
        const childTaskId = toIdString(childTask._id);
        taskWbsMap.set(childTaskId, `${sectionWbs}.${taskIndex + 1}`);
        if (taskIndex > 0) {
          taskPredecessorWbsMap.set(childTaskId, `${sectionWbs}.${taskIndex}`);
        }
      });
    });
  });

  function resolveDynamicWbsId(task: any): string | undefined {
    const taskId = toIdString(task._id);
    const nodeType = (task.nodeType ?? "TASK") as TaskNodeType;

    if (nodeType === "PHASE") {
      return phaseWbsMap.get(taskId);
    }

    if (nodeType === "SECTION") {
      if (sectionWbsMap.has(taskId)) {
        return sectionWbsMap.get(taskId);
      }

      const phaseId = toIdString(task.phaseTaskId) || toIdString(task.parentTaskId);
      const phaseNumber = phaseId ? phaseWbsMap.get(phaseId)?.split(".")[0] : undefined;
      if (!phaseNumber) {
        return undefined;
      }

      const siblingSections = (childrenMap.get(phaseId) ?? []).filter((child) => (child.nodeType ?? "TASK") === "SECTION");
      const siblingIndex = siblingSections.findIndex((child) => toIdString(child._id) === taskId);
      return siblingIndex >= 0 ? `${phaseNumber}.${siblingIndex + 1}` : undefined;
    }

    if (taskWbsMap.has(taskId)) {
      return taskWbsMap.get(taskId);
    }

    const sectionId = toIdString(task.sectionTaskId) || toIdString(task.parentTaskId);
    const sectionWbs = sectionId ? sectionWbsMap.get(sectionId) : undefined;
    if (!sectionWbs) {
      return undefined;
    }

    const siblingTasks = (childrenMap.get(sectionId) ?? []).filter((child) => (child.nodeType ?? "TASK") === "TASK");
    const siblingIndex = siblingTasks.findIndex((child) => toIdString(child._id) === taskId);
    return siblingIndex >= 0 ? `${sectionWbs}.${siblingIndex + 1}` : undefined;
  }

  const directSpent = new Map<string, number>();
  const directCommitted = new Map<string, number>();

  function addDirectAmount(targetId: string, store: Map<string, number>, amount: number) {
    if (!targetId) {
      return;
    }

    store.set(targetId, toMoney((store.get(targetId) ?? 0) + amount));
  }

  for (const expense of expenses) {
    const sectionId = toIdString(expense.sectionTaskId);
    const phaseId = toIdString(expense.phaseTaskId);

    if (sectionId && taskMap.has(sectionId)) {
      addDirectAmount(sectionId, directSpent, Number(expense.amount ?? 0));
      continue;
    }

    if (phaseId && taskMap.has(phaseId)) {
      addDirectAmount(phaseId, directSpent, Number(expense.amount ?? 0));
      continue;
    }

    if (expense.section) {
      const sectionNode = normalizedTasks.find(
        (task) => task.nodeType === "SECTION" && task.phase === expense.phase && task.title === expense.section
      );
      if (sectionNode) {
        addDirectAmount(toIdString(sectionNode._id), directSpent, Number(expense.amount ?? 0));
        continue;
      }
    }

    const phaseNode = normalizedTasks.find((task) => task.nodeType === "PHASE" && task.title === expense.phase);
    if (phaseNode) {
      addDirectAmount(toIdString(phaseNode._id), directSpent, Number(expense.amount ?? 0));
    }
  }

  for (const invoice of invoices) {
    if (!["UNPAID", "PARTIALLY_PAID"].includes(invoice.status)) {
      continue;
    }

    const openBalance = Math.max(0, Number((invoice.totalAmount - (invoice.paidAmount ?? 0)).toFixed(2)));
    if (openBalance <= 0) {
      continue;
    }

    const sectionId = toIdString(invoice.sectionTaskId);
    const phaseId = toIdString(invoice.phaseTaskId);

    if (sectionId && taskMap.has(sectionId)) {
      addDirectAmount(sectionId, directCommitted, openBalance);
      continue;
    }

    if (phaseId && taskMap.has(phaseId)) {
      addDirectAmount(phaseId, directCommitted, openBalance);
      continue;
    }

    if (invoice.section) {
      const sectionNode = normalizedTasks.find(
        (task) => task.nodeType === "SECTION" && task.phase === invoice.phase && task.title === invoice.section
      );
      if (sectionNode) {
        addDirectAmount(toIdString(sectionNode._id), directCommitted, openBalance);
        continue;
      }
    }

    const phaseNode = normalizedTasks.find((task) => task.nodeType === "PHASE" && task.title === invoice.phase);
    if (phaseNode) {
      addDirectAmount(toIdString(phaseNode._id), directCommitted, openBalance);
    }
  }

  const financialRollups = new Map<string, TaskNodeSummary["financials"]>();
  const progressRollups = new Map<string, TaskNodeSummary["progress"]>();
  const roots = normalizedTasks.filter((task) => task.nodeType === "PHASE" || !task.parentTaskId);

  function compute(task: any): { financials: TaskNodeSummary["financials"]; progress: TaskNodeSummary["progress"] } {
    const taskId = toIdString(task._id);
    const children = childrenMap.get(taskId) ?? [];
    const directSpentAmount = directSpent.get(taskId) ?? 0;
    const directCommittedAmount = directCommitted.get(taskId) ?? 0;
    let rolledSpent = directSpentAmount;
    let rolledCommitted = directCommittedAmount;
    let completedTasks = (task.nodeType ?? "TASK") === "TASK" && task.status === "DONE" ? 1 : 0;
    let totalTasks = (task.nodeType ?? "TASK") === "TASK" ? 1 : 0;
    let childEstimateTotal = 0;

    for (const child of children) {
      const childSummary = compute(child);
      rolledSpent += childSummary.financials.rolledSpent;
      rolledCommitted += childSummary.financials.rolledCommitted;
      completedTasks += childSummary.progress.completedTasks;
      totalTasks += childSummary.progress.totalTasks;
      childEstimateTotal += childSummary.financials.rolledEstimate;
    }

    const ownEstimate = Number(task.estimateAmount ?? task.budgetImpact ?? 0);
    const rolledEstimate = ownEstimate > 0 ? ownEstimate : Number(childEstimateTotal.toFixed(2));
    const percentComplete =
      totalTasks > 0
        ? Number(((completedTasks / totalTasks) * 100).toFixed(1))
        : task.status === "DONE"
          ? 100
          : task.status === "IN_PROGRESS"
            ? 50
            : 0;

    const summary = {
      financials: {
        directSpent: toMoney(directSpentAmount),
        directCommitted: toMoney(directCommittedAmount),
        rolledSpent: toMoney(rolledSpent),
        rolledCommitted: toMoney(rolledCommitted),
        rolledEstimate: toMoney(rolledEstimate),
        remaining: toMoney(rolledEstimate - rolledSpent - rolledCommitted)
      },
      progress: {
        totalTasks,
        completedTasks,
        percentComplete
      }
    };

    financialRollups.set(taskId, summary.financials);
    progressRollups.set(taskId, summary.progress);
    return summary;
  }

  for (const root of roots) {
    compute(root);
  }

  const currentPhase = roots.find((task) => task.nodeType === "PHASE" && task.status !== "DONE");
  const currentSection = currentPhase ? (childrenMap.get(toIdString(currentPhase._id)) ?? []).find((child) => child.status !== "DONE") : undefined;

  return {
    currentPhaseId: currentPhase ? toIdString(currentPhase._id) : undefined,
    currentSectionId: currentSection ? toIdString(currentSection._id) : undefined,
    tasks: normalizedTasks.map((task) => {
      const taskId = toIdString(task._id);
      return {
        _id: taskId,
        title: sanitizeTitle(task.title, "Untitled"),
        description: stripStaticTaskDetailLines(task.description),
        wbsId: resolveDynamicWbsId(task),
        predecessorWbsId: taskPredecessorWbsMap.get(taskId),
        phase: sanitizeTitle(task.phase, DEFAULT_PHASE_TITLE),
        section: sanitizeTitle(task.section, ""),
        nodeType: (task.nodeType ?? "TASK") as TaskNodeType,
        parentTaskId: toIdString(task.parentTaskId) || undefined,
        phaseTaskId: toIdString(task.phaseTaskId) || undefined,
        sectionTaskId: toIdString(task.sectionTaskId) || undefined,
        status: (task.status ?? "PLANNED") as TaskStatus,
        owner: task.owner ?? "",
        resources: parseTaskResources(task.owner),
        plannedStartDate: task.plannedStartDate ? new Date(task.plannedStartDate).toISOString() : undefined,
        plannedEndDate: task.plannedEndDate ? new Date(task.plannedEndDate).toISOString() : undefined,
        actualStartDate: task.actualStartDate ? new Date(task.actualStartDate).toISOString() : undefined,
        actualEndDate: task.actualEndDate ? new Date(task.actualEndDate).toISOString() : undefined,
        dueDate: task.dueDate ? new Date(task.dueDate).toISOString() : undefined,
        priority: task.priority ?? "MEDIUM",
        budgetImpact: Number(task.budgetImpact ?? task.estimateAmount ?? 0),
        estimateAmount: Number(task.estimateAmount ?? task.budgetImpact ?? 0),
        estimateGroupId: toIdString(task.estimateGroupId) || undefined,
        sortOrder: Number(task.sortOrder ?? 0),
        closedAt: task.closedAt ? new Date(task.closedAt).toISOString() : undefined,
        financials: financialRollups.get(taskId) ?? {
          directSpent: 0,
          directCommitted: 0,
          rolledSpent: 0,
          rolledCommitted: 0,
          rolledEstimate: 0,
          remaining: 0
        },
        progress: progressRollups.get(taskId) ?? {
          totalTasks: 0,
          completedTasks: 0,
          percentComplete: 0
        }
      };
    })
  };
}
