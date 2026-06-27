import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type {
  EstimateGroup,
  GeneratedPlanPhase,
  GeneratedTaskPlan,
  JmdRateQuote,
  Task,
  TaskFocusRequest,
  TaskInput,
  TaskNodeType,
  TaskStatus,
  WorkerProfile
} from "../types/models";
import { api } from "../utils/api";
import { formatCalendarDate, formatCurrency, formatDate, parseCalendarDate } from "../utils/format";
import { getTaskStatusLabel, taskStatuses } from "../utils/taskStatus";
import { getCurrentPhase, getPhaseNodes, getSectionsForPhase } from "../utils/workBreakdown";
import { BuildFlowWordmark } from "./BuildFlowLogo";
import { ConfirmDialog } from "./ConfirmDialog";

type TaskBoardProps = {
  tasks: Task[];
  canDeleteTask: boolean;
  focusTaskRequest?: TaskFocusRequest | null;
  onCreateTask: (payload: TaskInput) => Promise<void>;
  onUpdateTask: (id: string, payload: Partial<TaskInput>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onClearAllPhases?: () => Promise<void>;
  onRefreshData?: () => Promise<void>;
  onRegisterCreateLauncher?: (launch: (() => void) | null) => void;
  onTaskFocusHandled?: () => void;
};

type CreateMode = Exclude<TaskNodeType, "PHASE">;

type DraftState = {
  title: string;
  description: string;
  owner: string;
  dueDate: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  estimateAmount: string;
};

const defaultDraft: DraftState = {
  title: "",
  description: "",
  owner: "",
  dueDate: "",
  priority: "MEDIUM",
  estimateAmount: ""
};

type PhaseWizardDraft = {
  title: string;
  description: string;
  owner: string;
  status: TaskStatus;
  priority: "LOW" | "MEDIUM" | "HIGH";
  plannedStartDate: string;
  plannedEndDate: string;
  dueDate: string;
  estimateAmount: string;
};

type EstimateGroupDraft = {
  name: string;
  totalAmount: string;
  currency: string;
};

type PlanConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  plan?: GeneratedTaskPlan;
};

type PlanProvider = "openai" | "fallback" | "csv";
type CsvColumnMapping = {
  phaseColumn?: string;
  sectionColumn?: string;
  taskColumn?: string;
  wbsColumn?: string;
};

const phaseWizardSteps = ["Basics", "Schedule", "Budget"] as const;
const defaultPhaseWizardDraft: PhaseWizardDraft = {
  title: "",
  description: "",
  owner: "",
  status: "PLANNED",
  priority: "MEDIUM",
  plannedStartDate: "",
  plannedEndDate: "",
  dueDate: "",
  estimateAmount: ""
};

const defaultEstimateGroupDraft: EstimateGroupDraft = {
  name: "",
  totalAmount: "",
  currency: "USD"
};

const estimateGroupToneCount = 6;

function parseOwnerWorkers(owner: string | undefined): string[] {
  if (!owner) {
    return [];
  }

  return owner
    .split("|")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function serializeOwnerWorkers(workerNames: string[]): string {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const name of workerNames) {
    const normalized = name.trim();
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(normalized);
  }

  return unique.join(" | ");
}

function openDateInputPicker(input: HTMLInputElement) {
  const pickerInput = input as HTMLInputElement & { showPicker?: () => void };
  pickerInput.showPicker?.();
}

const PLAN_PROMPT_MAX_CHARS = 6000;
const PLAN_PROMPT_SAFE_CHARS = 5900;
const PLAN_BUILDER_STORAGE_KEY = "construction-os.plan-builder.v1";

function trimTextWithNotice(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const suffix = "\n...[truncated]";
  const keep = Math.max(0, maxChars - suffix.length);
  return `${value.slice(0, keep)}${suffix}`;
}

function buildPlanSnapshotText(plan: GeneratedTaskPlan): string {
  if (plan.phases.length === 0) {
    const clarificationLines =
      (plan.verificationQuestions ?? []).length > 0
        ? ["Clarifications requested:", ...(plan.verificationQuestions ?? []).map((question, index) => `  ${index + 1}. ${question}`)]
        : ["No phases are currently present in the generated plan."];
    return clarificationLines.join("\n");
  }

  return plan.phases
    .map((phase, phaseIndex) => {
      const phaseLine = `Phase ${phaseIndex + 1}: ${phase.title}`;
      const phaseNotes = phase.description ? `  Notes: ${phase.description}` : "  Notes: none";
      const sectionLines =
        phase.sections.length === 0
          ? ["  Sections: none"]
          : [
              "  Sections:",
              ...phase.sections.map((section, sectionIndex) => {
                const sectionLabel = `    ${sectionIndex + 1}. ${section.title}`;
                const sectionNotes = section.description ? ` (${section.description})` : "";
                const taskLines =
                  section.tasks.length === 0
                    ? ["      - no tasks"]
                    : section.tasks.slice(0, 8).map((task, taskIndex) => {
                        const wbs = task.wbsId ?? `${phaseIndex + 1}.${taskIndex + 1}`;
                        const predecessor = task.predecessor ?? "-";
                        const deliverable = task.deliverable ?? "pending deliverable";
                        return `      - ${wbs} | ${task.title} | predecessor: ${predecessor} | deliverable: ${deliverable}`;
                      });
                const extraTasks = section.tasks.length > 8 ? [`      - (+${section.tasks.length - 8} more tasks)`] : [];
                return [ `${sectionLabel}${sectionNotes}`, ...taskLines, ...extraTasks ].join("\n");
              })
            ];

      return [phaseLine, phaseNotes, ...sectionLines].join("\n");
    })
    .join("\n\n");
}

function buildBoundedRevisionPrompt(baseScope: string, revisionInput: string, plan: GeneratedTaskPlan): string {
  const instructionBlock = [
    "Regenerate the construction plan.",
    "Address every clarification and revision from the user.",
    "Return phases with sections and tasks.",
    "Include verification questions only when clarifications are still needed."
  ].join("\n");

  let boundedBaseScope = trimTextWithNotice(baseScope || "No base scope was captured.", 1400);
  let boundedRevision = trimTextWithNotice(revisionInput, 2200);
  const snapshotFull = buildPlanSnapshotText(plan);

  const renderPrompt = (snapshotText: string) =>
    [
      "Original build scope:",
      boundedBaseScope,
      "",
      "Current plan summary:",
      snapshotText,
      "",
      "Clarifications and revisions from user:",
      boundedRevision,
      "",
      instructionBlock
    ].join("\n");

  const fixedLengthWithoutSnapshot = renderPrompt("").length;
  let snapshotBudget = PLAN_PROMPT_SAFE_CHARS - fixedLengthWithoutSnapshot;

  if (snapshotBudget < 300) {
    const minimumSnapshot = 300;
    let deficit = minimumSnapshot - snapshotBudget;

    if (deficit > 0 && boundedBaseScope.length > 450) {
      const reducible = boundedBaseScope.length - 450;
      const reduceBy = Math.min(reducible, Math.ceil(deficit / 2));
      boundedBaseScope = trimTextWithNotice(boundedBaseScope, boundedBaseScope.length - reduceBy);
      deficit -= reduceBy;
    }

    if (deficit > 0 && boundedRevision.length > 500) {
      const reducible = boundedRevision.length - 500;
      const reduceBy = Math.min(reducible, deficit);
      boundedRevision = trimTextWithNotice(boundedRevision, boundedRevision.length - reduceBy);
    }

    snapshotBudget = PLAN_PROMPT_SAFE_CHARS - renderPrompt("").length;
  }

  const boundedSnapshot = trimTextWithNotice(snapshotFull, Math.max(180, snapshotBudget));
  const fullPrompt = renderPrompt(boundedSnapshot);
  return trimTextWithNotice(fullPrompt, PLAN_PROMPT_MAX_CHARS);
}

function createConversationId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCsvKey(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function parseCsvMatrix(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index] ?? "";

    if (inQuotes) {
      if (char === "\"") {
        const next = csvText[index + 1] ?? "";
        if (next === "\"") {
          cell += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.length > 1 || row[0]?.trim()) {
    rows.push(row);
  }

  return rows;
}

function withMappedAlias(mappedColumn: string | undefined, defaults: string[]): string[] {
  if (!mappedColumn || mappedColumn.trim().length === 0) {
    return defaults;
  }

  return [mappedColumn, ...defaults];
}

function promptCsvColumnMapping(csvText: string): CsvColumnMapping | null {
  const matrix = parseCsvMatrix(csvText);
  if (matrix.length === 0) {
    return null;
  }

  const headers = (matrix[0] ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  if (headers.length === 0) {
    return null;
  }

  const headerPreview = headers.join(", ");
  const phaseColumn = window.prompt(
    `CSV headers detected:\n${headerPreview}\n\nEnter the PHASE column header (leave blank to derive from WBS).`,
    "Phase"
  );
  if (phaseColumn === null) {
    return null;
  }

  const sectionColumn = window.prompt(
    "Enter the SECTION column header (leave blank to derive from WBS/current section).",
    "Section"
  );
  if (sectionColumn === null) {
    return null;
  }

  const taskColumn = window.prompt("Enter the TASK column header.", "Task_Name");
  if (taskColumn === null) {
    return null;
  }

  const wbsColumn = window.prompt("Enter the WBS column header (leave blank if none).", "WBS_ID");
  if (wbsColumn === null) {
    return null;
  }

  const normalize = (value: string | null): string | undefined => {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : undefined;
  };

  return {
    phaseColumn: normalize(phaseColumn),
    sectionColumn: normalize(sectionColumn),
    taskColumn: normalize(taskColumn),
    wbsColumn: normalize(wbsColumn)
  };
}

function getCsvValue(row: Record<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const key = normalizeCsvKey(alias);
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return "";
}

function parseGeneratedTaskStatus(value: string): TaskStatus | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["planned", "plan", "todo", "open", "not started", "not_started"].includes(normalized)) {
    return "PLANNED";
  }

  if (["in progress", "in_progress", "ongoing", "active", "started"].includes(normalized)) {
    return "IN_PROGRESS";
  }

  if (["blocked", "on hold", "on_hold", "stalled"].includes(normalized)) {
    return "BLOCKED";
  }

  if (["done", "complete", "completed", "closed", "finished"].includes(normalized)) {
    return "DONE";
  }

  return undefined;
}

function parseGeneratedPriority(value: string): "LOW" | "MEDIUM" | "HIGH" | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["low", "l"].includes(normalized)) {
    return "LOW";
  }

  if (["medium", "med", "m"].includes(normalized)) {
    return "MEDIUM";
  }

  if (["high", "h", "urgent", "critical"].includes(normalized)) {
    return "HIGH";
  }

  return undefined;
}

function parseGeneratedAmount(value: string): number | undefined {
  const normalized = value.replace(/,/g, "").replace(/[^0-9.-]/g, "");
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return Number(parsed.toFixed(2));
}

function parseGeneratedDate(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const parsedDate = new Date(normalized);
  if (Number.isNaN(parsedDate.getTime())) {
    return undefined;
  }

  return parsedDate.toISOString().slice(0, 10);
}

function buildGeneratedPlanFromCsv(csvText: string, mapping?: CsvColumnMapping): GeneratedTaskPlan {
  const rows = parseCsvMatrix(csvText);
  if (rows.length < 2) {
    throw new Error("CSV must include a header row and at least one data row.");
  }

  const header = rows[0].map((value, index) => normalizeCsvKey(value) || `column${index + 1}`);
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => cell.trim().length > 0));
  if (dataRows.length === 0) {
    throw new Error("CSV does not contain any data rows.");
  }

  const phaseTitleAliases = withMappedAlias(mapping?.phaseColumn, [
    "phase",
    "phase title",
    "phase name",
    "phasetitle",
    "phasename"
  ]);
  const sectionTitleAliases = withMappedAlias(mapping?.sectionColumn, [
    "section",
    "section title",
    "section name",
    "sectiontitle",
    "sectionname"
  ]);
  const taskTitleAliases = withMappedAlias(mapping?.taskColumn, [
    "task_name",
    "task name",
    "task",
    "tasktitle",
    "taskname",
    "activity",
    "item"
  ]);
  const wbsAliases = withMappedAlias(mapping?.wbsColumn, [
    "wbs_id",
    "wbs id",
    "wbs",
    "task wbs",
    "task_wbs",
    "task wbs id",
    "wbsid"
  ]);
  const phaseWbsAliases = withMappedAlias(mapping?.wbsColumn, [
    "phase wbs",
    "phase wbs id",
    "phasewbs",
    "phasewbsid",
    "wbs phase",
    "wbsphase"
  ]);
  const phaseDescriptionAliases = ["phase description", "phase notes", "phase scope", "phasedescription", "phasenotes"];
  const phaseStatusAliases = ["phase status", "phasestatus"];
  const phaseOwnerAliases = ["phase owner", "phaseowner", "owner"];
  const phasePriorityAliases = ["phase priority", "phasepriority", "priority"];
  const phasePlannedStartAliases = ["phase planned start", "phase start", "planned start", "phasestart"];
  const phasePlannedEndAliases = ["phase planned end", "phase end", "planned end", "phaseend"];
  const phaseDueDateAliases = ["phase due date", "due date", "phaseduedate"];
  const phaseEstimateAliases = ["phase estimate", "phase amount", "phase budget", "phaseestimate"];
  const sectionDescriptionAliases = ["section description", "section notes", "sectionscope", "sectiondescription"];
  const sectionStatusAliases = ["section status", "sectionstatus"];
  const sectionOwnerAliases = ["section owner", "sectionowner"];
  const sectionEstimateAliases = ["section estimate", "section amount", "section budget", "sectionestimate"];
  const taskDescriptionAliases = ["task description", "task_description", "description"];
  const taskStatusAliases = ["task status", "taskstatus"];
  const taskPriorityAliases = ["task priority", "taskpriority"];
  const taskEstimateAliases = ["task estimate", "task amount", "task budget", "taskestimate"];
  const taskWbsAliases = withMappedAlias(mapping?.wbsColumn, [
    "task wbs",
    "task wbs id",
    "taskwbs",
    "taskwbsid",
    "wbs id",
    "wbsid",
    "wbs"
  ]);
  const predecessorAliases = ["predecessor", "pred", "depends on", "dependency", "dependson"];
  const deliverableAliases = ["deliverable", "output", "milestone"];
  const durationAliases = ["duration days", "duration_days", "duration", "days"];
  const resourceAliases = ["resource", "crew", "trade"];
  const notesAliases = ["jamaica notes", "jamaica_notes", "task notes", "task_notes", "notes"];

  const phases: GeneratedTaskPlan["phases"] = [];
  const phaseIndexByKey = new Map<string, number>();
  const phaseIndexByRoot = new Map<string, number>();
  const sectionIndexByPhase = new Map<string, Map<string, number>>();

  let currentPhaseTitle = "";
  let currentSectionTitle = "";

  const hasExplicitPhaseColumn = header.some((column) =>
    new Set(["phase", "phasetitle", "phasename"]).has(column)
  );
  const hasWbsColumn = header.some((column) =>
    new Set(["wbs", "wbsid", "taskwbs", "taskwbsid"]).has(column)
  );
  const hasTaskNameColumn = header.some((column) =>
    new Set(["taskname", "task", "activity", "item"]).has(column)
  );
  const sectionHeadersWithChildren = new Set<string>();

  for (const cells of dataRows) {
    const row: Record<string, string> = {};
    header.forEach((key, colIndex) => {
      row[key] = (cells[colIndex] ?? "").trim();
    });

    const rawWbs = getCsvValue(row, wbsAliases).trim();
    const parts = rawWbs.split(".").filter((part) => part.length > 0);
    if (parts.length >= 3 && /^\d+$/.test(parts[0] ?? "") && /^\d+$/.test(parts[1] ?? "")) {
      sectionHeadersWithChildren.add(`${parts[0]}.${parts[1]}`);
    }
  }

  dataRows.forEach((cells) => {
    const row: Record<string, string> = {};
    header.forEach((key, colIndex) => {
      row[key] = (cells[colIndex] ?? "").trim();
    });

    const wbsValue = getCsvValue(row, wbsAliases).trim();
    const taskNameValue = getCsvValue(row, taskTitleAliases).trim();
    const wbsParts = wbsValue.split(".").filter((part) => part.length > 0);
    const phaseRoot = (wbsParts[0]?.match(/^\d+/)?.[0] ?? "").trim();
    const isPhaseHeaderByWbs = /^\d+\.0$/i.test(wbsValue);
    const isSectionHeaderByWbs = /^\d+\.\d+$/i.test(wbsValue) && !isPhaseHeaderByWbs;
    const isMilestoneWbs = /^\d+\.[a-z]/i.test(wbsValue);

    const explicitPhaseTitle = getCsvValue(row, phaseTitleAliases);
    if (explicitPhaseTitle) {
      currentPhaseTitle = explicitPhaseTitle;
      currentSectionTitle = "";
    }

    const existingPhaseIndexByRoot = phaseRoot ? phaseIndexByRoot.get(phaseRoot) : undefined;
    const existingPhaseByRoot =
      typeof existingPhaseIndexByRoot === "number" ? phases[existingPhaseIndexByRoot] : undefined;
    const derivedPhaseTitle =
      !explicitPhaseTitle && !currentPhaseTitle
        ? isPhaseHeaderByWbs && taskNameValue
          ? taskNameValue
          : existingPhaseByRoot?.title ?? (phaseRoot ? `Phase ${phaseRoot}` : "")
        : "";

    const phaseTitle = explicitPhaseTitle || currentPhaseTitle || derivedPhaseTitle;
    if (!phaseTitle) {
      return;
    }

    currentPhaseTitle = phaseTitle;

    const explicitSectionTitle = getCsvValue(row, sectionTitleAliases);
    if (explicitSectionTitle) {
      currentSectionTitle = explicitSectionTitle;
    }

    const derivedSectionWbs =
      wbsParts.length >= 2 && /^\d+$/.test(wbsParts[1] ?? "") && !isPhaseHeaderByWbs
        ? `${wbsParts[0]}.${wbsParts[1]}`
        : isMilestoneWbs
          ? `${wbsParts[0]}.M`
          : "";

    const derivedSectionTitle =
      isSectionHeaderByWbs && taskNameValue
        ? taskNameValue
        : derivedSectionWbs
          ? `Section ${derivedSectionWbs}`
          : "";

    const sectionTitle = explicitSectionTitle || currentSectionTitle || derivedSectionTitle || "General";
    currentSectionTitle = sectionTitle;

    const phaseWbsId = getCsvValue(row, phaseWbsAliases) || (phaseRoot ? `${phaseRoot}.0` : "");
    const phaseKeyBase = phaseRoot || phaseWbsId || phaseTitle;
    const phaseKey = `${phaseKeyBase.toLowerCase()}::${phaseTitle.toLowerCase()}`;

    let phaseIndex = phaseIndexByKey.get(phaseKey);
    if (phaseIndex === undefined && phaseRoot) {
      phaseIndex = phaseIndexByRoot.get(phaseRoot);
    }

    if (phaseIndex === undefined) {
      phaseIndex = phases.length;
      phaseIndexByKey.set(phaseKey, phaseIndex);
      if (phaseRoot) {
        phaseIndexByRoot.set(phaseRoot, phaseIndex);
      }
      phases.push({
        title: phaseTitle,
        description: getCsvValue(row, phaseDescriptionAliases),
        status: parseGeneratedTaskStatus(getCsvValue(row, phaseStatusAliases)),
        owner: getCsvValue(row, phaseOwnerAliases) || undefined,
        priority: parseGeneratedPriority(getCsvValue(row, phasePriorityAliases)),
        plannedStartDate: parseGeneratedDate(getCsvValue(row, phasePlannedStartAliases)),
        plannedEndDate: parseGeneratedDate(getCsvValue(row, phasePlannedEndAliases)),
        dueDate: parseGeneratedDate(getCsvValue(row, phaseDueDateAliases)),
        estimateAmount: parseGeneratedAmount(getCsvValue(row, phaseEstimateAliases)),
        wbsId: phaseWbsId || undefined,
        sections: []
      });
      sectionIndexByPhase.set(phaseKey, new Map<string, number>());
    }

    const phase = phases[phaseIndex];
    if (!phase.description) {
      phase.description = getCsvValue(row, phaseDescriptionAliases) || undefined;
    }
    phase.status ??= parseGeneratedTaskStatus(getCsvValue(row, phaseStatusAliases));
    phase.owner ??= getCsvValue(row, phaseOwnerAliases) || undefined;
    phase.priority ??= parseGeneratedPriority(getCsvValue(row, phasePriorityAliases));
    phase.plannedStartDate ??= parseGeneratedDate(getCsvValue(row, phasePlannedStartAliases));
    phase.plannedEndDate ??= parseGeneratedDate(getCsvValue(row, phasePlannedEndAliases));
    phase.dueDate ??= parseGeneratedDate(getCsvValue(row, phaseDueDateAliases));
    phase.estimateAmount ??= parseGeneratedAmount(getCsvValue(row, phaseEstimateAliases));
    phase.wbsId ??= phaseWbsId || undefined;

    const effectivePhaseKey = Array.from(phaseIndexByKey.entries()).find(([, index]) => index === phaseIndex)?.[0] ?? phaseKey;
    const phaseSections = sectionIndexByPhase.get(effectivePhaseKey) ?? new Map<string, number>();
    sectionIndexByPhase.set(phaseKey, phaseSections);
    sectionIndexByPhase.set(effectivePhaseKey, phaseSections);
    const sectionKey = (derivedSectionWbs || sectionTitle).toLowerCase();

    let sectionIndex = phaseSections.get(sectionKey);
    if (sectionIndex === undefined) {
      sectionIndex = phase.sections.length;
      phaseSections.set(sectionKey, sectionIndex);
      phase.sections.push({
        title: sectionTitle,
        description: getCsvValue(row, sectionDescriptionAliases) || undefined,
        status: parseGeneratedTaskStatus(getCsvValue(row, sectionStatusAliases)),
        owner: getCsvValue(row, sectionOwnerAliases) || undefined,
        estimateAmount: parseGeneratedAmount(getCsvValue(row, sectionEstimateAliases)),
        tasks: []
      });
    }

    const section = phase.sections[sectionIndex];
    section.description ??= getCsvValue(row, sectionDescriptionAliases) || undefined;
    section.status ??= parseGeneratedTaskStatus(getCsvValue(row, sectionStatusAliases));
    section.owner ??= getCsvValue(row, sectionOwnerAliases) || undefined;
    section.estimateAmount ??= parseGeneratedAmount(getCsvValue(row, sectionEstimateAliases));

    const predecessorValue = getCsvValue(row, predecessorAliases);
    const deliverableValue = getCsvValue(row, deliverableAliases);
    const duration = getCsvValue(row, durationAliases);
    const resource = getCsvValue(row, resourceAliases);
    const csvNotes = getCsvValue(row, notesAliases);
    const csvDescription = getCsvValue(row, taskDescriptionAliases);
    const hasRowTaskSignals = [
      predecessorValue,
      deliverableValue,
      duration,
      resource,
      csvNotes,
      csvDescription,
      getCsvValue(row, taskStatusAliases),
      getCsvValue(row, taskPriorityAliases),
      getCsvValue(row, taskEstimateAliases),
      getCsvValue(row, ["status"]),
      getCsvValue(row, ["priority"]),
      getCsvValue(row, ["estimate"]),
      getCsvValue(row, ["amount"])
    ].some((value) => value.trim().length > 0);

    const shouldTreatAsSectionHeader =
      isSectionHeaderByWbs &&
      !explicitSectionTitle &&
      taskNameValue.length > 0 &&
      sectionHeadersWithChildren.has(wbsValue) &&
      !hasRowTaskSignals;

    if (shouldTreatAsSectionHeader) {
      return;
    }

    const taskTitle = getCsvValue(row, taskTitleAliases);
    if (!taskTitle) {
      return;
    }

    const normalizedTaskTitle = taskTitle.trim().toLowerCase();
    const normalizedSectionTitle = section.title.trim().toLowerCase();
    if (shouldTreatAsSectionHeader && normalizedTaskTitle === normalizedSectionTitle) {
      return;
    }

    const descriptionParts = [csvDescription];
    if (duration) {
      descriptionParts.push(`Duration (days): ${duration}`);
    }
    if (resource) {
      descriptionParts.push(`Resource: ${resource}`);
    }
    if (csvNotes) {
      descriptionParts.push(`Notes: ${csvNotes}`);
    }
    const mergedDescription = descriptionParts.map((part) => part.trim()).filter((part) => part.length > 0).join("\n");

    section.tasks.push({
      title: taskTitle,
      description: mergedDescription || undefined,
      status: parseGeneratedTaskStatus(getCsvValue(row, taskStatusAliases)) ?? parseGeneratedTaskStatus(getCsvValue(row, ["status"])),
      priority: parseGeneratedPriority(getCsvValue(row, taskPriorityAliases)) ?? parseGeneratedPriority(getCsvValue(row, ["priority"])),
      estimateAmount:
        parseGeneratedAmount(getCsvValue(row, taskEstimateAliases)) ??
        parseGeneratedAmount(getCsvValue(row, ["estimate", "amount"])),
      wbsId: getCsvValue(row, taskWbsAliases) || undefined,
      predecessor: predecessorValue || undefined,
      deliverable: deliverableValue || undefined
    });
  });

  if (phases.length === 0) {
    if (hasWbsColumn && hasTaskNameColumn) {
      throw new Error(
        "No phases could be derived from WBS rows. Include rows like 1.0, 2.0 in WBS_ID or add a Phase column."
      );
    }
    throw new Error("No phases found in CSV. Include a 'Phase' column or WBS_ID + Task_Name columns.");
  }

  return {
    phases,
    assumptions: ["Imported from CSV. Review sections/tasks before building."],
    verificationQuestions: []
  };
}

function ProgressMeter({ value }: { value: number }) {
  return (
    <div className="task-progress-meter" aria-label={`${value}% complete`}>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function getCreateButtonLabel(mode: CreateMode): string {
  if (mode === "SECTION") {
    return "Add Section";
  }

  return "Add Task";
}

function getPhaseTimelineTone(status: TaskStatus): "done" | "active" | "planned" {
  if (status === "DONE") {
    return "done";
  }

  if (status === "IN_PROGRESS" || status === "BLOCKED") {
    return "active";
  }

  return "planned";
}

function toDateInputValue(value?: string): string {
  return value ? value.slice(0, 10) : "";
}

function getTaskDueMeta(dueDate?: string, status?: TaskStatus): { label: string; tone: "none" | "normal" | "today" | "overdue" } {
  if (!dueDate) {
    return { label: "No due date", tone: "none" };
  }

  const due = parseCalendarDate(dueDate);
  if (!due) {
    return { label: "No due date", tone: "none" };
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (status !== "DONE" && due.getTime() < today.getTime()) {
    const daysLate = Math.max(1, Math.floor((today.getTime() - due.getTime()) / 86_400_000));
    return {
      label: daysLate === 1 ? "1 day overdue" : `${daysLate} days overdue`,
      tone: "overdue"
    };
  }

  if (due.getTime() === today.getTime()) {
    return { label: "Due today", tone: "today" };
  }

  return { label: `Due ${formatCalendarDate(dueDate)}`, tone: "normal" };
}

function getSectionProgressTone(sectionTasks: Task[]): "planned" | "active" | "done" {
  if (sectionTasks.length === 0) {
    return "planned";
  }

  const completedCount = sectionTasks.filter((task) => task.status === "DONE").length;
  if (completedCount === sectionTasks.length) {
    return "done";
  }

  const hasStartedWork = sectionTasks.some((task) => task.status !== "PLANNED");
  return hasStartedWork ? "active" : "planned";
}

function getPreferredSectionId(sections: Task[]): string {
  const inProgressSection = sections.find((section) => section.status === "IN_PROGRESS");
  if (inProgressSection?._id) {
    return inProgressSection._id;
  }

  const blockedSection = sections.find((section) => section.status === "BLOCKED");
  if (blockedSection?._id) {
    return blockedSection._id;
  }

  return sections[0]?._id ?? "";
}

function areTaskIdListsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function moveTaskIdWithinList(taskIds: string[], draggedTaskId: string, targetTaskId: string, placeAfter: boolean): string[] {
  if (draggedTaskId === targetTaskId) {
    return taskIds;
  }

  const nextTaskIds = [...taskIds];
  const draggedIndex = nextTaskIds.indexOf(draggedTaskId);
  const targetIndex = nextTaskIds.indexOf(targetTaskId);

  if (draggedIndex < 0 || targetIndex < 0) {
    return taskIds;
  }

  nextTaskIds.splice(draggedIndex, 1);
  const adjustedTargetIndex = nextTaskIds.indexOf(targetTaskId);
  const insertIndex = Math.max(0, adjustedTargetIndex + (placeAfter ? 1 : 0));
  nextTaskIds.splice(insertIndex, 0, draggedTaskId);

  return nextTaskIds;
}

function getTimelineShortNote(value?: string, maxChars = 84): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No notes yet.";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function PhaseInfoIcon({
  kind
}: {
  kind: "status" | "budget" | "planned-start" | "planned-end" | "actual-start" | "actual-end" | "spent";
}) {
  const iconProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  if (kind === "status") {
    return (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="8" />
        <path d="m9.5 12 1.8 1.8 3.2-3.6" />
      </svg>
    );
  }

  if (kind === "budget" || kind === "spent") {
    return (
      <svg {...iconProps}>
        <rect x="3" y="6" width="18" height="12" rx="1" />
        <path d="M3 10h18" />
        <path d="M8 14h2" />
      </svg>
    );
  }

  return (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <path d="M3 10h18" />
    </svg>
  );
}

export function TaskBoard({
  tasks,
  canDeleteTask,
  focusTaskRequest,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onClearAllPhases,
  onRefreshData,
  onRegisterCreateLauncher,
  onTaskFocusHandled
}: TaskBoardProps) {
  const [createMode, setCreateMode] = useState<CreateMode>("TASK");
  const [draft, setDraft] = useState<DraftState>(defaultDraft);
  const [duplicateSourceTaskId, setDuplicateSourceTaskId] = useState<string | null>(null);
  const [showCreateWidget, setShowCreateWidget] = useState(false);
  const [showPhaseWizard, setShowPhaseWizard] = useState(false);
  const [phaseWizardStep, setPhaseWizardStep] = useState(0);
  const [phaseWizardDraft, setPhaseWizardDraft] = useState<PhaseWizardDraft>(defaultPhaseWizardDraft);
  const [saving, setSaving] = useState(false);
  const [savingPhaseWizard, setSavingPhaseWizard] = useState(false);
  const [showPlanBuilder, setShowPlanBuilder] = useState(false);
  const [showMilestoneBoard, setShowMilestoneBoard] = useState(false);
  const [planPrompt, setPlanPrompt] = useState("");
  const [planBasePrompt, setPlanBasePrompt] = useState("");
  const [generatedPlan, setGeneratedPlan] = useState<GeneratedTaskPlan | null>(null);
  const [planProvider, setPlanProvider] = useState<PlanProvider | null>(null);
  const [planWarning, setPlanWarning] = useState("");
  const [planError, setPlanError] = useState("");
  const [generatingPlan, setGeneratingPlan] = useState(false);
  const [buildingPlan, setBuildingPlan] = useState(false);
  const [verificationChecks, setVerificationChecks] = useState<Record<string, boolean>>({});
  const [planConversation, setPlanConversation] = useState<PlanConversationMessage[]>([]);
  const [plannerStateHydrated, setPlannerStateHydrated] = useState(false);
  const [planIntroState, setPlanIntroState] = useState<"intro" | "transitioning" | "active">("intro");
  const [selectedPhaseId, setSelectedPhaseId] = useState("");
  const [selectedSectionId, setSelectedSectionId] = useState("");
  const [draggingTaskState, setDraggingTaskState] = useState<{ taskId: string; sectionId: string } | null>(null);
  const [taskOrderPreview, setTaskOrderPreview] = useState<Record<string, string[]>>({});
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const [drawerForm, setDrawerForm] = useState<Partial<TaskInput>>({});
  const [drawerEstimateInput, setDrawerEstimateInput] = useState("");
  const [savingDrawer, setSavingDrawer] = useState(false);
  const [clearingAllPhases, setClearingAllPhases] = useState(false);
  const [showBuildPlanConfirm, setShowBuildPlanConfirm] = useState(false);
  const [quickStatusMenuTaskId, setQuickStatusMenuTaskId] = useState<string | null>(null);
  const [quickTaskActionId, setQuickTaskActionId] = useState<string | null>(null);
  const [quickWorkerActionId, setQuickWorkerActionId] = useState<string | null>(null);
  const [workers, setWorkers] = useState<WorkerProfile[]>([]);
  const [workerPickerNodeId, setWorkerPickerNodeId] = useState<string | null>(null);
  const [workerPickerQuery, setWorkerPickerQuery] = useState("");
  const [workerInfoChipKey, setWorkerInfoChipKey] = useState<string | null>(null);
  const [estimateGroups, setEstimateGroups] = useState<EstimateGroup[]>([]);
  const [estimateGroupsLoading, setEstimateGroupsLoading] = useState(false);
  const [estimateGroupsError, setEstimateGroupsError] = useState("");
  const [groupingSectionId, setGroupingSectionId] = useState<string | null>(null);
  const [selectedGroupedTaskIds, setSelectedGroupedTaskIds] = useState<string[]>([]);
  const [showEstimateGroupModal, setShowEstimateGroupModal] = useState(false);
  const [estimateGroupDraft, setEstimateGroupDraft] = useState<EstimateGroupDraft>(defaultEstimateGroupDraft);
  const [savingEstimateGroup, setSavingEstimateGroup] = useState(false);
  const [showEstimateManager, setShowEstimateManager] = useState(false);
  const [activeEstimateGroupId, setActiveEstimateGroupId] = useState<string | null>(null);
  const [estimateManagerName, setEstimateManagerName] = useState("");
  const [estimateManagerTotal, setEstimateManagerTotal] = useState("");
  const [estimateManagerCurrency, setEstimateManagerCurrency] = useState("USD");
  const [estimateManagerAllocations, setEstimateManagerAllocations] = useState<Record<string, string>>({});
  const [savingEstimateManager, setSavingEstimateManager] = useState(false);
  const [estimateGroupFxQuote, setEstimateGroupFxQuote] = useState<JmdRateQuote | null>(null);
  const [loadingEstimateGroupFxQuote, setLoadingEstimateGroupFxQuote] = useState(false);
  const [estimateGroupFxError, setEstimateGroupFxError] = useState("");
  const [estimatePaymentAmount, setEstimatePaymentAmount] = useState("");
  const [savingEstimateGroupPayment, setSavingEstimateGroupPayment] = useState(false);
  const [showDissolveEstimateGroupConfirm, setShowDissolveEstimateGroupConfirm] = useState(false);
  const [dissolvingEstimateGroup, setDissolvingEstimateGroup] = useState(false);
  const [planScrollTick, setPlanScrollTick] = useState(0);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const drawerNotesTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const planCsvInputRef = useRef<HTMLInputElement | null>(null);
  const planPreviewScrollRef = useRef<HTMLDivElement | null>(null);
  const planIntroTimerRef = useRef<number | null>(null);
  const phaseSummaryRef = useRef<HTMLDivElement | null>(null);
  const previousActivePhaseIdRef = useRef<string>("");
  const taskDragDroppedRef = useRef(false);
  const reorderQueueRef = useRef<Record<string, { inFlight: boolean; pendingTaskIds?: string[] }>>({});

  const phases = useMemo(() => getPhaseNodes(tasks), [tasks]);
  const currentPhase = useMemo(() => getCurrentPhase(tasks), [tasks]);
  const sections = useMemo(() => getSectionsForPhase(tasks, selectedPhaseId), [tasks, selectedPhaseId]);
  const activePhase = useMemo(
    () => phases.find((phase) => phase._id === selectedPhaseId) ?? phases[0] ?? null,
    [phases, selectedPhaseId]
  );
  const activeSections = useMemo(() => getSectionsForPhase(tasks, activePhase?._id), [tasks, activePhase?._id]);
  const activePhaseTasks = useMemo(
    () => tasks.filter((task) => task.nodeType === "TASK" && task.phaseTaskId === activePhase?._id),
    [tasks, activePhase?._id]
  );
  const activeDrawerTask = useMemo(
    () => (drawerTaskId ? tasks.find((task) => task._id === drawerTaskId) ?? null : null),
    [drawerTaskId, tasks]
  );
  const duplicateSourceTask = useMemo(
    () => (duplicateSourceTaskId ? tasks.find((task) => task._id === duplicateSourceTaskId) ?? null : null),
    [duplicateSourceTaskId, tasks]
  );
  const sectionMoveGroups = useMemo(
    () =>
      phases
        .map((phase) => ({
          phaseId: phase._id,
          phaseTitle: phase.title,
          sections: getSectionsForPhase(tasks, phase._id)
        }))
        .filter((group) => group.sections.length > 0),
    [phases, tasks]
  );
  const workerPickerResults = useMemo(() => {
    const query = workerPickerQuery.trim().toLowerCase();
    const activeWorkers = workers.filter((worker) => worker.isActive);
    if (!query) {
      return activeWorkers;
    }

    return activeWorkers.filter((worker) => {
      const name = worker.name.toLowerCase();
      const role = worker.role.toLowerCase().replace(/_/g, " ");
      const company = worker.company.toLowerCase();
      return name.includes(query) || role.includes(query) || company.includes(query);
    });
  }, [workerPickerQuery, workers]);
  const ownerSelectOptions = useMemo(
    () =>
      workers
        .filter((worker) => worker.isActive)
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((worker) => ({
          value: worker.name,
          label: `${worker.name} · ${worker.role.replace(/_/g, " ")}`
        })),
    [workers]
  );
  const workersByName = useMemo(() => {
    const workerMap = new Map<string, WorkerProfile>();
    workers.forEach((worker) => {
      workerMap.set(worker.name.trim().toLowerCase(), worker);
    });
    return workerMap;
  }, [workers]);
  const estimateGroupsById = useMemo(() => {
    const groupMap = new Map<string, EstimateGroup>();
    estimateGroups.forEach((group) => {
      groupMap.set(group._id, group);
    });
    return groupMap;
  }, [estimateGroups]);
  const activeDrawerEstimateGroup = useMemo(
    () =>
      activeDrawerTask?.estimateGroupId ? estimateGroupsById.get(activeDrawerTask.estimateGroupId) ?? null : null,
    [activeDrawerTask, estimateGroupsById]
  );
  const groupedTaskIdSet = useMemo(() => new Set(estimateGroups.flatMap((group) => group.taskIds)), [estimateGroups]);
  const activeSectionEstimateGroups = useMemo(
    () => estimateGroups.filter((group) => group.sectionTaskId === selectedSectionId),
    [estimateGroups, selectedSectionId]
  );
  const activeEstimateGroup = useMemo(
    () => (activeEstimateGroupId ? estimateGroups.find((group) => group._id === activeEstimateGroupId) ?? null : null),
    [activeEstimateGroupId, estimateGroups]
  );
  const activeEstimateGroupTasks = useMemo(() => {
    if (!activeEstimateGroup) {
      return [];
    }

    const taskOrder = new Map(activeEstimateGroup.taskIds.map((taskId, index) => [taskId, index]));
    return tasks
      .filter((task) => activeEstimateGroup.taskIds.includes(task._id))
      .slice()
      .sort((left, right) => (taskOrder.get(left._id) ?? 0) - (taskOrder.get(right._id) ?? 0));
  }, [activeEstimateGroup, tasks]);
  const estimateManagerShowsJmd = isEstimateGroupJmd(estimateManagerCurrency);
  const estimateManagerTotalUsd = convertEstimateGroupEntryToUsd(
    parseEstimateInput(estimateManagerTotal),
    estimateManagerCurrency,
    estimateGroupFxQuote
  );
  const estimateManagerAllocatedUsd = useMemo(
    () =>
      activeEstimateGroup
        ? activeEstimateGroup.taskIds.reduce(
            (sum, taskId) => sum + parseEstimateInput(estimateManagerAllocations[taskId] ?? ""),
            0
          )
        : 0,
    [activeEstimateGroup, estimateManagerAllocations]
  );

  function getOwnerOptions(currentOwner?: string) {
    const options = [...ownerSelectOptions];
    const normalizedCurrentOwner = currentOwner?.trim() ?? "";
    if (!normalizedCurrentOwner) {
      return options;
    }

    const exists = options.some((option) => option.value.toLowerCase() === normalizedCurrentOwner.toLowerCase());
    if (!exists) {
      options.unshift({
        value: normalizedCurrentOwner,
        label: normalizedCurrentOwner
      });
    }

    return options;
  }

  function parseEstimateInput(value: string): number {
    const normalized = value.trim();
    if (!normalized) {
      return 0;
    }

    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      return 0;
    }

    return Math.max(0, parsed);
  }

function formatEstimateInput(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "";
  }

  return value === 0 ? "0" : String(value);
}

function normalizeEstimateGroupCurrency(value?: string): string {
  const normalized = (value ?? "USD").trim().toUpperCase();
  return normalized.length === 3 ? normalized : "USD";
}

function isEstimateGroupJmd(value?: string): boolean {
  return normalizeEstimateGroupCurrency(value) === "JMD";
}

function convertEstimateGroupEntryToUsd(value: number, currency: string | undefined, quote: JmdRateQuote | null): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  if (isEstimateGroupJmd(currency)) {
    const rate = Number(quote?.rate ?? 0);
    return rate > 0 ? Number((value / rate).toFixed(2)) : 0;
  }

  return Number(value.toFixed(2));
}

function formatEstimateGroupEntryMoney(value: number, currency: string | undefined): string {
  return formatCurrency(value, normalizeEstimateGroupCurrency(currency));
}

  async function loadEstimateGroups() {
    setEstimateGroupsLoading(true);
    setEstimateGroupsError("");
    try {
      const response = await api.getEstimateGroups();
      setEstimateGroups(response.estimateGroups);
      if ((response.repairedPaymentExpenseCount ?? 0) > 0) {
        await onRefreshData?.();
      }
    } catch (error) {
      setEstimateGroupsError(error instanceof Error ? error.message : "Could not load grouped estimates.");
    } finally {
      setEstimateGroupsLoading(false);
    }
  }

  function closeCreateWidget() {
    setShowCreateWidget(false);
    setDuplicateSourceTaskId(null);
    setDraft(defaultDraft);
  }

  function openDuplicateTask(task: Task) {
    const targetPhaseId = task.phaseTaskId ?? activePhase?._id ?? "";
    const targetSectionId =
      task.nodeType === "TASK"
        ? task.sectionTaskId ?? task.parentTaskId ?? ""
        : "";

    setCreateMode("TASK");
    setDuplicateSourceTaskId(task._id);
    setSelectedPhaseId(targetPhaseId);
    setSelectedSectionId(targetSectionId);
    setDraft({
      title: `${task.title} Copy`,
      description: task.description ?? "",
      owner: task.owner ?? "",
      dueDate: toDateInputValue(task.dueDate),
      priority: task.priority ?? "MEDIUM",
      estimateAmount: formatEstimateInput(task.estimateAmount)
    });
    setShowCreateWidget(true);
  }

  function openPhaseWizard() {
    setPhaseWizardDraft(defaultPhaseWizardDraft);
    setPhaseWizardStep(0);
    closeCreateWidget();
    setShowPhaseWizard(true);
  }

  function closeEstimateGroupModal() {
    setShowEstimateGroupModal(false);
    setEstimateGroupDraft(defaultEstimateGroupDraft);
  }

  function resetTaskGroupingSelection() {
    setGroupingSectionId(null);
    setSelectedGroupedTaskIds([]);
    closeEstimateGroupModal();
  }

  function toggleSectionGrouping(sectionId: string) {
    if (groupingSectionId === sectionId) {
      resetTaskGroupingSelection();
      return;
    }

    setGroupingSectionId(sectionId);
    setSelectedGroupedTaskIds([]);
    closeEstimateGroupModal();
  }

  function toggleTaskGroupingSelection(taskId: string) {
    setSelectedGroupedTaskIds((current) =>
      current.includes(taskId) ? current.filter((entry) => entry !== taskId) : [...current, taskId]
    );
  }

  function openEstimateManager(sectionId: string, preferredGroupId?: string) {
    const sectionGroups = estimateGroups.filter((group) => group.sectionTaskId === sectionId);
    if (sectionGroups.length === 0) {
      return;
    }

    setSelectedSectionId(sectionId);
    setActiveEstimateGroupId(preferredGroupId ?? sectionGroups[0]?._id ?? null);
    setShowEstimateManager(true);
  }

  function closePhaseWizard() {
    setShowPhaseWizard(false);
    setPhaseWizardStep(0);
  }

  function openPlanBuilder() {
    if (planIntroTimerRef.current !== null) {
      window.clearTimeout(planIntroTimerRef.current);
      planIntroTimerRef.current = null;
    }

    const hasSavedPlannerActivity =
      Boolean(generatedPlan) ||
      planConversation.length > 0 ||
      planBasePrompt.trim().length > 0 ||
      planPrompt.trim().length > 0;

    setPlanIntroState(hasSavedPlannerActivity ? "active" : "intro");
    setPlanError("");
    closeCreateWidget();
    setShowPhaseWizard(false);
    setShowPlanBuilder(true);
  }

  function closePlanBuilder() {
    if (planIntroTimerRef.current !== null) {
      window.clearTimeout(planIntroTimerRef.current);
      planIntroTimerRef.current = null;
    }

    setShowPlanBuilder(false);
    setPlanError("");
  }

  function startPlanningSession() {
    if (planIntroState !== "intro") {
      return;
    }

    setPlanIntroState("transitioning");
    if (planIntroTimerRef.current !== null) {
      window.clearTimeout(planIntroTimerRef.current);
    }

    planIntroTimerRef.current = window.setTimeout(() => {
      setPlanIntroState("active");
      planIntroTimerRef.current = null;
    }, 620);
  }

  function applyGeneratedPlan(
    plan: GeneratedTaskPlan,
    provider: PlanProvider,
    warning?: string
  ) {
    setGeneratedPlan(plan);
    setPlanProvider(provider);
    setPlanWarning(warning ?? "");
    setVerificationChecks(
      Object.fromEntries(
        (plan.verificationQuestions ?? []).map((question) => [question, false])
      )
    );
  }

  function appendPlanUserMessage(userText: string) {
    const normalizedUserText = userText.trim();
    if (!normalizedUserText) {
      return;
    }

    setPlanConversation((current) => [
      ...current,
      {
        id: createConversationId(),
        role: "user",
        text: normalizedUserText
      }
    ]);
  }

  function appendPlanAssistantMessage(plan: GeneratedTaskPlan) {
    const hasClarifications = plan.phases.length === 0 && (plan.verificationQuestions ?? []).length > 0;
    setPlanConversation((current) => [
      ...current,
      {
        id: createConversationId(),
        role: "assistant",
        text: hasClarifications
          ? `Need clarification before generating the plan. Please answer ${plan.verificationQuestions.length} question(s).`
          : `Generated ${plan.phases.length} phase(s), ${
              plan.phases.reduce((count, phase) => count + phase.sections.length, 0)
            } section(s).`,
        plan
      }
    ]);
  }

  function appendPlanAssistantCsvMessage(plan: GeneratedTaskPlan, fileName: string) {
    const sectionCount = plan.phases.reduce((count, phase) => count + phase.sections.length, 0);
    const taskCount = plan.phases.reduce(
      (count, phase) => count + phase.sections.reduce((sectionSum, section) => sectionSum + section.tasks.length, 0),
      0
    );

    setPlanConversation((current) => [
      ...current,
      {
        id: createConversationId(),
        role: "assistant",
        text: `Build from CSV loaded ${plan.phases.length} phase(s), ${sectionCount} section(s), ${taskCount} task(s) from ${fileName}.`,
        plan
      }
    ]);
  }

  function resetPlannerFlow(options?: { toIntro?: boolean }) {
    setPlanPrompt("");
    setPlanBasePrompt("");
    setGeneratedPlan(null);
    setPlanProvider(null);
    setPlanWarning("");
    setPlanError("");
    setShowBuildPlanConfirm(false);
    setVerificationChecks({});
    setPlanConversation([]);
    if (options?.toIntro) {
      setPlanIntroState("intro");
    }
    setPlanScrollTick((current) => current + 1);
  }

  function discardPlannerFlow() {
    const hasActiveFlow = Boolean(generatedPlan) || planConversation.length > 0 || planBasePrompt.trim().length > 0;
    if (!hasActiveFlow) {
      resetPlannerFlow({ toIntro: true });
      return;
    }

    const confirmed = window.confirm("Discard the current planning flow and start over?");
    if (!confirmed) {
      return;
    }

    resetPlannerFlow({ toIntro: true });
  }

  function openBuildFromCsvPicker() {
    planCsvInputRef.current?.click();
  }

  async function handleBuildFromCsvInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    setPlanError("");
    setPlanWarning("");
    setPlanPrompt("");
    setPlanIntroState("active");

    try {
      const csvText = await file.text();
      let csvPlan: GeneratedTaskPlan;

      try {
        csvPlan = buildGeneratedPlanFromCsv(csvText);
      } catch (primaryError) {
        const mapping = promptCsvColumnMapping(csvText);
        if (!mapping) {
          throw primaryError;
        }

        csvPlan = buildGeneratedPlanFromCsv(csvText, mapping);
      }

      applyGeneratedPlan(csvPlan, "csv");
      setPlanBasePrompt(`Build from CSV: ${file.name}`);
      appendPlanUserMessage(`Build from CSV: ${file.name}`);
      appendPlanAssistantCsvMessage(csvPlan, file.name);
      setPlanScrollTick((current) => current + 1);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Could not parse CSV file.");
    }
  }

  function resizePlanComposerTextarea(target?: HTMLTextAreaElement | null) {
    const textarea = target ?? composerTextareaRef.current;
    if (!textarea) {
      return;
    }

    const maxHeight = 750;
    const minHeight = 32;
    const compactThreshold = 56;

    textarea.style.height = "auto";
    const naturalHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    const isCompact = textarea.scrollHeight <= compactThreshold;
    const desiredHeight = isCompact ? minHeight : naturalHeight;
    textarea.style.height = `${desiredHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";

    const pillElement = textarea.closest(".plan-composer-pill") as HTMLElement | null;
    if (pillElement) {
      pillElement.dataset.composerSize = isCompact ? "compact" : "expanded";
      const interpolation = (desiredHeight - minHeight) / (maxHeight - minHeight);
      const clamped = Math.max(0, Math.min(1, interpolation));
      const dynamicRadius = Math.round(18 - clamped * 8);
      pillElement.style.setProperty("--plan-composer-radius", `${Math.max(10, dynamicRadius)}px`);
    }
  }

  function scrollPlanPreviewToBottom() {
    const previewScroll = planPreviewScrollRef.current;
    if (!previewScroll) {
      return;
    }

    previewScroll.scrollTop = previewScroll.scrollHeight;
  }

  const phaseWizardDatesValid =
    !phaseWizardDraft.plannedStartDate ||
    !phaseWizardDraft.plannedEndDate ||
    phaseWizardDraft.plannedStartDate <= phaseWizardDraft.plannedEndDate;

  const phaseWizardStepValid =
    (phaseWizardStep === 0 && phaseWizardDraft.title.trim().length > 0) ||
    (phaseWizardStep === 1 && phaseWizardDatesValid) ||
    phaseWizardStep === 2;

  const wizardProgressPercent = ((phaseWizardStep + 1) / phaseWizardSteps.length) * 100;
  const generatedPlanCounts = useMemo(() => {
    if (!generatedPlan) {
      return { phases: 0, sections: 0, tasks: 0 };
    }

    let sections = 0;
    let taskCount = 0;
    generatedPlan.phases.forEach((phase) => {
      sections += phase.sections.length;
      phase.sections.forEach((section) => {
        taskCount += section.tasks.length;
      });
    });

    return { phases: generatedPlan.phases.length, sections, tasks: taskCount };
  }, [generatedPlan]);
  const allVerificationChecksPassed = useMemo(() => {
    const checks = Object.values(verificationChecks);
    if (checks.length === 0) {
      return true;
    }

    return checks.every(Boolean);
  }, [verificationChecks]);
  const hasBuildablePlan = Boolean(generatedPlan && generatedPlan.phases.length > 0);

  function getPhaseWbsRows(phase: GeneratedPlanPhase, phaseIndex: number) {
    const rows: Array<{
      key: string;
      wbsId: string;
      sectionName: string;
      taskName: string;
      predecessor: string;
      deliverable: string;
    }> = [];

    let taskCursor = 1;
    let previousWbs = `${Math.max(0, phaseIndex)}.0`;

    phase.sections.forEach((section, sectionIndex) => {
      section.tasks.forEach((task, taskIndex) => {
        const fallbackWbs = `${phaseIndex + 1}.${taskCursor}`;
        const normalizedWbs = task.wbsId?.trim() || fallbackWbs;
        const normalizedPredecessor = task.predecessor?.trim() || previousWbs;
        previousWbs = normalizedWbs;
        taskCursor += 1;

        rows.push({
          key: `${phase.title}-${section.title}-${task.title}-${sectionIndex}-${taskIndex}`,
          wbsId: normalizedWbs,
          sectionName: section.title,
          taskName: task.title,
          predecessor: normalizedPredecessor,
          deliverable: task.deliverable?.trim() || "Pending deliverable definition"
        });
      });
    });

    return rows;
  }

  function renderPlanAsWbsTables(plan: GeneratedTaskPlan, keyPrefix: string) {
    return (
      <div className="plan-wbs-phase-list">
        {plan.phases.map((phase, phaseIndex) => {
          const rows = getPhaseWbsRows(phase, phaseIndex);
          const phaseWbsId = phase.wbsId?.trim() || `${phaseIndex + 1}.0`;

          return (
            <article className="plan-wbs-phase" key={`${keyPrefix}-phase-${phaseWbsId}-${phaseIndex}`}>
              <h4 className="plan-wbs-phase-title">
                {phaseWbsId} {phase.title}
              </h4>
              {phase.description && (
                <p className="plan-wbs-phase-description">
                  <strong>Phase Description:</strong> {phase.description}
                </p>
              )}

              <div className="plan-wbs-table-wrap">
                <table className="plan-wbs-table">
                  <thead>
                    <tr>
                      <th>WBS ID</th>
                      <th>Section</th>
                      <th>Task Name</th>
                      <th>Predecessor</th>
                      <th>Deliverable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={5}>No tasks returned for this phase.</td>
                      </tr>
                    ) : (
                      rows.map((row) => (
                        <tr key={`${keyPrefix}-${row.key}`}>
                          <td>{row.wbsId}</td>
                          <td>{row.sectionName}</td>
                          <td>{row.taskName}</td>
                          <td>{row.predecessor}</td>
                          <td>{row.deliverable}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PLAN_BUILDER_STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as {
        showPlanBuilder?: boolean;
        planPrompt?: string;
        planBasePrompt?: string;
        generatedPlan?: GeneratedTaskPlan | null;
        planProvider?: PlanProvider | null;
        planWarning?: string;
        verificationChecks?: Record<string, boolean>;
        planConversation?: PlanConversationMessage[];
      };

      setShowPlanBuilder(Boolean(parsed.showPlanBuilder));
      setPlanPrompt(typeof parsed.planPrompt === "string" ? parsed.planPrompt : "");
      setPlanBasePrompt(typeof parsed.planBasePrompt === "string" ? parsed.planBasePrompt : "");
      setPlanProvider(
        parsed.planProvider === "openai" || parsed.planProvider === "fallback" || parsed.planProvider === "csv"
          ? parsed.planProvider
          : null
      );
      setPlanWarning(typeof parsed.planWarning === "string" ? parsed.planWarning : "");
      setPlanConversation(Array.isArray(parsed.planConversation) ? parsed.planConversation : []);

      if (parsed.generatedPlan && typeof parsed.generatedPlan === "object") {
        setGeneratedPlan(parsed.generatedPlan);
        const questions = parsed.generatedPlan.verificationQuestions ?? [];
        const restoredChecks = parsed.verificationChecks ?? {};
        setVerificationChecks(
          Object.fromEntries(questions.map((question) => [question, Boolean(restoredChecks[question])]))
        );
      } else {
        setGeneratedPlan(null);
        setVerificationChecks({});
      }
    } catch {
      setGeneratedPlan(null);
      setVerificationChecks({});
    } finally {
      setPlannerStateHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!plannerStateHydrated) {
      return;
    }

    const payload = {
      showPlanBuilder,
      planPrompt,
      planBasePrompt,
      generatedPlan,
      planProvider,
      planWarning,
      verificationChecks,
      planConversation
    };

    try {
      window.localStorage.setItem(PLAN_BUILDER_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota/runtime errors and continue without persistence.
    }
  }, [
    plannerStateHydrated,
    showPlanBuilder,
    planPrompt,
    planBasePrompt,
    generatedPlan,
    planProvider,
    planWarning,
    verificationChecks,
    planConversation
  ]);

  useEffect(
    () => () => {
      if (planIntroTimerRef.current !== null) {
        window.clearTimeout(planIntroTimerRef.current);
        planIntroTimerRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    resizePlanComposerTextarea();
  }, [planPrompt, showPlanBuilder]);

  useEffect(() => {
    resizeDrawerNotesTextarea();
  }, [drawerTaskId, drawerForm.description]);

  useEffect(() => {
    if (!showPlanBuilder) {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      scrollPlanPreviewToBottom();
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [showPlanBuilder, planConversation.length, generatingPlan, planScrollTick]);

  useEffect(() => {
    if (selectedPhaseId && phases.some((phase) => phase._id === selectedPhaseId)) {
      return;
    }

    setSelectedPhaseId(currentPhase?._id ?? phases[0]?._id ?? "");
  }, [currentPhase, phases, selectedPhaseId]);

  useEffect(() => {
    if (createMode !== "TASK") {
      return;
    }

    if (selectedSectionId && sections.some((section) => section._id === selectedSectionId)) {
      return;
    }

    setSelectedSectionId(sections[0]?._id ?? "");
  }, [createMode, sections, selectedSectionId]);

  useEffect(() => {
    const activePhaseId = activePhase?._id ?? "";
    const phaseChanged = previousActivePhaseIdRef.current !== activePhaseId;

    if (activeSections.length === 0) {
      previousActivePhaseIdRef.current = activePhaseId;
      if (selectedSectionId) {
        setSelectedSectionId("");
      }
      return;
    }

    const preferredSectionId = getPreferredSectionId(activeSections);
    const hasValidSelection = selectedSectionId && activeSections.some((section) => section._id === selectedSectionId);

    if (!phaseChanged && hasValidSelection) {
      previousActivePhaseIdRef.current = activePhaseId;
      return;
    }

    if (preferredSectionId && selectedSectionId !== preferredSectionId) {
      setSelectedSectionId(preferredSectionId);
    }

    previousActivePhaseIdRef.current = activePhaseId;
  }, [activePhase?._id, activeSections, selectedSectionId]);

  useEffect(() => {
    if (!focusTaskRequest) {
      return;
    }

    const targetTask = tasks.find((task) => task._id === focusTaskRequest.taskId && task.nodeType === "TASK");
    if (!targetTask) {
      return;
    }

    const sectionNode =
      tasks.find((task) => task._id === (targetTask.sectionTaskId ?? targetTask.parentTaskId) && task.nodeType === "SECTION") ?? null;
    const phaseNode =
      tasks.find((task) => task._id === (targetTask.phaseTaskId ?? sectionNode?.phaseTaskId ?? sectionNode?.parentTaskId) && task.nodeType === "PHASE") ??
      phases.find((phase) => phase.title === targetTask.phase) ??
      null;

    if (phaseNode?._id) {
      setSelectedPhaseId(phaseNode._id);
    }

    if (sectionNode?._id) {
      setSelectedSectionId(sectionNode._id);
    }

    openEditDrawer(targetTask);

    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        window.document.getElementById(`phase-task-${targetTask._id}`)?.scrollIntoView({
          behavior: "smooth",
          block: "center"
        });
      }, 50);
    }

    onTaskFocusHandled?.();
  }, [focusTaskRequest?.requestKey, onTaskFocusHandled, phases, tasks]);

  useEffect(() => {
    let ignore = false;

    async function loadWorkers() {
      try {
        const response = await api.getWorkers();
        if (ignore) {
          return;
        }

        setWorkers(response.workers.filter((worker) => worker.isActive));
      } catch {
        if (!ignore) {
          setWorkers([]);
        }
      }
    }

    loadWorkers().catch(() => {
      setWorkers([]);
    });

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (showPlanBuilder) {
          closePlanBuilder();
          return;
        }

        if (showPhaseWizard) {
          closePhaseWizard();
          return;
        }

        if (showCreateWidget) {
          closeCreateWidget();
          return;
        }

        if (drawerTaskId) {
          setDrawerTaskId(null);
          setDrawerForm({});
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerTaskId, showCreateWidget, showPhaseWizard, showPlanBuilder]);

  useEffect(() => {
    onRegisterCreateLauncher?.(() => {
      if (phases.length === 0) {
        openPhaseWizard();
        return;
      }

      setDuplicateSourceTaskId(null);
      setDraft(defaultDraft);
      setShowCreateWidget(true);
    });
    return () => onRegisterCreateLauncher?.(null);
  }, [onRegisterCreateLauncher, phases.length]);

  useEffect(() => {
    if (!activePhase || !phaseSummaryRef.current) {
      return;
    }

    const summaryElement = phaseSummaryRef.current;
    let animationFrameId = 0;

    const fitTitleWithinTwoLines = () => {
      const titleElement = summaryElement.querySelector(".phase-summary-title");
      if (!(titleElement instanceof HTMLElement)) {
        return;
      }

      titleElement.style.removeProperty("font-size");
      titleElement.style.removeProperty("line-height");

      const titleWidth = titleElement.clientWidth;
      if (titleWidth <= 0) {
        return;
      }

      const titleStyle = window.getComputedStyle(titleElement);
      const parsedLineHeight = Number.parseFloat(titleStyle.lineHeight);
      const parsedFontSize = Number.parseFloat(titleStyle.fontSize);
      const lineHeight = Number.isFinite(parsedLineHeight)
        ? parsedLineHeight
        : Number.isFinite(parsedFontSize)
          ? parsedFontSize * 1.08
          : 20;
      const lineHeightRatio = Number.isFinite(parsedFontSize) && parsedFontSize > 0
        ? lineHeight / parsedFontSize
        : 1.08;
      const maxFontSizePx = Number.isFinite(parsedFontSize) ? parsedFontSize : 26;
      const minFontSizePx = Math.max(12, maxFontSizePx * 0.6);

      const measureLineCount = (fontSizePx: number) => {
        const probe = titleElement.cloneNode(true);
        if (!(probe instanceof HTMLElement)) {
          return 2;
        }

        probe.style.position = "fixed";
        probe.style.left = "-9999px";
        probe.style.top = "0";
        probe.style.visibility = "hidden";
        probe.style.pointerEvents = "none";
        probe.style.width = `${titleWidth}px`;
        probe.style.height = "auto";
        probe.style.maxHeight = "none";
        probe.style.display = "block";
        probe.style.overflow = "visible";
        probe.style.whiteSpace = "normal";
        probe.style.fontSize = `${fontSizePx}px`;
        probe.style.lineHeight = `${fontSizePx * lineHeightRatio}px`;
        probe.style.setProperty("-webkit-line-clamp", "unset");
        probe.style.setProperty("-webkit-box-orient", "initial");
        probe.style.removeProperty("text-overflow");

        document.body.appendChild(probe);
        const measuredHeight = probe.getBoundingClientRect().height;
        document.body.removeChild(probe);

        const measuredLineHeight = fontSizePx * lineHeightRatio || lineHeight;
        return Math.max(1, Math.ceil(measuredHeight / measuredLineHeight));
      };

      if (measureLineCount(maxFontSizePx) <= 2) {
        return;
      }

      let low = minFontSizePx;
      let high = maxFontSizePx;
      let best = minFontSizePx;

      for (let index = 0; index < 10; index += 1) {
        const mid = (low + high) / 2;
        if (measureLineCount(mid) <= 2) {
          best = mid;
          low = mid;
        } else {
          high = mid;
        }
      }

      titleElement.style.fontSize = `${best.toFixed(2)}px`;
      titleElement.style.lineHeight = `${(best * lineHeightRatio).toFixed(2)}px`;
    };

    const scheduleFit = () => {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = window.requestAnimationFrame(fitTitleWithinTwoLines);
    };

    scheduleFit();
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(summaryElement);
    window.addEventListener("resize", scheduleFit);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      observer.disconnect();
      window.removeEventListener("resize", scheduleFit);
      const titleElement = summaryElement.querySelector(".phase-summary-title");
      if (titleElement instanceof HTMLElement) {
        titleElement.style.removeProperty("font-size");
        titleElement.style.removeProperty("line-height");
      }
    };
  }, [
    activePhase?._id,
    activePhase?.title
  ]);

  useEffect(() => {
    if (!quickStatusMenuTaskId) {
      return;
    }

    function onDocumentPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".phase-task-status-menu-wrap")) {
        return;
      }

      setQuickStatusMenuTaskId(null);
    }

    document.addEventListener("mousedown", onDocumentPointerDown);
    return () => document.removeEventListener("mousedown", onDocumentPointerDown);
  }, [quickStatusMenuTaskId]);

  useEffect(() => {
    if (!workerPickerNodeId) {
      return;
    }

    function onDocumentPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".phase-worker-picker-wrap")) {
        return;
      }

      setWorkerPickerNodeId(null);
    }

    document.addEventListener("mousedown", onDocumentPointerDown);
    return () => document.removeEventListener("mousedown", onDocumentPointerDown);
  }, [workerPickerNodeId]);

  useEffect(() => {
    if (!workerInfoChipKey) {
      return;
    }

    function onDocumentPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".phase-worker-chip-wrap")) {
        return;
      }

      setWorkerInfoChipKey(null);
    }

    document.addEventListener("mousedown", onDocumentPointerDown);
    return () => document.removeEventListener("mousedown", onDocumentPointerDown);
  }, [workerInfoChipKey]);

  useEffect(() => {
    loadEstimateGroups().catch(() => {
      // Error state handled inside loader.
    });
  }, []);

  useEffect(() => {
    setGroupingSectionId(null);
    setSelectedGroupedTaskIds([]);
    setShowEstimateGroupModal(false);
    setEstimateGroupDraft(defaultEstimateGroupDraft);
  }, [selectedSectionId, activePhase?._id]);

  useEffect(() => {
    if (!showEstimateManager) {
      return;
    }

    if (activeSectionEstimateGroups.length === 0) {
      setShowEstimateManager(false);
      setActiveEstimateGroupId(null);
      return;
    }

    if (!activeEstimateGroupId || !activeSectionEstimateGroups.some((group) => group._id === activeEstimateGroupId)) {
      setActiveEstimateGroupId(activeSectionEstimateGroups[0]?._id ?? null);
    }
  }, [activeEstimateGroupId, activeSectionEstimateGroups, showEstimateManager]);

  useEffect(() => {
    if (draggingTaskState) {
      return;
    }
    setTaskOrderPreview((current) => {
      let changed = false;
      const next = { ...current };

      Object.entries(current).forEach(([sectionId, previewTaskIds]) => {
        const liveTaskIds = tasks
          .filter((task) => task.nodeType === "TASK" && task.parentTaskId === sectionId)
          .map((task) => task._id);

        const queueEntry = reorderQueueRef.current[sectionId];
        const hasPendingSave = Boolean(queueEntry?.inFlight || queueEntry?.pendingTaskIds);

        if (!hasPendingSave && areTaskIdListsEqual(previewTaskIds, liveTaskIds)) {
          delete next[sectionId];
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [tasks, draggingTaskState]);

  useEffect(() => {
    if (!activeEstimateGroup) {
      setEstimateManagerName("");
      setEstimateManagerTotal("");
      setEstimateManagerCurrency("USD");
      setEstimateManagerAllocations({});
      setEstimatePaymentAmount("");
      return;
    }

    setEstimateManagerName(activeEstimateGroup.name);
    setEstimateManagerTotal(formatEstimateInput(activeEstimateGroup.entryTotalAmount || activeEstimateGroup.totalAmount));
    setEstimateManagerCurrency(normalizeEstimateGroupCurrency(activeEstimateGroup.entryCurrency));
    setEstimateManagerAllocations(
      Object.fromEntries(
        activeEstimateGroup.taskIds.map((taskId) => {
          const task = tasks.find((entry) => entry._id === taskId);
          return [taskId, formatEstimateInput(task?.estimateAmount ?? 0)];
        })
      )
    );
    setEstimatePaymentAmount("");
  }, [activeEstimateGroup, tasks]);

  useEffect(() => {
    const shouldLoadFx =
      (showEstimateGroupModal && isEstimateGroupJmd(estimateGroupDraft.currency)) ||
      (showEstimateManager && estimateManagerShowsJmd);

    if (!shouldLoadFx) {
      setEstimateGroupFxQuote(null);
      setEstimateGroupFxError("");
      setLoadingEstimateGroupFxQuote(false);
      return;
    }

    let cancelled = false;
    setLoadingEstimateGroupFxQuote(true);
    setEstimateGroupFxError("");

    api
      .getProjectFxRate("USD")
      .then((response) => {
        if (!cancelled) {
          setEstimateGroupFxQuote(response.quote);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setEstimateGroupFxQuote(null);
          setEstimateGroupFxError(error instanceof Error ? error.message : "Could not load JMD rate");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingEstimateGroupFxQuote(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [estimateGroupDraft.currency, estimateManagerShowsJmd, showEstimateGroupModal, showEstimateManager]);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);

    try {
      const estimateAmount = parseEstimateInput(draft.estimateAmount);
      const payload: TaskInput = {
        title: draft.title,
        description: draft.description,
        owner: draft.owner,
        dueDate: draft.dueDate || undefined,
        priority: draft.priority,
        estimateAmount,
        nodeType: createMode,
        parentTaskId: createMode === "SECTION" ? selectedPhaseId || undefined : selectedSectionId || undefined
      };

      await onCreateTask(payload);
      closeCreateWidget();
    } finally {
      setSaving(false);
    }
  }

  async function handlePhaseWizardSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (phaseWizardStep < phaseWizardSteps.length - 1) {
      if (phaseWizardStepValid) {
        setPhaseWizardStep((current) => Math.min(current + 1, phaseWizardSteps.length - 1));
      }
      return;
    }

    setSavingPhaseWizard(true);
    try {
      await onCreateTask({
        title: phaseWizardDraft.title.trim(),
        description: phaseWizardDraft.description,
        owner: phaseWizardDraft.owner,
        status: phaseWizardDraft.status,
        priority: phaseWizardDraft.priority,
        plannedStartDate: phaseWizardDraft.plannedStartDate || undefined,
        plannedEndDate: phaseWizardDraft.plannedEndDate || undefined,
        dueDate: phaseWizardDraft.dueDate || undefined,
        estimateAmount: parseEstimateInput(phaseWizardDraft.estimateAmount),
        nodeType: "PHASE"
      });
      setPhaseWizardDraft(defaultPhaseWizardDraft);
      closePhaseWizard();
    } finally {
      setSavingPhaseWizard(false);
    }
  }

  async function handleGeneratePlanFromScope(scopePrompt: string) {
    const boundedScopePrompt = trimTextWithNotice(scopePrompt, PLAN_PROMPT_MAX_CHARS);

    setGeneratingPlan(true);
    setPlanError("");
    setPlanWarning("");
    try {
      const response = await api.generateTaskPlan({
        prompt: boundedScopePrompt,
        maxPhases: 8
      });
      applyGeneratedPlan(response.plan, response.provider, response.warning);
      appendPlanAssistantMessage(response.plan);
      setPlanBasePrompt(boundedScopePrompt);
    } catch (error) {
      setGeneratedPlan(null);
      setPlanProvider(null);
      setVerificationChecks({});
      setPlanError(error instanceof Error ? error.message : "Could not generate a plan right now.");
    } finally {
      setGeneratingPlan(false);
    }
  }

  async function handleRegeneratePlanFromInput(userRevision: string) {
    if (!generatedPlan) {
      return;
    }

    setGeneratingPlan(true);
    setPlanError("");
    try {
      const revisionPrompt = buildBoundedRevisionPrompt(planBasePrompt.trim(), userRevision, generatedPlan);

      const response = await api.generateTaskPlan({
        prompt: revisionPrompt,
        maxPhases: Math.max(1, generatedPlan.phases.length || 8)
      });
      applyGeneratedPlan(response.plan, response.provider, response.warning);
      appendPlanAssistantMessage(response.plan);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Could not apply revisions right now.");
    } finally {
      setGeneratingPlan(false);
    }
  }

  async function handlePlanComposerSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedPrompt = planPrompt.trim();
    const minLength = generatedPlan ? 3 : 10;
    if (trimmedPrompt.length < minLength) {
      setPlanError(
        generatedPlan
          ? "Add clarification or revision text (at least 3 characters), then apply."
          : "Give more detail so the planner can generate meaningful phases."
      );
      return;
    }

    setPlanError("");
    setPlanPrompt("");
    appendPlanUserMessage(trimmedPrompt);
    setPlanScrollTick((current) => current + 1);

    if (generatedPlan) {
      await handleRegeneratePlanFromInput(trimmedPrompt);
      return;
    }

    await handleGeneratePlanFromScope(trimmedPrompt);
  }

  function handleBuildGeneratedPlan() {
    if (!generatedPlan) {
      return;
    }

    const verificationRequired = (generatedPlan.verificationQuestions ?? []).length > 0;
    if (verificationRequired && !allVerificationChecksPassed) {
      setPlanError("Complete all verification checks before building.");
      return;
    }

    setPlanError("");
    setShowBuildPlanConfirm(true);
  }

  function resizeDrawerNotesTextarea(target?: HTMLTextAreaElement | null) {
    const textarea = target ?? drawerNotesTextareaRef.current;
    if (!textarea) {
      return;
    }

    const minHeight = 136;
    const maxHeight = 300;

    textarea.style.height = "auto";
    const nextHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  async function confirmBuildGeneratedPlan() {
    if (!generatedPlan) {
      setShowBuildPlanConfirm(false);
      return;
    }

    setBuildingPlan(true);
    setPlanError("");
    try {
      await api.buildTaskPlan({ plan: generatedPlan });
      await onRefreshData?.();
      setShowPlanBuilder(false);
      setGeneratedPlan(null);
      setPlanWarning("");
      setPlanProvider(null);
      setPlanPrompt("");
      setPlanBasePrompt("");
      setShowBuildPlanConfirm(false);
      setVerificationChecks({});
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Could not build plan right now.");
    } finally {
      setBuildingPlan(false);
      setShowBuildPlanConfirm(false);
    }
  }

  function openEditDrawer(task: Task) {
    setDrawerTaskId(task._id);
    setDrawerForm({
      title: task.title,
      description: task.description,
      parentTaskId: task.parentTaskId,
      owner: task.owner,
      status: task.status,
      priority: task.priority,
      estimateAmount: task.estimateAmount,
      dueDate: toDateInputValue(task.dueDate),
      plannedStartDate: toDateInputValue(task.plannedStartDate),
      plannedEndDate: toDateInputValue(task.plannedEndDate),
      actualStartDate: toDateInputValue(task.actualStartDate),
      actualEndDate: toDateInputValue(task.actualEndDate)
    });
    setDrawerEstimateInput(formatEstimateInput(task.estimateAmount));
  }

  async function saveDrawerEdit() {
    if (!drawerTaskId) {
      return;
    }

    setSavingDrawer(true);
      try {
        await onUpdateTask(drawerTaskId, drawerForm);
        setDrawerTaskId(null);
        setDrawerForm({});
        setDrawerEstimateInput("");
      } finally {
        setSavingDrawer(false);
      }
  }

  async function closeNode(task: Task) {
    await onUpdateTask(task._id, { status: "DONE" });
  }

  async function reopenNode(task: Task) {
    await onUpdateTask(task._id, { status: "PLANNED" });
  }

  async function handleQuickToggleComplete(task: Task) {
    const nextStatus: TaskStatus = task.status === "DONE" ? "PLANNED" : "DONE";
    setQuickTaskActionId(task._id);
    setQuickStatusMenuTaskId(null);
    try {
      await onUpdateTask(task._id, { status: nextStatus });
    } finally {
      setQuickTaskActionId(null);
    }
  }

  async function handleQuickStatusChange(task: Task, status: TaskStatus) {
    if (task.status === status) {
      setQuickStatusMenuTaskId(null);
      return;
    }

    setQuickTaskActionId(task._id);
    setQuickStatusMenuTaskId(null);
    try {
      await onUpdateTask(task._id, { status });
    } finally {
      setQuickTaskActionId(null);
    }
  }

  function toggleQuickStatusMenu(taskId: string) {
    setQuickStatusMenuTaskId((current) => (current === taskId ? null : taskId));
  }

  function toggleWorkerPicker(nodeId: string) {
    setWorkerPickerNodeId((current) => (current === nodeId ? null : nodeId));
    setWorkerPickerQuery("");
    setWorkerInfoChipKey(null);
  }

  async function handleQuickToggleWorker(task: Task, workerName: string) {
    const currentWorkers =
      Array.isArray(task.resources) && task.resources.length > 0 ? task.resources : parseOwnerWorkers(task.owner);
    const target = workerName.trim();
    if (!target) {
      return;
    }

    const normalizedTarget = target.toLowerCase();
    const hasWorker = currentWorkers.some((name) => name.toLowerCase() === normalizedTarget);
    const nextWorkers = hasWorker
      ? currentWorkers.filter((name) => name.toLowerCase() !== normalizedTarget)
      : [...currentWorkers, target];
    const nextOwnerValue = serializeOwnerWorkers(nextWorkers);

    if (nextOwnerValue === task.owner) {
      return;
    }

    setQuickWorkerActionId(task._id);
    try {
      await onUpdateTask(task._id, { owner: nextOwnerValue });
    } finally {
      setQuickWorkerActionId(null);
    }
  }

  async function handleQuickClearWorkers(task: Task) {
    if (!task.owner.trim()) {
      return;
    }

    setQuickWorkerActionId(task._id);
    try {
      await onUpdateTask(task._id, { owner: "" });
    } finally {
      setQuickWorkerActionId(null);
    }
  }

  async function refreshTasksAndEstimateGroups() {
    await onRefreshData?.();
    await loadEstimateGroups();
  }

  function getOrderedSectionTasks(sectionId: string, sectionTasks: Task[]): Task[] {
    const previewTaskIds = taskOrderPreview[sectionId];
    if (!previewTaskIds || previewTaskIds.length === 0) {
      return sectionTasks;
    }

    const taskById = new Map(sectionTasks.map((task) => [task._id, task]));
    const orderedTasks = previewTaskIds
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is Task => Boolean(task));

    if (orderedTasks.length !== sectionTasks.length) {
      return sectionTasks;
    }

    return orderedTasks;
  }

  function handleTaskDragStart(sectionId: string, sectionTasks: Task[], taskId: string, event: DragEvent<HTMLButtonElement>) {
    taskDragDroppedRef.current = false;
    setDraggingTaskState({ taskId, sectionId });
    setTaskOrderPreview((current) => ({
      ...current,
      [sectionId]: current[sectionId]?.length ? current[sectionId] : sectionTasks.map((task) => task._id)
    }));
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", taskId);
  }

  function handleTaskDragOver(
    sectionId: string,
    sectionTasks: Task[],
    targetTaskId: string,
    event: DragEvent<HTMLElement>
  ) {
    if (!draggingTaskState || draggingTaskState.sectionId !== sectionId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const currentTaskIds = taskOrderPreview[sectionId] ?? sectionTasks.map((task) => task._id);
    const targetRect = event.currentTarget.getBoundingClientRect();
    const placeAfter = event.clientY >= targetRect.top + targetRect.height / 2;
    const nextTaskIds = moveTaskIdWithinList(currentTaskIds, draggingTaskState.taskId, targetTaskId, placeAfter);

    if (areTaskIdListsEqual(currentTaskIds, nextTaskIds)) {
      return;
    }

    setTaskOrderPreview((current) => ({
      ...current,
      [sectionId]: nextTaskIds
    }));
  }

  function queueTaskReorderPersist(sectionId: string, orderedTaskIds: string[]) {
    const currentTaskIds = tasks
      .filter((task) => task.nodeType === "TASK" && task.parentTaskId === sectionId)
      .map((task) => task._id);

    if (areTaskIdListsEqual(orderedTaskIds, currentTaskIds)) {
      return;
    }

    const queueEntry = reorderQueueRef.current[sectionId] ?? { inFlight: false, pendingTaskIds: undefined };
    queueEntry.pendingTaskIds = orderedTaskIds;
    reorderQueueRef.current[sectionId] = queueEntry;

    if (queueEntry.inFlight) {
      return;
    }

    const flushQueue = async () => {
      const activeEntry = reorderQueueRef.current[sectionId];
      if (!activeEntry?.pendingTaskIds) {
        return;
      }

      activeEntry.inFlight = true;
      const taskIdsToPersist = [...activeEntry.pendingTaskIds];
      activeEntry.pendingTaskIds = undefined;

      try {
        await api.reorderTasks({
          sectionTaskId: sectionId,
          taskIds: taskIdsToPersist
        });
        void onRefreshData?.();
      } catch (error) {
        console.error("Could not reorder tasks", error);
        setTaskOrderPreview((current) => {
          const next = { ...current };
          delete next[sectionId];
          return next;
        });
      } finally {
        const latestEntry = reorderQueueRef.current[sectionId];
        if (!latestEntry) {
          return;
        }

        latestEntry.inFlight = false;

        if (latestEntry.pendingTaskIds && !areTaskIdListsEqual(latestEntry.pendingTaskIds, taskIdsToPersist)) {
          void flushQueue();
          return;
        }

        if (!latestEntry.pendingTaskIds) {
          delete reorderQueueRef.current[sectionId];
        }
      }
    };

    void flushQueue();
  }

  function handleTaskDrop(sectionId: string, orderedTasks: Task[], event: DragEvent<HTMLElement>) {
    if (!draggingTaskState || draggingTaskState.sectionId !== sectionId) {
      return;
    }

    event.preventDefault();
    taskDragDroppedRef.current = true;
    queueTaskReorderPersist(
      sectionId,
      orderedTasks.map((task) => task._id)
    );
    setDraggingTaskState(null);
  }

  function handleTaskDragEnd(sectionId: string) {
    window.setTimeout(() => {
      if (taskDragDroppedRef.current) {
        return;
      }

      setDraggingTaskState((current) => (current?.sectionId === sectionId ? null : current));
      setTaskOrderPreview((current) => {
        const next = { ...current };
        delete next[sectionId];
        return next;
      });
      taskDragDroppedRef.current = false;
    }, 0);
  }

  async function handleCreateEstimateGroup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!groupingSectionId || selectedGroupedTaskIds.length < 2) {
      return;
    }

    if (isEstimateGroupJmd(estimateGroupDraft.currency) && !estimateGroupFxQuote) {
      setEstimateGroupsError(estimateGroupFxError || "Could not load the current JMD rate.");
      return;
    }

    setSavingEstimateGroup(true);
    try {
      setEstimateGroupsError("");
      const totalAmount = parseEstimateInput(estimateGroupDraft.totalAmount);
      const response = await api.createEstimateGroup({
        name: estimateGroupDraft.name.trim(),
        totalAmount,
        currency: normalizeEstimateGroupCurrency(estimateGroupDraft.currency),
        taskIds: selectedGroupedTaskIds
      });
      await refreshTasksAndEstimateGroups();
      resetTaskGroupingSelection();
      setActiveEstimateGroupId(response.estimateGroup._id);
      setSelectedSectionId(response.estimateGroup.sectionTaskId);
      setShowEstimateManager(true);
    } catch (error) {
      setEstimateGroupsError(error instanceof Error ? error.message : "Could not create grouped estimate.");
    } finally {
      setSavingEstimateGroup(false);
    }
  }

  async function handleSaveEstimateGroup() {
    if (!activeEstimateGroup) {
      return;
    }

    if (estimateManagerShowsJmd && !estimateGroupFxQuote) {
      setEstimateGroupsError(estimateGroupFxError || "Could not load the current JMD rate.");
      return;
    }

    setSavingEstimateManager(true);
    try {
      setEstimateGroupsError("");
      await api.updateEstimateGroup(activeEstimateGroup._id, {
        name: estimateManagerName.trim(),
        totalAmount: parseEstimateInput(estimateManagerTotal),
        currency: normalizeEstimateGroupCurrency(estimateManagerCurrency),
        taskAllocations: activeEstimateGroup.taskIds.map((taskId) => ({
          taskId,
          estimateAmount: parseEstimateInput(estimateManagerAllocations[taskId] ?? "")
        }))
      });
      await refreshTasksAndEstimateGroups();
    } catch (error) {
      setEstimateGroupsError(error instanceof Error ? error.message : "Could not save grouped estimate.");
    } finally {
      setSavingEstimateManager(false);
    }
  }

  async function handleRecordEstimateGroupPayment() {
    if (!activeEstimateGroup) {
      return;
    }

    const paymentAmount = parseEstimateInput(estimatePaymentAmount);
    if (paymentAmount <= 0) {
      return;
    }

    setSavingEstimateGroupPayment(true);
    try {
      setEstimateGroupsError("");
      await api.updateEstimateGroup(activeEstimateGroup._id, {
        recordPayment: {
          amount: paymentAmount
        }
      });
      await refreshTasksAndEstimateGroups();
      setEstimatePaymentAmount("");
    } catch (error) {
      setEstimateGroupsError(error instanceof Error ? error.message : "Could not record grouped payment.");
    } finally {
      setSavingEstimateGroupPayment(false);
    }
  }

  async function handleDissolveEstimateGroup() {
    if (!activeEstimateGroup) {
      return;
    }

    setDissolvingEstimateGroup(true);
    try {
      setEstimateGroupsError("");
      const deletedGroupId = activeEstimateGroup._id;
      const nextGroupId =
        activeSectionEstimateGroups.find((group) => group._id !== deletedGroupId)?._id ?? null;
      await api.deleteEstimateGroup(deletedGroupId);
      await refreshTasksAndEstimateGroups();
      setShowDissolveEstimateGroupConfirm(false);
      if (nextGroupId) {
        setActiveEstimateGroupId(nextGroupId);
      } else {
        setActiveEstimateGroupId(null);
        setShowEstimateManager(false);
      }
    } catch (error) {
      setEstimateGroupsError(error instanceof Error ? error.message : "Could not dissolve grouped estimate.");
    } finally {
      setDissolvingEstimateGroup(false);
    }
  }

  function renderWorkerPickerMenu(task: Task, disabled: boolean) {
    const selectedOwners =
      Array.isArray(task.resources) && task.resources.length > 0 ? task.resources : parseOwnerWorkers(task.owner);
    const selectedLookup = new Set(selectedOwners.map((name) => name.toLowerCase()));

    return (
      <div className="phase-worker-picker-menu" role="menu" aria-label="Assign worker">
        <div className="phase-worker-picker-search">
          <input
            type="text"
            placeholder="Search workers..."
            value={workerPickerQuery}
            onChange={(event) => setWorkerPickerQuery(event.target.value)}
            disabled={disabled}
            autoFocus
          />
        </div>
        <div className="phase-worker-picker-toolbar">
          <span className="muted small-text">
            {selectedOwners.length} selected
          </span>
          <button
            className="phase-worker-picker-clear"
            type="button"
            onClick={() => {
              handleQuickClearWorkers(task).catch(() => {
                // keep picker responsive even if clear action fails
              });
            }}
            disabled={disabled || selectedOwners.length === 0}
          >
            Clear
          </button>
        </div>
        <div className="phase-worker-picker-list">
          {workerPickerResults.length === 0 ? (
            <p className="phase-worker-picker-empty muted">No matching workers.</p>
          ) : (
            workerPickerResults.map((worker) => (
              <button
                key={worker._id}
                className={`phase-worker-picker-option ${selectedLookup.has(worker.name.toLowerCase()) ? "active" : ""}`}
                type="button"
                role="menuitem"
                onClick={() => {
                  handleQuickToggleWorker(task, worker.name).catch(() => {
                    // keep picker responsive even if assignment fails
                  });
                }}
                disabled={disabled}
              >
                <span className="phase-worker-picker-check" aria-hidden="true">
                  {selectedLookup.has(worker.name.toLowerCase()) ? "✓" : ""}
                </span>
                <span className="phase-worker-picker-name">{worker.name}</span>
                <span className="muted small-text">{worker.role.replace(/_/g, " ")}</span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  async function handleClearAllPhasesClick() {
    if (!canDeleteTask || !onClearAllPhases || phases.length === 0) {
      return;
    }

    const confirmed = window.confirm(`Delete all ${phases.length} phase(s) and all nested sections/tasks?`);
    if (!confirmed) {
      return;
    }

    setClearingAllPhases(true);
    try {
      await onClearAllPhases();
      setSelectedPhaseId("");
      setSelectedSectionId("");
    } finally {
      setClearingAllPhases(false);
    }
  }

  async function handleDrawerStatusToggle() {
    if (!activeDrawerTask) {
      return;
    }

    if (activeDrawerTask.status === "DONE") {
      await reopenNode(activeDrawerTask);
      return;
    }

    await closeNode(activeDrawerTask);
  }

  function focusCreateSection(phaseId: string) {
    setCreateMode("SECTION");
    setDuplicateSourceTaskId(null);
    setDraft(defaultDraft);
    setSelectedPhaseId(phaseId);
    setShowCreateWidget(true);
  }

  function focusCreateTask(phaseId: string, sectionId: string) {
    setCreateMode("TASK");
    setDuplicateSourceTaskId(null);
    setDraft(defaultDraft);
    setSelectedPhaseId(phaseId);
    setSelectedSectionId(sectionId);
    setShowCreateWidget(true);
  }

  function selectSection(sectionId: string) {
    setSelectedSectionId(sectionId);
    const sectionElement = window.document.getElementById(`phase-section-${sectionId}`);
    sectionElement?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function selectPhaseFromRail(phaseId: string) {
    const phaseSections = getSectionsForPhase(tasks, phaseId);
    const preferredSectionId = getPreferredSectionId(phaseSections);
    setSelectedPhaseId(phaseId);
    setSelectedSectionId(preferredSectionId);
    if (showPlanBuilder) {
      setShowPlanBuilder(false);
      setPlanError("");
    }
  }

  const canCreateSection = phases.length > 0 && Boolean(selectedPhaseId);
  const canCreateTask = sections.length > 0 && Boolean(selectedSectionId);
  const hasPlannerActivity =
    Boolean(generatedPlan) ||
    planConversation.length > 0 ||
    planBasePrompt.trim().length > 0 ||
    planPrompt.trim().length > 0;
  const shouldShowPlanConversation = planConversation.length > 0 || generatingPlan;
  const shouldShowPlanPreview = Boolean(generatedPlan) || shouldShowPlanConversation;
  const hasPendingClarifications =
    (generatedPlan?.phases.length ?? 0) === 0 &&
    (generatedPlan?.verificationQuestions?.length ?? 0) > 0;
  const showComposerLanding = !generatedPlan && planConversation.length === 0 && planIntroState !== "intro";
  const showPlanIntroSplash = !hasPlannerActivity && planIntroState !== "active";
  const showPlanBuilderWorkspace = hasPlannerActivity || planIntroState !== "intro";
  const visibleSections =
    selectedSectionId && activeSections.some((section) => section._id === selectedSectionId)
      ? activeSections.filter((section) => section._id === selectedSectionId)
      : activeSections;
  const milestoneBoard = (
    <section className="milestone-board-workspace">
      <section className="milestone-board-card" aria-label="Phase milestones">
        <div className="milestone-board-head">
          <div>
            <div className="milestone-board-title">Milestone Board</div>
            <p className="milestone-board-subtitle">
              Sections stay in project order. Tasks wrap as milestone bubbles and open in the existing task drawer.
            </p>
          </div>
          <div className="milestone-board-summary">
            <span>{activeSections.length} sections</span>
            <span>{activePhaseTasks.length} tasks</span>
          </div>
        </div>

        {activeSections.length === 0 ? (
          <div className="milestone-board-empty">No sections yet for this phase.</div>
        ) : (
          <div className="milestone-board-table" role="table" aria-label={`${activePhase?.title ?? "Phase"} milestone board`}>
            <div className="milestone-board-header" role="row">
              <span className="milestone-board-header-rank" role="columnheader">
                #
              </span>
              <span className="milestone-board-header-section" role="columnheader">
                Section
              </span>
              <span className="milestone-board-header-tasks" role="columnheader">
                Tasks
              </span>
            </div>

            <div className="milestone-board-body">
              {activeSections.map((section, index) => {
                const sectionTasks = tasks.filter((task) => task.nodeType === "TASK" && task.parentTaskId === section._id);
                const orderedSectionTasks = getOrderedSectionTasks(section._id, sectionTasks);
                const sectionTone = getSectionProgressTone(sectionTasks);

                return (
                  <div
                    key={section._id}
                    className={`milestone-board-row is-${sectionTone} ${selectedSectionId === section._id ? "selected" : ""}`}
                    role="row"
                  >
                    <button
                      type="button"
                      className="milestone-board-section-cell"
                      onClick={() => selectSection(section._id)}
                      title={`Focus ${section.title}`}
                    >
                      <span className="milestone-board-rank">{index + 1}</span>
                      <div className="milestone-board-section-copy">
                        <strong>{section.title}</strong>
                        <div className="milestone-board-section-meta">
                          <span className={`status-badge status-${section.status.toLowerCase()}`}>{getTaskStatusLabel(section.status)}</span>
                          <span>
                            {section.progress.completedTasks} / {section.progress.totalTasks} complete
                          </span>
                        </div>
                      </div>
                    </button>

                    <div className="milestone-board-task-cell" role="cell">
                      {orderedSectionTasks.length === 0 ? (
                        <span className="milestone-board-task-empty">No tasks yet.</span>
                      ) : (
                        orderedSectionTasks.map((task) => (
                          <button
                            key={task._id}
                            type="button"
                            className={`milestone-task-pill status-${task.status.toLowerCase()}`}
                            onClick={() => openEditDrawer(task)}
                            title={`${task.wbsId ?? "--"} ${task.title}`}
                          >
                            {task.wbsId ? <span className="milestone-task-pill-wbs">{task.wbsId}</span> : null}
                            <span className="milestone-task-pill-title">{task.title}</span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </section>
  );

  return (
    <section className="stack-lg task-planner-shell">
      <div className="task-planner-layout">
        <aside className="task-phase-rail task-phase-toc">
          <div className="row-between wrap">
            <h3>Phase Timeline</h3>
            <div className="task-phase-rail-tools">
              {canDeleteTask && (
                <button
                  className="project-management-icon-action"
                  type="button"
                  onClick={() => handleClearAllPhasesClick()}
                  title="Delete All Phases"
                  aria-label="Delete All Phases"
                  disabled={clearingAllPhases || phases.length === 0}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 6h18" />
                    <path d="M8 6V4h8v2" />
                    <path d="M19 6l-1 14H6L5 6" />
                    <path d="M10 11v6" />
                    <path d="M14 11v6" />
                  </svg>
                </button>
              )}
              <button
                className="project-management-icon-action"
                type="button"
                onClick={() => openPlanBuilder()}
                title="Generate Plan"
                aria-label="Generate Plan"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m12 3 1.5 3.5L17 8l-3.5 1.5L12 13l-1.5-3.5L7 8l3.5-1.5L12 3Z" />
                  <path d="M5 16h14" />
                  <path d="M7 20h10" />
                </svg>
              </button>
              <button
                className="project-management-icon-action"
                type="button"
                onClick={() => openPhaseWizard()}
                title="Add Phase"
                aria-label="Add Phase"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
              </button>
              <span className="pill">{phases.length}</span>
            </div>
          </div>

          {phases.length === 0 ? (
            <div className="stack-sm">
              <p className="muted">No phases available yet.</p>
              <button className="btn ghost" type="button" onClick={() => openPlanBuilder()}>
                Generate Plan
              </button>
              <button className="btn" type="button" onClick={() => openPhaseWizard()}>
                Start Phase Wizard
              </button>
            </div>
          ) : (
            <div className="task-phase-timeline">
              {phases.map((phase, index) => {
                const sectionCount = getSectionsForPhase(tasks, phase._id).length;
                const isSelected = phase._id === activePhase?._id;
                const isCurrent = phase._id === currentPhase?._id;
                const progressPercent = Math.max(0, Math.min(100, Math.round(phase.progress.percentComplete)));
                const progressTone =
                  progressPercent >= 100 ? "done" : progressPercent >= 50 ? "active" : progressPercent > 0 ? "started" : "planned";

                return (
                  <button
                    key={phase._id}
                    className={`task-phase-item ${isSelected ? "active" : ""} ${isCurrent ? "current" : ""}`}
                    type="button"
                    onClick={() => selectPhaseFromRail(phase._id)}
                  >
                    <div className="task-phase-item-top">
                      <span className="task-phase-seq">{`Phase ${index + 1}`}</span>
                              <span className={`status-badge phase-status-chip status-${phase.status.toLowerCase()}`}>{getTaskStatusLabel(phase.status)}</span>
                    </div>
                    <strong>{phase.title}</strong>
                    <div className="task-phase-item-meta">
                      <span className="phase-meta-chip phase-meta-chip-sections">{sectionCount} sections</span>
                      <span className={`phase-meta-chip phase-meta-chip-progress ${progressTone}`}>{progressPercent}% complete</span>
                    </div>
                    <ProgressMeter value={progressPercent} />
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        <div className={`task-tree-column task-phase-workspace ${showPlanBuilder ? "is-plan-mode" : ""}`}>
          {showPlanBuilder ? (
            <section className={`plan-builder-inline ${showPlanIntroSplash ? "has-intro-splash" : ""}`}>
              {showPlanIntroSplash && (
                <div className={`plan-builder-intro ${planIntroState === "transitioning" ? "is-leaving" : ""}`}>
                  <BuildFlowWordmark variant="dark" className="plan-builder-intro-wordmark" />
                  <button className="btn plan-builder-start-btn" type="button" onClick={() => startPlanningSession()}>
                    Start Planning
                  </button>
                </div>
              )}

              <div
                className={`plan-builder-workspace ${showPlanBuilderWorkspace ? "is-visible" : "is-hidden"} ${
                  showComposerLanding ? "composer-landing" : ""
                }`}
              >
                {planError && <p className="error-text">{planError}</p>}
                {planWarning && <p className="muted">{planWarning}</p>}

                <div className={`plan-builder-main ${generatedPlan ? "has-assumptions" : ""}`}>
                  <div className={`plan-main-left ${showComposerLanding ? "is-composer-landing" : ""}`}>
                    {shouldShowPlanPreview ? (
                      <section className="plan-preview-shell">
                        <div className="plan-preview-scroll" ref={planPreviewScrollRef}>
                          {shouldShowPlanConversation ? (
                            <div className="plan-chat-thread">
                              {planConversation.map((message) => (
                                <article key={message.id} className={`plan-chat-message ${message.role}`}>
                                  <div className="plan-chat-message-head">
                                    <strong>{message.role === "user" ? "You" : "Planner"}</strong>
                                  </div>
                                  <p>{message.text}</p>

                                  {message.role === "assistant" && message.plan && (
                                    <>
                                      {message.plan.phases.length === 0 ? (
                                        <article className="plan-response-empty plan-clarification-block">
                                          <strong>Clarification needed before plan generation.</strong>
                                          {(message.plan.verificationQuestions ?? []).length > 0 ? (
                                            <ol className="plan-clarification-list">
                                              {(message.plan.verificationQuestions ?? []).map((question, index) => (
                                                <li key={`${message.id}-clarification-${index}`}>{question}</li>
                                              ))}
                                            </ol>
                                          ) : (
                                            <p className="muted">No clarification questions were returned.</p>
                                          )}
                                        </article>
                                      ) : (
                                        renderPlanAsWbsTables(message.plan, message.id)
                                      )}
                                    </>
                                  )}
                                </article>
                              ))}

                              {generatingPlan && (
                                <article className="plan-chat-message assistant pending">
                                  <div className="plan-chat-message-head">
                                    <strong>Planner</strong>
                                  </div>
                                  <div className="plan-loader" role="status" aria-live="polite" aria-label="Generating construction plan">
                                    <div className="plan-loader-track" aria-hidden="true">
                                      <span className="plan-loader-stage stage-blueprint">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                                          <rect x="4" y="4" width="16" height="16" rx="2" />
                                          <path d="M8 9h8" />
                                          <path d="M8 13h5" />
                                          <path d="M8 17h3" />
                                        </svg>
                                      </span>
                                      <span className="plan-loader-stage stage-build">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                                          <path d="M4 15h16" />
                                          <path d="M9 15V7h6v8" />
                                          <path d="M7 9h10" />
                                          <path d="M12 7V4" />
                                        </svg>
                                      </span>
                                      <span className="plan-loader-stage stage-complete">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                                          <path d="M3 12 12 5l9 7" />
                                          <path d="M6 10.5V20h12v-9.5" />
                                          <path d="m9.5 13 2 2 3-3.5" />
                                        </svg>
                                      </span>
                                      <span className="plan-loader-sweep" />
                                    </div>
                                    <p className="plan-loader-copy">Drafting phases and sections</p>
                                  </div>
                                </article>
                              )}
                            </div>
                          ) : generatedPlan && generatedPlan.phases.length === 0 ? (
                            <article className="plan-response-empty plan-clarification-block">
                              <strong>Clarification needed before plan generation.</strong>
                              {(generatedPlan.verificationQuestions ?? []).length > 0 ? (
                                <ol className="plan-clarification-list">
                                  {(generatedPlan.verificationQuestions ?? []).map((question, index) => (
                                    <li key={`current-clarification-${index}`}>{question}</li>
                                  ))}
                                </ol>
                              ) : (
                                <p className="muted">Add more details so the planner can generate phases.</p>
                              )}
                            </article>
                          ) : generatedPlan ? (
                            renderPlanAsWbsTables(generatedPlan, "current-plan")
                          ) : null}
                        </div>
                      </section>
                    ) : (
                      <section className="plan-preview-shell">
                        <article className="plan-response-empty plan-response-guidance">
                          <strong>Describe your build scope to generate a full phase plan.</strong>
                          <p className="muted">
                            Include phases, sections, expected sequencing, and any critical materials or constraints. You can also use Build
                            from CSV.
                          </p>
                        </article>
                      </section>
                    )}

                    <form
                      className="task-create-form-grid plan-builder-form plan-builder-composer"
                      onSubmit={handlePlanComposerSubmit}
                      ref={composerFormRef}
                    >
                      <input
                        ref={planCsvInputRef}
                        type="file"
                        accept=".csv,text/csv"
                        onChange={handleBuildFromCsvInputChange}
                        style={{ display: "none" }}
                      />
                      <div className="task-create-wide plan-composer-input-row">
                        <div className="plan-composer-pill">
                          <label className="plan-composer-prompt-label">
                            <textarea
                              ref={composerTextareaRef}
                              rows={1}
                              aria-label={generatedPlan ? "Clarifications or revisions" : "Describe your build scope"}
                              placeholder={
                                hasPendingClarifications
                                  ? "Answer the clarification questions above..."
                                  : generatedPlan
                                  ? "Add clarifications or revisions..."
                                  : "Ask anything about your build scope..."
                              }
                              value={planPrompt}
                              disabled={generatingPlan || buildingPlan}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
                                  return;
                                }

                                event.preventDefault();
                                composerFormRef.current?.requestSubmit();
                              }}
                              onChange={(event) => {
                                setPlanPrompt(event.target.value);
                                resizePlanComposerTextarea(event.currentTarget);
                              }}
                            />
                          </label>
                          <div className="plan-composer-action-stack">
                            <button
                              className="plan-composer-icon-btn csv"
                              type="button"
                              title="Build from CSV"
                              aria-label="Build from CSV"
                              onClick={() => openBuildFromCsvPicker()}
                              disabled={generatingPlan || buildingPlan}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                                <path d="M14 3v6h6" />
                                <path d="M12 11v7" />
                                <path d="m9.5 15.5 2.5 2.5 2.5-2.5" />
                              </svg>
                            </button>
                            <button
                              className="plan-composer-icon-btn clear"
                              type="button"
                              title="Clear Planner"
                              aria-label="Clear Planner"
                              onClick={() => resetPlannerFlow()}
                              disabled={generatingPlan || buildingPlan}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M18 6 6 18" />
                                <path d="m6 6 12 12" />
                              </svg>
                            </button>
                            <button
                              className="plan-composer-icon-btn plan-composer-submit-btn"
                              type="submit"
                              title={generatedPlan ? "Apply Revision" : "Generate Plan"}
                              aria-label={generatedPlan ? "Apply Revision" : "Generate Plan"}
                              disabled={generatingPlan || buildingPlan}
                            >
                              {generatingPlan ? (
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth={2}
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <path d="M21 12a9 9 0 1 1-9-9" />
                                  <path d="M12 3v4" />
                                </svg>
                              ) : generatedPlan ? (
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth={2}
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <path d="M21 2v6h-6" />
                                  <path d="M3 12a9 9 0 0 1 15-6l3 2" />
                                  <path d="M3 22v-6h6" />
                                  <path d="M21 12a9 9 0 0 1-15 6l-3-2" />
                                </svg>
                              ) : (
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth={2}
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <path d="m12 3 1.5 3.5L17 8l-3.5 1.5L12 13l-1.5-3.5L7 8l3.5-1.5L12 3Z" />
                                  <path d="M6 18h12" />
                                  <path d="M8 21h8" />
                                </svg>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    </form>
                  </div>

                  {generatedPlan && (
                    <aside className="plan-build-center">
                      <div className="plan-build-center-checks">
                        <div className="plan-build-center-checks-head">
                          <strong>Verification Checklist</strong>
                        </div>
                        {(generatedPlan.verificationQuestions ?? []).length === 0 ? (
                          <p className="muted">No verification questions returned. You can build after review.</p>
                        ) : (
                          <div className="plan-verification-list">
                            {(generatedPlan.verificationQuestions ?? []).map((question, index) => (
                              <label className="plan-verification-item" key={`${question}-${index}`}>
                              <input
                                type="checkbox"
                                checked={Boolean(verificationChecks[question])}
                                disabled={generatingPlan || buildingPlan}
                                onChange={(event) =>
                                  setVerificationChecks((current) => ({
                                    ...current,
                                    [question]: event.target.checked
                                    }))
                                  }
                                />
                                <span>{question}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>

                      {generatedPlan.assumptions.length > 0 && (
                        <div className="plan-build-center-assumptions">
                          <strong>Assumptions</strong>
                          {generatedPlan.assumptions.slice(0, 6).map((assumption, index) => (
                            <p className="muted" key={`${assumption}-${index}`}>
                              - {assumption}
                            </p>
                          ))}
                        </div>
                      )}

                      <div className="plan-build-center-footer">
                        <button
                          className="btn ghost plan-discard-flow-btn"
                          type="button"
                          onClick={() => discardPlannerFlow()}
                          disabled={buildingPlan || generatingPlan}
                        >
                          Discard Flow
                        </button>
                        <button
                          className="btn plan-build-center-btn"
                          type="button"
                          onClick={() => handleBuildGeneratedPlan()}
                          disabled={buildingPlan || generatingPlan || !hasBuildablePlan}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M4 14a8 8 0 0 1 16 0v5H4z" />
                            <path d="M12 6v8" />
                            <path d="M8 10h8" />
                          </svg>
                          <span>{buildingPlan ? "Building..." : "Build Plan"}</span>
                        </button>
                      </div>
                    </aside>
                  )}
                </div>
              </div>
            </section>
          ) : !activePhase ? (
            <section className="panel">
              <h3>No phases yet</h3>
              <p className="muted">Start by adding your first construction phase, then break it into sections and work items.</p>
            </section>
          ) : (
            <section className="phase-detail-shell">
              <section className="phase-overview-card">
                <div className="phase-floor-plan-head">
                  <div className="phase-floor-plan-head-copy" ref={phaseSummaryRef}>
                    <h2 className="phase-summary-title">{activePhase.title}</h2>
                    <p className="muted">{activePhase.description || "Track dates, budget, and floor plan for this phase."}</p>
                    <div className="phase-info-strip">
                      <div className="phase-info-row">
                        <article className="phase-info-item">
                          <span className="phase-info-icon">
                            <PhaseInfoIcon kind="status" />
                          </span>
                          <div className="phase-info-meta">
                            <span className="phase-info-label">Status</span>
                            <strong className="phase-info-value">
                              <span className={`status-badge status-${activePhase.status.toLowerCase()}`}>{getTaskStatusLabel(activePhase.status)}</span>
                            </strong>
                          </div>
                        </article>
                        <article className="phase-info-item">
                          <span className="phase-info-icon">
                            <PhaseInfoIcon kind="budget" />
                          </span>
                          <div className="phase-info-meta">
                            <span className="phase-info-label">Budget</span>
                            <strong className="phase-info-value">{formatCurrency(activePhase.financials.rolledEstimate)}</strong>
                          </div>
                        </article>
                        <article className="phase-info-item">
                          <span className="phase-info-icon">
                            <PhaseInfoIcon kind="spent" />
                          </span>
                          <div className="phase-info-meta">
                            <span className="phase-info-label">Spent</span>
                            <strong className="phase-info-value">{formatCurrency(activePhase.financials.rolledSpent)}</strong>
                          </div>
                        </article>
                      </div>
                      <div className="phase-info-row">
                        <article className="phase-info-item">
                          <span className="phase-info-icon">
                            <PhaseInfoIcon kind="actual-start" />
                          </span>
                          <div className="phase-info-meta">
                            <span className="phase-info-label">Actual Start</span>
                            <strong className="phase-info-value">{formatDate(activePhase.actualStartDate)}</strong>
                          </div>
                        </article>
                        <article className="phase-info-item">
                          <span className="phase-info-icon">
                            <PhaseInfoIcon kind="actual-end" />
                          </span>
                          <div className="phase-info-meta">
                            <span className="phase-info-label">Actual End</span>
                            <strong className="phase-info-value">{formatDate(activePhase.actualEndDate ?? activePhase.closedAt)}</strong>
                          </div>
                        </article>
                      </div>
                    </div>
                    <div className="phase-top-actions">
                      <button className="btn phase-top-action-btn is-edit" type="button" onClick={() => openEditDrawer(activePhase)}>
                        Edit Phase
                      </button>
                      <button
                        className={`btn ghost phase-top-action-icon ${showMilestoneBoard ? "active" : ""}`}
                        type="button"
                        title={showMilestoneBoard ? "Show sections" : "Show milestone board"}
                        aria-label={showMilestoneBoard ? "Show sections" : "Show milestone board"}
                        onClick={() => setShowMilestoneBoard((current) => !current)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 6h16" />
                          <path d="M4 12h16" />
                          <path d="M4 18h16" />
                          <circle cx="8" cy="6" r="1.5" />
                          <circle cx="12" cy="12" r="1.5" />
                          <circle cx="16" cy="18" r="1.5" />
                        </svg>
                      </button>
                      <div className="phase-worker-picker-wrap">
                        <button
                          className="btn ghost phase-top-action-icon"
                          type="button"
                          title="Assign worker"
                          aria-label="Assign worker to phase"
                          onClick={() => toggleWorkerPicker(`phase:${activePhase._id}`)}
                          disabled={quickWorkerActionId === activePhase._id}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="9" cy="8" r="3" />
                            <path d="M3.5 18a5.5 5.5 0 0 1 11 0" />
                            <circle cx="17" cy="9" r="2.5" />
                            <path d="M14.5 18a4 4 0 0 1 6 0" />
                          </svg>
                        </button>
                        {workerPickerNodeId === `phase:${activePhase._id}` &&
                          renderWorkerPickerMenu(activePhase, quickWorkerActionId === activePhase._id)}
                      </div>
                      {activePhase.status === "DONE" ? (
                        <button className="btn ghost phase-top-action-btn" type="button" onClick={() => reopenNode(activePhase)}>
                          Reopen Phase
                        </button>
                      ) : (
                        <button className="btn phase-top-action-btn is-complete" type="button" onClick={() => closeNode(activePhase)}>
                          Mark as Completed
                        </button>
                      )}
                    </div>
                  </div>

                  <section className="process-timeline-card" aria-label="Process timeline">
                    <div className="process-timeline-title">Process Timeline</div>
                    <div className="process-timeline-chart">
                      <div className="process-timeline-line" />
                      <div className="process-timeline-phase-row">
                      {phases.map((phase, index) => {
                        const tone = getPhaseTimelineTone(phase.status);
                        const isSelected = phase._id === activePhase._id;
                        return (
                          <button
                            key={phase._id}
                            type="button"
                            className={`process-timeline-step top ${tone} ${isSelected ? "selected" : ""}`}
                            onClick={() => setSelectedPhaseId(phase._id)}
                            title={phase.title}
                          >
                            <span className="process-timeline-node">{phase.status === "DONE" ? "✓" : index + 1}</span>
                            <span className="process-timeline-step-title">{phase.title}</span>
                          </button>
                        );
                      })}
                      </div>
                      <div className="process-timeline-section-row">
                        {activeSections.length === 0 ? (
                          <p className="process-timeline-section-empty">No sections yet.</p>
                        ) : (
                          <div className="process-timeline-section-panel">
                            <div className="process-timeline-section-list">
                              {activeSections.map((section, index) => (
                                <button
                                  key={section._id}
                                  type="button"
                                  className={`process-timeline-section-step pill tone-${index % 6} ${selectedSectionId === section._id ? "selected" : ""}`}
                                  onClick={() => selectSection(section._id)}
                                  title={section.title}
                                >
                                  <span className="process-timeline-section-node">{index + 1}</span>
                                  <span className="process-timeline-section-title">{section.title}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </section>
                </div>
              </section>

              {showMilestoneBoard ? (
                milestoneBoard
              ) : (
              <div className="phase-sections-layout">
                <aside className="phase-corner-menu">
                  <div className="row-between wrap">
                    <h4>Sections</h4>
                    <button className="btn ghost" type="button" onClick={() => focusCreateSection(activePhase._id)}>
                      Add
                    </button>
                  </div>
                  <div className="phase-corner-list">
                    {activeSections.length === 0 ? (
                      <p className="muted">No sections in this phase.</p>
                    ) : (
                      activeSections.map((section) => {
                        const sectionTasks = tasks.filter((task) => task.nodeType === "TASK" && task.parentTaskId === section._id);
                        const sectionTone = getSectionProgressTone(sectionTasks);
                        return (
                          <button
                            key={section._id}
                            className={`phase-corner-item is-${sectionTone} ${selectedSectionId === section._id ? "active" : ""}`}
                            type="button"
                            onClick={() => selectSection(section._id)}
                          >
                            <strong>{section.title}</strong>
                            <span>{sectionTasks.length} items</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </aside>

                <div className="phase-sections-list">
                  {activeSections.length === 0 ? (
                    <section className="panel">
                      <h4>No sections yet</h4>
                      <p className="muted">Create sections to break this phase into work areas.</p>
                    </section>
                  ) : visibleSections.length === 0 ? (
                    <section className="panel">
                      <h4>Select a section</h4>
                      <p className="muted">Choose a section from the left menu to view its tasks.</p>
                    </section>
                  ) : (
                    visibleSections.map((section) => {
                      const sectionTasks = tasks.filter((task) => task.nodeType === "TASK" && task.parentTaskId === section._id);
                      const orderedSectionTasks = getOrderedSectionTasks(section._id, sectionTasks);
                      const sectionTone = getSectionProgressTone(sectionTasks);
                      const sectionEstimateGroups = estimateGroups.filter((group) => group.sectionTaskId === section._id);
                      const sectionEstimateGroupToneMap = new Map(
                        sectionEstimateGroups.map((group, index) => [group._id, index % estimateGroupToneCount])
                      );
                      const renderedEstimateGroupBandIds = new Set<string>();
                      const isGroupingSection = groupingSectionId === section._id;

                      return (
                        <article
                          id={`phase-section-${section._id}`}
                          className={`phase-section-card is-${sectionTone} ${selectedSectionId === section._id ? "selected" : ""}`}
                          key={section._id}
                        >
                          <div className="phase-section-toggle">
                            <div>
                              <h4>{section.title}</h4>
                              <p className="muted">{section.description || "No section notes yet."}</p>
                            </div>
                            <div className="phase-section-toggle-meta">
                              <span className={`status-badge status-${section.status.toLowerCase()}`}>{getTaskStatusLabel(section.status)}</span>
                            </div>
                          </div>

                          <div className="phase-section-progress-row">
                            <span>{section.progress.completedTasks} of {section.progress.totalTasks} complete</span>
                            <ProgressMeter value={section.progress.percentComplete} />
                          </div>

                          <div className="phase-section-body">
                            <div className="phase-section-body-actions">
                              <button
                                className="btn ghost phase-section-action-icon"
                                type="button"
                                title="Add Item"
                                aria-label={`Add item to ${section.title}`}
                                onClick={() => focusCreateTask(activePhase._id, section._id)}
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M12 5v14" />
                                    <path d="M5 12h14" />
                                  </svg>
                                </button>
                              <button
                                className={`btn ghost phase-section-action-icon ${isGroupingSection ? "active" : ""}`}
                                type="button"
                                title="Group estimates"
                                aria-label={`Create grouped estimate in ${section.title}`}
                                onClick={() => toggleSectionGrouping(section._id)}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <rect x="3" y="6" width="6" height="6" rx="1.2" />
                                  <rect x="15" y="3" width="6" height="6" rx="1.2" />
                                  <rect x="15" y="15" width="6" height="6" rx="1.2" />
                                  <path d="M9 9h6" />
                                  <path d="M18 9v6" />
                                </svg>
                              </button>
                              <button
                                className="btn ghost phase-section-action-icon"
                                type="button"
                                title="Edit Section"
                                aria-label={`Edit ${section.title}`}
                                onClick={() => openEditDrawer(section)}
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M12 20h9" />
                                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                  </svg>
                                </button>
                            </div>

                            {isGroupingSection && (
                              <div className="estimate-group-selection-bar">
                                <span>{selectedGroupedTaskIds.length} selected</span>
                                <div className="estimate-group-selection-actions">
                                  <button
                                    className="btn"
                                    type="button"
                                    onClick={() => setShowEstimateGroupModal(true)}
                                    disabled={selectedGroupedTaskIds.length < 2}
                                  >
                                    Create Grouped Estimate
                                  </button>
                                  <button className="btn ghost" type="button" onClick={() => resetTaskGroupingSelection()}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}

                            {sectionTasks.length === 0 ? (
                              <p className="muted">No work items in this section yet.</p>
                            ) : (
                              <div
                                className="phase-task-list"
                                onDragOver={(event) => {
                                  if (draggingTaskState?.sectionId === section._id) {
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = "move";
                                  }
                                }}
                                onDrop={(event) => handleTaskDrop(section._id, orderedSectionTasks, event)}
                              >
                                {orderedSectionTasks.map((task, taskIndex) => {
                                  const taskMenuKey = `task:${task._id}`;
                                  const taskIsBusy = quickTaskActionId === task._id || quickWorkerActionId === task._id;
                                  const taskEstimateGroup = task.estimateGroupId ? estimateGroupsById.get(task.estimateGroupId) : undefined;
                                  const taskEstimateGroupId = taskEstimateGroup?._id ?? "";
                                  const taskEstimateGroupTone =
                                    taskEstimateGroupId ? sectionEstimateGroupToneMap.get(taskEstimateGroupId) ?? 0 : null;
                                  const shouldRenderEstimateGroupBand = Boolean(taskEstimateGroupId) && !renderedEstimateGroupBandIds.has(taskEstimateGroupId);
                                  if (taskEstimateGroupId && shouldRenderEstimateGroupBand) {
                                    renderedEstimateGroupBandIds.add(taskEstimateGroupId);
                                  }
                                  const isSelectedForGrouping = selectedGroupedTaskIds.includes(task._id);
                                  const canSelectForGrouping = !taskEstimateGroup;
                                  const assignedWorkers =
                                    Array.isArray(task.resources) && task.resources.length > 0
                                      ? task.resources
                                      : parseOwnerWorkers(task.owner);
                                  const dueMeta = getTaskDueMeta(task.dueDate, task.status);
                                  const taskWbs =
                                    section.wbsId?.trim() ? `${section.wbsId.trim()}.${taskIndex + 1}` : task.wbsId?.trim() || "--";
                                  const isDraggingTask = draggingTaskState?.taskId === task._id;
                                  return (
                                  <Fragment key={task._id}>
                                    {shouldRenderEstimateGroupBand && taskEstimateGroup && (
                                      <div
                                        className={`phase-estimate-group-band tone-${taskEstimateGroupTone ?? 0}`}
                                      >
                                        <div className="phase-estimate-group-band-copy">
                                          <strong>{taskEstimateGroup.name}</strong>
                                          <span>
                                            {taskEstimateGroup.taskIds.length} task{taskEstimateGroup.taskIds.length === 1 ? "" : "s"} · Quote {formatCurrency(taskEstimateGroup.totalAmount)}
                                          </span>
                                        </div>
                                        <button
                                          className="phase-estimate-group-band-action"
                                          type="button"
                                          onClick={() => openEstimateManager(section._id, taskEstimateGroupId)}
                                        >
                                          Manage
                                        </button>
                                      </div>
                                    )}
                                    <article
                                      className={`phase-task-row ${isGroupingSection ? "is-grouping" : ""} ${isSelectedForGrouping ? "is-selected" : ""} ${
                                        isGroupingSection && !canSelectForGrouping ? "is-group-locked" : ""
                                      } ${taskEstimateGroup ? `has-estimate-group group-tone-${taskEstimateGroupTone ?? 0}` : ""} ${
                                        isDraggingTask ? "is-dragging" : ""
                                      }`}
                                      id={`phase-task-${task._id}`}
                                      onDragOver={(event) => handleTaskDragOver(section._id, orderedSectionTasks, task._id, event)}
                                    >
                                      <button
                                        className="phase-task-row-main"
                                        type="button"
                                        onClick={() => {
                                          if (isGroupingSection) {
                                            if (canSelectForGrouping) {
                                              toggleTaskGroupingSelection(task._id);
                                            }
                                            return;
                                          }

                                          openEditDrawer(task);
                                        }}
                                      >
                                        {isGroupingSection && (
                                          <span
                                            className={`phase-task-group-selector ${isSelectedForGrouping ? "selected" : ""} ${
                                              !canSelectForGrouping ? "locked" : ""
                                            }`}
                                            aria-hidden="true"
                                          >
                                            {canSelectForGrouping ? (isSelectedForGrouping ? "✓" : "") : "•"}
                                          </span>
                                        )}
                                        <strong>{task.title}</strong>
                                        <span>{task.description || "No notes"}</span>
                                        {taskEstimateGroup && (
                                          <span className={`phase-task-estimate-group-pill group-tone-${taskEstimateGroupTone ?? 0}`}>
                                            {taskEstimateGroup.name}
                                          </span>
                                        )}
                                      </button>
                                      {assignedWorkers.length > 0 && (
                                        <div className="phase-task-worker-chip-row">
                                          {assignedWorkers.map((workerName) => {
                                            const chipKey = `${task._id}:${workerName}`;
                                            const workerProfile = workersByName.get(workerName.trim().toLowerCase());
                                            return (
                                              <span className="phase-worker-chip-wrap" key={chipKey}>
                                                <button
                                                  className="phase-task-worker-chip"
                                                  type="button"
                                                  title={`View ${workerName}`}
                                                  aria-label={`View ${workerName} details`}
                                                  onClick={() =>
                                                    setWorkerInfoChipKey((current) => (current === chipKey ? null : chipKey))
                                                  }
                                                >
                                                  {workerName}
                                                </button>
                                                {workerInfoChipKey === chipKey && (
                                                  <div className="phase-worker-info-popover" role="dialog" aria-label={`${workerName} profile`}>
                                                    <strong>{workerProfile?.name ?? workerName}</strong>
                                                    <span>{workerProfile ? workerProfile.role.replace(/_/g, " ") : "Worker profile unavailable"}</span>
                                                    {workerProfile?.company && <span>{workerProfile.company}</span>}
                                                    {workerProfile?.phone && <span>{workerProfile.phone}</span>}
                                                    {workerProfile?.email && <span>{workerProfile.email}</span>}
                                                  </div>
                                                )}
                                              </span>
                                            );
                                          })}
                                        </div>
                                      )}
                                      <div className="phase-task-row-meta">
                                        <span className={`status-badge status-${task.status.toLowerCase()}`}>{getTaskStatusLabel(task.status)}</span>
                                        <span className={`phase-task-due-pill is-${dueMeta.tone}`}>{dueMeta.label}</span>
                                        <span>{formatCurrency(task.estimateAmount)}</span>
                                      </div>
                                      {!isGroupingSection && (
                                      <div className="phase-task-row-actions">
                                        <span className="phase-task-wbs phase-task-wbs-inline">{taskWbs}</span>
                                        <button
                                          className="phase-task-action-icon is-reorder"
                                          type="button"
                                          title="Drag to reorder"
                                          aria-label={`Drag to reorder ${task.title}`}
                                          draggable
                                          onDragStart={(event) => handleTaskDragStart(section._id, orderedSectionTasks, task._id, event)}
                                          onDragEnd={() => handleTaskDragEnd(section._id)}
                                          disabled={taskIsBusy}
                                        >
                                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                                            <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
                                          </svg>
                                        </button>
                                        <button
                                          className="phase-task-action-icon is-edit"
                                          type="button"
                                          title="Edit item"
                                          aria-label={`Edit ${task.title}`}
                                          onClick={() => openEditDrawer(task)}
                                          disabled={taskIsBusy}
                                        >
                                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                            <path d="M12 20h9" />
                                            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                          </svg>
                                        </button>
                                        <button
                                          className="phase-task-action-icon is-duplicate"
                                          type="button"
                                          title="Duplicate task"
                                          aria-label={`Duplicate ${task.title}`}
                                          onClick={() => openDuplicateTask(task)}
                                          disabled={taskIsBusy}
                                        >
                                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                            <rect x="9" y="9" width="10" height="10" rx="1.6" />
                                            <path d="M15 9V6.6A1.6 1.6 0 0 0 13.4 5H5.6A1.6 1.6 0 0 0 4 6.6v7.8A1.6 1.6 0 0 0 5.6 16H8" />
                                          </svg>
                                        </button>
                                        <div className="phase-worker-picker-wrap">
                                          <button
                                            className="phase-task-action-icon is-worker"
                                            type="button"
                                            title="Assign worker"
                                            aria-label={`Assign worker to ${task.title}`}
                                            onClick={() => toggleWorkerPicker(taskMenuKey)}
                                            disabled={taskIsBusy}
                                          >
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                              <circle cx="9" cy="8" r="3" />
                                              <path d="M3.5 18a5.5 5.5 0 0 1 11 0" />
                                              <circle cx="17" cy="9" r="2.5" />
                                              <path d="M14.5 18a4 4 0 0 1 6 0" />
                                            </svg>
                                          </button>
                                          {workerPickerNodeId === taskMenuKey &&
                                            renderWorkerPickerMenu(task, taskIsBusy)}
                                        </div>
                                        <button
                                          className={`phase-task-action-icon is-complete ${task.status === "DONE" ? "is-done" : ""}`}
                                          type="button"
                                          title={task.status === "DONE" ? "Already completed" : "Mark complete"}
                                          aria-label={task.status === "DONE" ? `${task.title} is already completed` : `Mark ${task.title} complete`}
                                          onClick={() => handleQuickToggleComplete(task)}
                                          disabled={taskIsBusy || task.status === "DONE"}
                                        >
                                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                            <path d="m5 12 4 4 10-10" />
                                          </svg>
                                        </button>
                                        <div className="phase-task-status-menu-wrap">
                                          <button
                                            className="phase-task-action-icon is-status"
                                            type="button"
                                            title="Update status"
                                            aria-label={`Update status for ${task.title}`}
                                            onClick={() => toggleQuickStatusMenu(task._id)}
                                            disabled={taskIsBusy}
                                          >
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                              <path d="M6 4v16" />
                                              <path d="M6 5h11l-2 4 2 4H6" />
                                            </svg>
                                          </button>
                                          {quickStatusMenuTaskId === task._id && (
                                            <div className="phase-task-status-menu" role="menu" aria-label="Task status menu">
                                              {taskStatuses.map((status) => (
                                                <button
                                                  key={`${task._id}-${status}`}
                                                  className={`phase-task-status-option ${task.status === status ? "active" : ""}`}
                                                  type="button"
                                                  role="menuitem"
                                                  onClick={() => handleQuickStatusChange(task, status)}
                                                  disabled={taskIsBusy}
                                                >
                                                  <span className={`phase-task-status-dot status-${status.toLowerCase()}`} aria-hidden="true" />
                                                  <span>{getTaskStatusLabel(status)}</span>
                                                </button>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                      )}
                                    </article>
                                  </Fragment>
                                );
                                })}
                              </div>
                            )}
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              </div>
              )}
            </section>
          )}
        </div>
      </div>

      {showPhaseWizard && (
        <div className="modal-backdrop" onClick={() => closePhaseWizard()}>
          <div className="panel task-create-modal phase-wizard-modal" onClick={(event) => event.stopPropagation()}>
            <div className="expense-widget-header">
              <h3>New Phase Wizard</h3>
              <button className="btn ghost" type="button" onClick={() => closePhaseWizard()}>
                Close
              </button>
            </div>

            <div className="phase-wizard-steps" aria-label="Phase wizard steps">
              {phaseWizardSteps.map((stepLabel, index) => (
                <span
                  key={stepLabel}
                  className={`phase-wizard-step ${index === phaseWizardStep ? "active" : ""} ${index < phaseWizardStep ? "done" : ""}`}
                >
                  {index + 1}. {stepLabel}
                </span>
              ))}
            </div>
            <div className="phase-wizard-progress" aria-hidden="true">
              <span style={{ width: `${wizardProgressPercent}%` }} />
            </div>

            <form className="task-create-form-grid phase-wizard-form-grid" onSubmit={handlePhaseWizardSubmit}>
              {phaseWizardStep === 0 && (
                <>
                  <label className="task-create-wide">
                    Phase Name
                    <input
                      required
                      value={phaseWizardDraft.title}
                      onChange={(event) => setPhaseWizardDraft((current) => ({ ...current, title: event.target.value }))}
                    />
                  </label>
                  <label>
                    Owner
                    <select
                      value={phaseWizardDraft.owner}
                      onChange={(event) => setPhaseWizardDraft((current) => ({ ...current, owner: event.target.value }))}
                    >
                      <option value="">Select worker</option>
                      {getOwnerOptions(phaseWizardDraft.owner).map((option) => (
                        <option key={`phase-owner-${option.value}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Status
                    <select
                      value={phaseWizardDraft.status}
                      onChange={(event) =>
                        setPhaseWizardDraft((current) => ({ ...current, status: event.target.value as TaskStatus }))
                      }
                    >
                      {taskStatuses.map((status) => (
                        <option key={status} value={status}>
                          {getTaskStatusLabel(status)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Priority
                    <select
                      value={phaseWizardDraft.priority}
                      onChange={(event) =>
                        setPhaseWizardDraft((current) => ({
                          ...current,
                          priority: event.target.value as "LOW" | "MEDIUM" | "HIGH"
                        }))
                      }
                    >
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                    </select>
                  </label>
                  <label className="task-create-wide">
                    Scope Notes
                    <textarea
                      rows={4}
                      value={phaseWizardDraft.description}
                      onChange={(event) => setPhaseWizardDraft((current) => ({ ...current, description: event.target.value }))}
                    />
                  </label>
                </>
              )}

              {phaseWizardStep === 1 && (
                <>
                  <label>
                    Planned Start
                    <input
                      type="date"
                      value={phaseWizardDraft.plannedStartDate}
                      onClick={(event) => openDateInputPicker(event.currentTarget)}
                      onChange={(event) =>
                        setPhaseWizardDraft((current) => ({ ...current, plannedStartDate: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Planned End
                    <input
                      type="date"
                      value={phaseWizardDraft.plannedEndDate}
                      onClick={(event) => openDateInputPicker(event.currentTarget)}
                      onChange={(event) =>
                        setPhaseWizardDraft((current) => ({ ...current, plannedEndDate: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Target Due Date
                    <input
                      type="date"
                      value={phaseWizardDraft.dueDate}
                      onClick={(event) => openDateInputPicker(event.currentTarget)}
                      onChange={(event) => setPhaseWizardDraft((current) => ({ ...current, dueDate: event.target.value }))}
                    />
                  </label>
                  {!phaseWizardDatesValid && (
                    <p className="error-text task-create-wide">Planned end date must be on or after planned start date.</p>
                  )}
                </>
              )}

              {phaseWizardStep === 2 && (
                <>
                  <label>
                    Estimate
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0"
                      value={phaseWizardDraft.estimateAmount}
                      onFocus={() =>
                        setPhaseWizardDraft((current) => ({
                          ...current,
                          estimateAmount: current.estimateAmount.trim() === "0" ? "" : current.estimateAmount
                        }))
                      }
                      onChange={(event) =>
                        setPhaseWizardDraft((current) => ({ ...current, estimateAmount: event.target.value }))
                      }
                    />
                  </label>
                  <div className="phase-wizard-summary task-create-wide">
                    <strong>{phaseWizardDraft.title || "Untitled Phase"}</strong>
                    <span>{phaseWizardDraft.owner || "No owner assigned"}</span>
                    <span>{getTaskStatusLabel(phaseWizardDraft.status)}</span>
                    <span>{phaseWizardDraft.plannedStartDate || "No planned start"} to {phaseWizardDraft.plannedEndDate || "No planned end"}</span>
                  </div>
                </>
              )}

              <div className="task-create-modal-actions">
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    if (phaseWizardStep === 0) {
                      closePhaseWizard();
                      return;
                    }
                    setPhaseWizardStep((current) => Math.max(0, current - 1));
                  }}
                  disabled={savingPhaseWizard}
                >
                  {phaseWizardStep === 0 ? "Cancel" : "Back"}
                </button>
                <button className="btn" type="submit" disabled={savingPhaseWizard || !phaseWizardStepValid}>
                  {savingPhaseWizard ? "Saving..." : phaseWizardStep === phaseWizardSteps.length - 1 ? "Create Phase" : "Next"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showCreateWidget && (
        <div className="modal-backdrop" onClick={() => closeCreateWidget()}>
          <div className="panel task-create-modal" onClick={(event) => event.stopPropagation()}>
            <div className="expense-widget-header">
              <div>
                <h3>{duplicateSourceTask ? "Duplicate Task" : "Create Work Item"}</h3>
                {duplicateSourceTask && <p className="task-create-duplicate-note">Editing a copy of {duplicateSourceTask.title} before creating it.</p>}
              </div>
              <button className="btn ghost" type="button" onClick={() => closeCreateWidget()}>
                Close
              </button>
            </div>

            <div className="task-create-head">
              <button
                className="btn ghost"
                type="button"
                onClick={() => openPhaseWizard()}
              >
                New Phase Wizard
              </button>
              {!duplicateSourceTask && (
                <div className="segmented-control">
                  {(["SECTION", "TASK"] as CreateMode[]).map((mode) => (
                    <button
                      className={createMode === mode ? "active" : ""}
                      key={mode}
                      type="button"
                      onClick={() => setCreateMode(mode)}
                    >
                      {mode === "SECTION" ? "Section" : "Task"}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <form className="task-create-form-grid" onSubmit={handleCreate}>
              <label>
                Phase
                <select value={selectedPhaseId} onChange={(event) => setSelectedPhaseId(event.target.value)} disabled={phases.length === 0}>
                  <option value="">{phases.length > 0 ? "Select phase" : "Add a phase first"}</option>
                  {phases.map((phase) => (
                    <option key={phase._id} value={phase._id}>
                      {phase.title}
                    </option>
                  ))}
                </select>
              </label>

              {createMode === "TASK" && (
                <label>
                  Section
                  <select value={selectedSectionId} onChange={(event) => setSelectedSectionId(event.target.value)} disabled={sections.length === 0}>
                    <option value="">{sections.length > 0 ? "Select section" : "Add a section first"}</option>
                    {sections.map((section) => (
                      <option key={section._id} value={section._id}>
                        {section.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="task-create-wide">
                {createMode === "SECTION" ? "Section Name" : "Task Name"}
                <input
                  required
                  value={draft.title}
                  onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                />
              </label>

              <label className="task-create-wide">
                Scope Notes
                <textarea
                  rows={3}
                  value={draft.description}
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                />
              </label>

              <label>
                Owner
                <select value={draft.owner} onChange={(event) => setDraft((current) => ({ ...current, owner: event.target.value }))}>
                  <option value="">Select worker</option>
                  {getOwnerOptions(draft.owner).map((option) => (
                    <option key={`draft-owner-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Target Due Date
                <input
                  type="date"
                  value={draft.dueDate}
                  onClick={(event) => openDateInputPicker(event.currentTarget)}
                  onChange={(event) => setDraft((current) => ({ ...current, dueDate: event.target.value }))}
                />
              </label>

              {createMode === "TASK" && (
                <label>
                  Priority
                  <select
                    value={draft.priority}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        priority: event.target.value as "LOW" | "MEDIUM" | "HIGH"
                      }))
                    }
                  >
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                  </select>
                </label>
              )}

              <label>
                Estimate
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0"
                  value={draft.estimateAmount}
                  onFocus={() =>
                    setDraft((current) => ({
                      ...current,
                      estimateAmount: current.estimateAmount.trim() === "0" ? "" : current.estimateAmount
                    }))
                  }
                  onChange={(event) => setDraft((current) => ({ ...current, estimateAmount: event.target.value }))}
                />
              </label>

              <div className="task-create-modal-actions">
                  <button className="btn ghost" type="button" onClick={() => closeCreateWidget()}>
                    Cancel
                  </button>
                  <button
                    className="btn"
                    type="submit"
                    disabled={saving || (createMode === "SECTION" && !canCreateSection) || (createMode === "TASK" && !canCreateTask)}
                  >
                    {saving ? "Saving..." : duplicateSourceTask ? "Create Duplicate" : getCreateButtonLabel(createMode)}
                  </button>
                </div>
              </form>
          </div>
        </div>
      )}

      {showEstimateGroupModal && (
        <div className="modal-backdrop" onClick={() => !savingEstimateGroup && closeEstimateGroupModal()}>
          <div className="panel task-create-modal estimate-group-modal" onClick={(event) => event.stopPropagation()}>
            <div className="expense-widget-header">
              <div>
                <h3>Create Grouped Estimate</h3>
                <p className="task-create-duplicate-note">{selectedGroupedTaskIds.length} task(s) selected</p>
              </div>
              <button className="btn ghost" type="button" onClick={() => closeEstimateGroupModal()} disabled={savingEstimateGroup}>
                Close
              </button>
            </div>

            <form className="task-create-form-grid" onSubmit={handleCreateEstimateGroup}>
              <label className="task-create-wide">
                Estimate Name
                <input
                  required
                  value={estimateGroupDraft.name}
                  onChange={(event) => setEstimateGroupDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Example: Contractor Finish Package"
                />
              </label>
              <label>
                Currency
                <select
                  value={estimateGroupDraft.currency}
                  onChange={(event) =>
                    setEstimateGroupDraft((current) => ({
                      ...current,
                      currency: normalizeEstimateGroupCurrency(event.target.value)
                    }))
                  }
                >
                  <option value="USD">USD</option>
                  <option value="JMD">JMD</option>
                </select>
              </label>
              <label>
                Grouped Total
                <input
                  required
                  type="text"
                  inputMode="decimal"
                  placeholder="0"
                  value={estimateGroupDraft.totalAmount}
                  onChange={(event) => setEstimateGroupDraft((current) => ({ ...current, totalAmount: event.target.value }))}
                />
              </label>
              {isEstimateGroupJmd(estimateGroupDraft.currency) && (
                <div className="estimate-group-fx-note task-create-wide">
                  {loadingEstimateGroupFxQuote
                    ? "Loading current JMD rate..."
                    : estimateGroupFxQuote
                      ? `Enter the grouped quote in JMD. It will be stored in USD at today's rate: 1 USD = ${formatCurrency(estimateGroupFxQuote.rate, "JMD")} on ${formatCalendarDate(estimateGroupFxQuote.rateDate)}.`
                      : estimateGroupFxError || "Could not load the current JMD rate."}
                </div>
              )}
              <div className="estimate-group-modal-preview task-create-wide">
                <strong>Included Tasks</strong>
                <div className="estimate-group-modal-task-list">
                  {tasks
                    .filter((task) => selectedGroupedTaskIds.includes(task._id))
                    .map((task) => (
                      <span key={`estimate-group-preview-${task._id}`}>{task.title}</span>
                    ))}
                </div>
              </div>
              {estimateGroupsError && <p className="error-text task-create-wide">{estimateGroupsError}</p>}

              <div className="task-create-modal-actions">
                <button className="btn ghost" type="button" onClick={() => closeEstimateGroupModal()} disabled={savingEstimateGroup}>
                  Cancel
                </button>
                <button
                  className="btn"
                  type="submit"
                  disabled={
                    savingEstimateGroup ||
                    !estimateGroupDraft.name.trim() ||
                    (isEstimateGroupJmd(estimateGroupDraft.currency) && !estimateGroupFxQuote)
                  }
                >
                  {savingEstimateGroup ? "Creating..." : "Create Group"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEstimateManager && (
        <div className="task-edit-drawer-backdrop estimate-group-drawer-backdrop" onClick={() => {
          if (!savingEstimateManager && !dissolvingEstimateGroup && !savingEstimateGroupPayment) {
            setShowEstimateManager(false);
          }
        }}>
          <aside className="task-edit-drawer estimate-group-drawer" onClick={(event) => event.stopPropagation()}>
            <header className="task-edit-drawer-head estimate-group-drawer-head">
              <div>
                <p className="eyebrow">Manage Estimates</p>
                <h3>{activeEstimateGroup?.name ?? "Grouped Estimate"}</h3>
                <p className="muted">{activeEstimateGroup?.section || "Select a grouped estimate to manage its task allocations."}</p>
              </div>
              <button
                className="btn ghost"
                type="button"
                onClick={() => setShowEstimateManager(false)}
                disabled={savingEstimateManager || dissolvingEstimateGroup || savingEstimateGroupPayment}
              >
                Close
              </button>
            </header>

            <div className="task-edit-drawer-grid estimate-group-drawer-grid">
              {activeSectionEstimateGroups.length > 1 && (
                <label className="task-edit-drawer-wide">
                  Group
                  <select
                    value={activeEstimateGroupId ?? ""}
                    onChange={(event) => setActiveEstimateGroupId(event.target.value || null)}
                    disabled={savingEstimateManager || dissolvingEstimateGroup || savingEstimateGroupPayment}
                  >
                    {activeSectionEstimateGroups.map((group) => (
                      <option key={`estimate-group-select-${group._id}`} value={group._id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {activeEstimateGroup ? (
                <>
                  <label className="task-edit-drawer-wide">
                    Estimate Name
                    <input
                      value={estimateManagerName}
                      onChange={(event) => setEstimateManagerName(event.target.value)}
                      disabled={savingEstimateManager || dissolvingEstimateGroup || savingEstimateGroupPayment}
                    />
                  </label>
                  <label>
                    Currency
                    <select
                      value={estimateManagerCurrency}
                      onChange={(event) => setEstimateManagerCurrency(normalizeEstimateGroupCurrency(event.target.value))}
                      disabled={savingEstimateManager || dissolvingEstimateGroup || savingEstimateGroupPayment}
                    >
                      <option value="USD">USD</option>
                      <option value="JMD">JMD</option>
                    </select>
                  </label>
                  <label>
                    Grouped Total
                    <input
                      type="text"
                      inputMode="decimal"
                      value={estimateManagerTotal}
                      onChange={(event) => setEstimateManagerTotal(event.target.value)}
                      disabled={savingEstimateManager || dissolvingEstimateGroup || savingEstimateGroupPayment}
                    />
                  </label>
                  {estimateManagerShowsJmd && (
                    <div className="estimate-group-fx-note task-edit-drawer-wide">
                      {loadingEstimateGroupFxQuote
                        ? "Loading current JMD rate..."
                        : estimateGroupFxQuote
                          ? `Saving a JMD quote uses today's rate: 1 USD = ${formatCurrency(estimateGroupFxQuote.rate, "JMD")} on ${formatCalendarDate(estimateGroupFxQuote.rateDate)}.`
                          : estimateGroupFxError || "Could not load the current JMD rate."}
                    </div>
                  )}
                  <div className="estimate-group-summary task-edit-drawer-wide">
                    <div>
                      <span>Total Quote</span>
                      <strong>{formatEstimateGroupEntryMoney(parseEstimateInput(estimateManagerTotal), estimateManagerCurrency)}</strong>
                      <small>{formatCurrency(estimateManagerTotalUsd, "USD")}</small>
                    </div>
                    <div>
                      <span>Allocated</span>
                      <strong>{formatCurrency(estimateManagerAllocatedUsd, "USD")}</strong>
                      <small>Assigned to task items</small>
                    </div>
                    <div>
                      <span>Paid</span>
                      <strong>{formatEstimateGroupEntryMoney(activeEstimateGroup.entryPaidAmount, activeEstimateGroup.entryCurrency)}</strong>
                      <small>{formatCurrency(activeEstimateGroup.paidAmount, "USD")}</small>
                    </div>
                    <div>
                      <span>Remaining</span>
                      <strong>{formatEstimateGroupEntryMoney(activeEstimateGroup.entryRemainingAmount, activeEstimateGroup.entryCurrency)}</strong>
                      <small>{formatCurrency(activeEstimateGroup.remainingAmount, "USD")}</small>
                    </div>
                  </div>

                  <div className="estimate-group-payment-panel task-edit-drawer-wide">
                    <div>
                      <strong>Record Partial Payment</strong>
                      <span>
                        Add a payment against this grouped estimate without tying it to one task. It will be converted to USD using today's rate.
                      </span>
                    </div>
                    <div className="estimate-group-payment-controls">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={estimatePaymentAmount}
                        onChange={(event) => setEstimatePaymentAmount(event.target.value)}
                        placeholder={`0 ${estimateManagerCurrency}`}
                        disabled={savingEstimateManager || dissolvingEstimateGroup || savingEstimateGroupPayment}
                      />
                      <button
                        className="btn ghost"
                        type="button"
                        onClick={() => handleRecordEstimateGroupPayment()}
                        disabled={
                          savingEstimateManager ||
                          dissolvingEstimateGroup ||
                          savingEstimateGroupPayment ||
                          parseEstimateInput(estimatePaymentAmount) <= 0 ||
                          (estimateManagerShowsJmd && !estimateGroupFxQuote)
                        }
                      >
                        {savingEstimateGroupPayment ? "Recording..." : "Record Payment"}
                      </button>
                    </div>
                    {parseEstimateInput(estimatePaymentAmount) > 0 && (
                      <div className="estimate-group-payment-preview">
                        <span>{formatEstimateGroupEntryMoney(parseEstimateInput(estimatePaymentAmount), estimateManagerCurrency)}</span>
                        <strong>
                          {formatCurrency(
                            convertEstimateGroupEntryToUsd(
                              parseEstimateInput(estimatePaymentAmount),
                              estimateManagerCurrency,
                              estimateGroupFxQuote
                            ),
                            "USD"
                          )}
                        </strong>
                      </div>
                    )}
                  </div>

                  <div className="estimate-group-payment-history task-edit-drawer-wide">
                    <div className="estimate-group-payment-history-head">
                      <strong>Payment History</strong>
                      <span>{activeEstimateGroup.paymentEntries.length} recorded</span>
                    </div>
                    {activeEstimateGroup.paymentEntries.length === 0 ? (
                      <p className="muted">No partial payments recorded yet.</p>
                    ) : (
                      <div className="estimate-group-payment-history-list">
                        {activeEstimateGroup.paymentEntries
                          .slice()
                          .reverse()
                          .map((entry, index) => (
                            <div className="estimate-group-payment-history-row" key={`estimate-group-payment-${index}-${entry.recordedAt}`}>
                              <div>
                                <strong>{formatEstimateGroupEntryMoney(entry.entryAmount, entry.entryCurrency)}</strong>
                                <span>{formatCalendarDate(entry.recordedAt)}</span>
                              </div>
                              <div>
                                <strong>{formatCurrency(entry.amountUsd, "USD")}</strong>
                                <span>
                                  1 USD = {formatCurrency(entry.usdToEntryRate, "JMD")} on {formatCalendarDate(entry.exchangeRateDate)}
                                </span>
                              </div>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>

                  <div className="estimate-group-task-editor task-edit-drawer-wide">
                    {activeEstimateGroupTasks.map((task) => (
                      <label className="estimate-group-task-editor-row" key={`estimate-group-task-${task._id}`}>
                        <div>
                          <strong>{task.title}</strong>
                          <span>{task.description || "No notes"}</span>
                        </div>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={estimateManagerAllocations[task._id] ?? ""}
                          onChange={(event) =>
                            setEstimateManagerAllocations((current) => ({
                              ...current,
                              [task._id]: event.target.value
                            }))
                          }
                          disabled={savingEstimateManager || dissolvingEstimateGroup || savingEstimateGroupPayment}
                        />
                      </label>
                    ))}
                  </div>
                  {estimateGroupsError && <p className="error-text task-edit-drawer-wide">{estimateGroupsError}</p>}
                </>
              ) : (
                <div className="estimate-group-empty-state task-edit-drawer-wide">
                  {estimateGroupsLoading ? "Loading grouped estimates..." : "No grouped estimates in this section yet."}
                </div>
              )}
            </div>

            <footer className="task-edit-drawer-actions">
              {activeEstimateGroup && (
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => setShowDissolveEstimateGroupConfirm(true)}
                  disabled={savingEstimateManager || dissolvingEstimateGroup || savingEstimateGroupPayment}
                >
                  Dissolve Group
                </button>
              )}
              <button
                className="btn ghost"
                type="button"
                onClick={() => setShowEstimateManager(false)}
                disabled={savingEstimateManager || dissolvingEstimateGroup || savingEstimateGroupPayment}
              >
                Cancel
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => handleSaveEstimateGroup()}
                disabled={
                  !activeEstimateGroup ||
                  !estimateManagerName.trim() ||
                  savingEstimateManager ||
                  dissolvingEstimateGroup ||
                  savingEstimateGroupPayment ||
                  (estimateManagerShowsJmd && !estimateGroupFxQuote)
                }
              >
                {savingEstimateManager ? "Saving..." : "Save Estimate"}
              </button>
            </footer>
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={showBuildPlanConfirm}
        title="Build Plan?"
        message="This will create live phases, sections, and tasks from the generated plan."
        confirmLabel="Build Plan"
        busyLabel="Building..."
        busy={buildingPlan}
        onCancel={() => setShowBuildPlanConfirm(false)}
        onConfirm={confirmBuildGeneratedPlan}
      />

      <ConfirmDialog
        open={showDissolveEstimateGroupConfirm}
        title="Dissolve Grouped Estimate?"
        message="This removes the grouped estimate container but leaves the task items and their individual estimates in place."
        confirmLabel="Dissolve Group"
        busyLabel="Dissolving..."
        busy={dissolvingEstimateGroup}
        onCancel={() => setShowDissolveEstimateGroupConfirm(false)}
        onConfirm={handleDissolveEstimateGroup}
      />

      {activeDrawerTask && (
        <div className="task-edit-drawer-backdrop" onClick={() => { if (!savingDrawer) { setDrawerTaskId(null); setDrawerForm({}); setDrawerEstimateInput(""); } }}>
          <aside className="task-edit-drawer" onClick={(event) => event.stopPropagation()}>
            <header className="task-edit-drawer-head">
              <div>
                <p className="eyebrow">Edit Item</p>
                <h3>{activeDrawerTask.nodeType === "PHASE" ? "Phase" : activeDrawerTask.nodeType === "SECTION" ? "Section" : "Task"} Details</h3>
                <p className="task-edit-drawer-context">WBS ID {activeDrawerTask.wbsId?.trim() || "--"}</p>
              </div>
              <button className="btn ghost" type="button" disabled={savingDrawer} onClick={() => { setDrawerTaskId(null); setDrawerForm({}); setDrawerEstimateInput(""); }}>
                Close
              </button>
            </header>

            <fieldset className="task-edit-drawer-grid task-edit-drawer-fieldset" disabled={savingDrawer}>
              <label>
                Title
                <input value={drawerForm.title ?? ""} onChange={(event) => setDrawerForm((current) => ({ ...current, title: event.target.value }))} />
              </label>
              <label>
                Owner
                <select value={drawerForm.owner ?? ""} onChange={(event) => setDrawerForm((current) => ({ ...current, owner: event.target.value }))}>
                  <option value="">Select worker</option>
                  {getOwnerOptions(drawerForm.owner).map((option) => (
                    <option key={`drawer-owner-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {activeDrawerTask.nodeType === "TASK" && (
                <label>
                  Section
                  <select
                    value={drawerForm.parentTaskId ?? activeDrawerTask.parentTaskId ?? ""}
                    onChange={(event) => setDrawerForm((current) => ({ ...current, parentTaskId: event.target.value || undefined }))}
                  >
                    <option value="">Select section</option>
                    {sectionMoveGroups.map((group) => (
                      <optgroup key={`drawer-move-${group.phaseId}`} label={group.phaseTitle}>
                        {group.sections.map((section) => (
                          <option key={`drawer-section-${section._id}`} value={section._id}>
                            {section.title}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Status
                <select
                  value={drawerForm.status ?? activeDrawerTask.status}
                  onChange={(event) => setDrawerForm((current) => ({ ...current, status: event.target.value as TaskStatus }))}
                >
                  {taskStatuses.map((status) => (
                    <option key={status} value={status}>
                      {getTaskStatusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Priority
                <select
                  value={drawerForm.priority ?? activeDrawerTask.priority}
                  onChange={(event) =>
                    setDrawerForm((current) => ({
                      ...current,
                      priority: event.target.value as "LOW" | "MEDIUM" | "HIGH"
                    }))
                  }
                >
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                </select>
              </label>
              <label>
                Estimate
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0"
                  value={drawerEstimateInput}
                  disabled={Boolean(activeDrawerEstimateGroup)}
                  onFocus={() =>
                    {
                      if (activeDrawerEstimateGroup) {
                        return;
                      }
                      if (drawerEstimateInput.trim() === "0") {
                        setDrawerEstimateInput("");
                        setDrawerForm((current) => ({ ...current, estimateAmount: undefined }));
                      }
                    }
                  }
                  onChange={(event) =>
                    {
                      const nextValue = event.target.value;
                      setDrawerEstimateInput(nextValue);
                      setDrawerForm((current) => ({
                        ...current,
                        estimateAmount: nextValue.trim() === "" ? undefined : parseEstimateInput(nextValue)
                      }));
                    }
                  }
                />
                {activeDrawerEstimateGroup && (
                  <span className="task-edit-drawer-field-note">
                    Managed from grouped estimate {activeDrawerEstimateGroup.name}.
                  </span>
                )}
              </label>
              <label>
                Actual Start
                <input
                  type="date"
                  value={toDateInputValue(drawerForm.actualStartDate)}
                  onClick={(event) => openDateInputPicker(event.currentTarget)}
                  onChange={(event) =>
                    setDrawerForm((current) => ({ ...current, actualStartDate: event.target.value || undefined }))
                  }
                />
              </label>
              <label>
                Actual End
                <input
                  type="date"
                  value={toDateInputValue(drawerForm.actualEndDate)}
                  onClick={(event) => openDateInputPicker(event.currentTarget)}
                  onChange={(event) =>
                    setDrawerForm((current) => ({ ...current, actualEndDate: event.target.value || undefined }))
                  }
                />
              </label>
              <label>
                Due Date
                <input
                  type="date"
                  value={toDateInputValue(drawerForm.dueDate)}
                  onClick={(event) => openDateInputPicker(event.currentTarget)}
                  onChange={(event) => setDrawerForm((current) => ({ ...current, dueDate: event.target.value || undefined }))}
                />
              </label>
              <label className="task-edit-drawer-wide">
                <span className="task-edit-drawer-label-head">
                  <span>Notes</span>
                  <span className="task-edit-drawer-inline-meta-wrap">
                    {activeDrawerTask.wbsId?.trim() ? (
                      <span className="task-edit-drawer-inline-meta">WBS ID: {activeDrawerTask.wbsId.trim()}</span>
                    ) : null}
                    {activeDrawerTask.predecessorWbsId?.trim() ? (
                      <span className="task-edit-drawer-inline-meta">Predecessor: {activeDrawerTask.predecessorWbsId.trim()}</span>
                    ) : null}
                  </span>
                </span>
                <textarea
                  ref={drawerNotesTextareaRef}
                  rows={6}
                  value={drawerForm.description ?? ""}
                  onChange={(event) => {
                    setDrawerForm((current) => ({ ...current, description: event.target.value }));
                    resizeDrawerNotesTextarea(event.currentTarget);
                  }}
                />
              </label>
            </fieldset>

            <footer className="task-edit-drawer-actions">
              <button className="btn ghost" type="button" onClick={() => handleDrawerStatusToggle()} disabled={savingDrawer}>
                {activeDrawerTask.status === "DONE" ? "Reopen" : "Mark Complete"}
              </button>
              {canDeleteTask && (
                <button
                  className="btn ghost"
                  type="button"
                  disabled={savingDrawer}
                  onClick={() => {
                      onDeleteTask(activeDrawerTask._id).catch(() => {
                        // Parent handles errors.
                      });
                      setDrawerTaskId(null);
                      setDrawerForm({});
                      setDrawerEstimateInput("");
                    }}
                  >
                  Delete
                </button>
              )}
              <button className="btn ghost" type="button" disabled={savingDrawer} onClick={() => { setDrawerTaskId(null); setDrawerForm({}); setDrawerEstimateInput(""); }}>
                Cancel
              </button>
              <button className="btn" type="button" onClick={() => saveDrawerEdit()} disabled={savingDrawer}>
                {savingDrawer ? "Saving..." : "Save"}
              </button>
            </footer>
          </aside>
        </div>
      )}
    </section>
  );
}
