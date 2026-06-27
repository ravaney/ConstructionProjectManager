import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { HistoryEntryModel } from "../models/HistoryEntry.js";

export type HistoryEntityType = "PROJECT" | "TASK" | "EXPENSE" | "INVOICE" | "ESTIMATE_GROUP";
export type HistoryAction =
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "STATUS_CHANGE"
  | "MARK_PAID"
  | "BUDGET_CHANGE"
  | "BUILD_PLAN"
  | "CLEAR_PHASES";

export type HistoryActorInput = {
  id?: string;
  name?: string;
  role?: string;
};

export type HistoryScopeInput = {
  phase?: string;
  phaseTaskId?: string;
  section?: string;
  sectionTaskId?: string;
  subsection?: string;
  subsectionTaskId?: string;
};

export type HistoryMoneyImpactInput = {
  label: string;
  currency?: string;
  before: number;
  after: number;
};

export type HistoryChangedField = {
  field: string;
  before?: unknown;
  after?: unknown;
};

type SnapshotRecord = Record<string, unknown>;
type HistoryNarrativeResult = {
  detail: string;
  highlights: string[];
  provider: "openai" | "fallback";
};
type HistoryAllocationSummary = {
  detail: string;
  highlights: string[];
};

function toMoney(value: number): number {
  return Number(Number(value ?? 0).toFixed(2));
}

function formatMoneyText(value: number, currency = "USD"): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency
  });
}

function formatFieldLabel(field: string): string {
  return field
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toNarrativeValue(value: unknown): string {
  const normalized = normalizeHistoryValue(value);
  if (normalized === null || normalized === undefined || normalized === "") {
    return "--";
  }

  if (typeof normalized === "number") {
    return Number.isFinite(normalized) ? normalized.toLocaleString() : "--";
  }

  if (typeof normalized === "boolean") {
    return normalized ? "Yes" : "No";
  }

  if (typeof normalized === "string") {
    return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
  }

  try {
    const text = JSON.stringify(normalized);
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  } catch {
    return String(normalized);
  }
}

function extractJsonString(rawText: string): string {
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return rawText.slice(start, end + 1);
  }

  return rawText.trim();
}

function toSnapshotRecord(value: unknown): SnapshotRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as SnapshotRecord;
}

function toNumberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildExpenseAllocationSummary(input: {
  entityType: HistoryEntityType;
  action: HistoryAction;
  before?: SnapshotRecord;
  after?: SnapshotRecord;
  moneyImpact?: ReturnType<typeof buildMoneyImpact>;
}): HistoryAllocationSummary | undefined {
  if (input.entityType !== "EXPENSE") {
    return undefined;
  }

  const currency = input.moneyImpact?.currency ?? "USD";
  const beforeCategory = toStringValue(input.before?.category);
  const afterCategory = toStringValue(input.after?.category);
  const beforeAmount = toNumberValue(input.before?.amount) ?? input.moneyImpact?.before ?? 0;
  const afterAmount = toNumberValue(input.after?.amount) ?? input.moneyImpact?.after ?? 0;
  const delta = toMoney(afterAmount - beforeAmount);

  if (input.action === "CREATE" && afterCategory) {
    return {
      detail: `This added ${formatMoneyText(afterAmount, currency)} into ${afterCategory} allocation.`,
      highlights: [`${afterCategory}: +${formatMoneyText(afterAmount, currency)}`]
    };
  }

  if (input.action === "DELETE" && beforeCategory) {
    return {
      detail: `This removed ${formatMoneyText(beforeAmount, currency)} from ${beforeCategory} allocation.`,
      highlights: [`${beforeCategory}: -${formatMoneyText(beforeAmount, currency)}`]
    };
  }

  if (beforeCategory && afterCategory && beforeCategory !== afterCategory) {
    const highlights = [
      `${beforeCategory}: -${formatMoneyText(beforeAmount, currency)}`,
      `${afterCategory}: +${formatMoneyText(afterAmount, currency)}`
    ];
    if (delta !== 0) {
      highlights.push(`Net spend impact: ${delta > 0 ? "+" : "-"}${formatMoneyText(Math.abs(delta), currency)}`);
    }

    return {
      detail:
        `This reclassified the expense from ${beforeCategory} to ${afterCategory}, ` +
        `moving ${formatMoneyText(beforeAmount, currency)} out of ${beforeCategory} and ` +
        `${formatMoneyText(afterAmount, currency)} into ${afterCategory}.` +
        (delta !== 0
          ? ` Overall spend changed by ${delta > 0 ? "an increase of" : "a decrease of"} ${formatMoneyText(Math.abs(delta), currency)}.`
          : ""),
      highlights
    };
  }

  const effectiveCategory = afterCategory || beforeCategory;
  if (effectiveCategory && delta !== 0) {
    return {
      detail:
        `This ${delta > 0 ? "increased" : "decreased"} ${effectiveCategory} allocation by ` +
        `${formatMoneyText(Math.abs(delta), currency)}, from ${formatMoneyText(beforeAmount, currency)} ` +
        `to ${formatMoneyText(afterAmount, currency)}.`,
      highlights: [
        `${effectiveCategory}: ${formatMoneyText(beforeAmount, currency)} -> ${formatMoneyText(afterAmount, currency)}`
      ]
    };
  }

  return undefined;
}

export function toIdString(value: unknown): string {
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

export function toDateValue(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function normalizeArray(values: unknown[]): unknown[] {
  return values.map((value) => normalizeHistoryValue(value));
}

export function normalizeHistoryValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return normalizeArray(value);
  }

  if (value && typeof value === "object") {
    if ("_id" in (value as Record<string, unknown>) && Object.keys(value as Record<string, unknown>).length === 1) {
      return toIdString((value as Record<string, unknown>)._id);
    }

    const normalizedEntries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      normalizeHistoryValue(entryValue)
    ]);
    return Object.fromEntries(normalizedEntries);
  }

  return value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeHistoryValue(left)) === JSON.stringify(normalizeHistoryValue(right));
}

export function buildChangedFields(
  before: SnapshotRecord | undefined,
  after: SnapshotRecord | undefined,
  keys?: string[]
): HistoryChangedField[] {
  const beforeSnapshot = before ?? {};
  const afterSnapshot = after ?? {};
  const fieldKeys = keys ?? Array.from(new Set([...Object.keys(beforeSnapshot), ...Object.keys(afterSnapshot)]));

  return fieldKeys
    .filter((field) => !valuesEqual(beforeSnapshot[field], afterSnapshot[field]))
    .map((field) => ({
      field,
      before: normalizeHistoryValue(beforeSnapshot[field]),
      after: normalizeHistoryValue(afterSnapshot[field])
    }));
}

export function buildHistoryActor(actor?: HistoryActorInput) {
  return {
    id: actor?.id ?? "",
    name: actor?.name?.trim() || "Unknown User",
    role: actor?.role?.trim() || "UNKNOWN"
  };
}

export function buildMoneyImpact(input?: HistoryMoneyImpactInput) {
  if (!input) {
    return undefined;
  }

  return {
    label: input.label,
    currency: input.currency ?? "USD",
    before: toMoney(input.before),
    after: toMoney(input.after),
    delta: toMoney(input.after - input.before)
  };
}

function buildFallbackNarrative(input: {
  summary: string;
  entityType: HistoryEntityType;
  entityLabel: string;
  action: HistoryAction;
  changedFields: HistoryChangedField[];
  moneyImpact?: ReturnType<typeof buildMoneyImpact>;
  scope?: ReturnType<typeof compactScope>;
  allocationImpact?: HistoryAllocationSummary;
}): HistoryNarrativeResult {
  const highlights = input.changedFields
    .slice(0, 4)
    .map((field) => `${formatFieldLabel(field.field)}: ${toNarrativeValue(field.before)} -> ${toNarrativeValue(field.after)}`);

  if (input.allocationImpact) {
    highlights.unshift(...input.allocationImpact.highlights);
  }

  if (input.moneyImpact) {
    highlights.push(
      `${input.moneyImpact.label}: ${formatMoneyText(input.moneyImpact.before, input.moneyImpact.currency)} -> ${formatMoneyText(input.moneyImpact.after, input.moneyImpact.currency)}`
    );
  }

  const scopeParts = [input.scope?.phase, input.scope?.section, input.scope?.subsection].filter(Boolean);
  const scopeText = scopeParts.length > 0 ? ` Scope: ${scopeParts.join(" / ")}.` : "";
  const fieldText =
    input.changedFields.length > 0
      ? ` ${input.changedFields.length} field${input.changedFields.length === 1 ? "" : "s"} changed.`
      : " No field-level diffs were captured.";
  const moneyText = input.moneyImpact
    ? ` ${input.moneyImpact.label} moved by ${input.moneyImpact.delta.toLocaleString(undefined, {
        style: "currency",
        currency: input.moneyImpact.currency
      })}.`
    : "";
  const allocationText = input.allocationImpact ? ` ${input.allocationImpact.detail}` : "";

  return {
    detail: `${input.summary}.${fieldText}${moneyText}${allocationText}${scopeText}`.replace(/\.\./g, ".").trim(),
    highlights: highlights.slice(0, 5),
    provider: "fallback"
  };
}

function normalizeNarrativeResult(candidate: unknown, fallback: HistoryNarrativeResult): HistoryNarrativeResult {
  if (!candidate || typeof candidate !== "object") {
    return fallback;
  }

  const record = candidate as Record<string, unknown>;
  const detail = typeof record.detail === "string" ? record.detail.trim() : "";
  const highlights = Array.isArray(record.highlights)
    ? record.highlights.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 5)
    : [];

  if (!detail) {
    return fallback;
  }

  return {
    detail,
    highlights,
    provider: "openai"
  };
}

async function generateHistoryNarrative(input: {
  summary: string;
  entityType: HistoryEntityType;
  entityLabel: string;
  action: HistoryAction;
  changedFields: HistoryChangedField[];
  moneyImpact?: ReturnType<typeof buildMoneyImpact>;
  scope?: ReturnType<typeof compactScope>;
  allocationImpact?: HistoryAllocationSummary;
}): Promise<HistoryNarrativeResult> {
  const fallback = buildFallbackNarrative(input);
  if (!env.OPENAI_API_KEY) {
    return fallback;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are an audit-log narrator for a construction and finance app. " +
              "Return strict JSON with keys detail and highlights. " +
              "detail must be 2-4 concise sentences describing exactly what changed, using only the supplied data. " +
              "highlights must be an array of up to 5 short bullets focused on the most important field changes. " +
              "Mention money impact when present. Do not speculate or invent causes."
          },
          {
            role: "user",
            content: JSON.stringify({
              summary: input.summary,
              entityType: input.entityType,
              entityLabel: input.entityLabel,
              action: input.action,
              scope: input.scope,
              allocationImpact: input.allocationImpact,
              changedFields: input.changedFields.map((field) => ({
                field: formatFieldLabel(field.field),
                before: normalizeHistoryValue(field.before),
                after: normalizeHistoryValue(field.after)
              })),
              moneyImpact: input.moneyImpact
            })
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed with ${response.status}`);
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
      return fallback;
    }

    return normalizeNarrativeResult(JSON.parse(extractJsonString(rawText)), fallback);
  } catch {
    return fallback;
  }
}

export function compactScope(scope?: HistoryScopeInput) {
  if (!scope) {
    return undefined;
  }

  const compacted = Object.fromEntries(
    Object.entries(scope).filter(([, value]) => typeof value === "string" && value.trim().length > 0)
  );

  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

export function buildProjectSnapshot(project: any) {
  return {
    name: project?.name ?? "",
    phase: project?.phase ?? "",
    totalBudget: toMoney(Number(project?.totalBudget ?? 0)),
    currency: project?.currency ?? "USD",
    notes: project?.notes ?? "",
    floorPlanPlanCount: Array.isArray(project?.floorPlanMarkup?.plans) ? project.floorPlanMarkup.plans.length : 0
  };
}

export function buildTaskSnapshot(task: any) {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    nodeType: task?.nodeType ?? "TASK",
    phase: task?.phase ?? "",
    phaseTaskId: toIdString(task?.phaseTaskId),
    section: task?.section ?? "",
    sectionTaskId: toIdString(task?.sectionTaskId),
    parentTaskId: toIdString(task?.parentTaskId),
    status: task?.status ?? "PLANNED",
    owner: task?.owner ?? "",
    plannedStartDate: toDateValue(task?.plannedStartDate),
    plannedEndDate: toDateValue(task?.plannedEndDate),
    actualStartDate: toDateValue(task?.actualStartDate),
    actualEndDate: toDateValue(task?.actualEndDate),
    dueDate: toDateValue(task?.dueDate),
    priority: task?.priority ?? "MEDIUM",
    estimateAmount: toMoney(Number(task?.estimateAmount ?? task?.budgetImpact ?? 0)),
    estimateGroupId: toIdString(task?.estimateGroupId),
    sortOrder: Number(task?.sortOrder ?? 0)
  };
}

export function buildExpenseSnapshot(expense: any) {
  return {
    name: expense?.name ?? "",
    category: expense?.category ?? "",
    amount: toMoney(Number(expense?.amount ?? 0)),
    date: toDateValue(expense?.date),
    vendor: expense?.vendor ?? "",
    phase: expense?.phase ?? "",
    phaseTaskId: toIdString(expense?.phaseTaskId),
    section: expense?.section ?? "",
    sectionTaskId: toIdString(expense?.sectionTaskId),
    subsection: expense?.subsection ?? "",
    subsectionTaskId: toIdString(expense?.subsectionTaskId),
    unit: expense?.unit ?? "",
    unitPrice: toMoney(Number(expense?.unitPrice ?? 0)),
    quantity: Number(expense?.quantity ?? 0),
    workerRole: expense?.workerRole ?? "OTHER",
    workerProfileId: toIdString(expense?.workerProfileId),
    invoiceId: toIdString(expense?.invoiceId),
    invoiceNumber: expense?.invoiceNumber ?? "",
    notes: expense?.notes ?? "",
    source: expense?.source ?? "manual"
  };
}

export function buildInvoiceSnapshot(invoice: any) {
  return {
    vendor: invoice?.vendor ?? "",
    invoiceNumber: invoice?.invoiceNumber ?? "",
    issueDate: toDateValue(invoice?.issueDate),
    dueDate: toDateValue(invoice?.dueDate),
    phase: invoice?.phase ?? "",
    phaseTaskId: toIdString(invoice?.phaseTaskId),
    section: invoice?.section ?? "",
    sectionTaskId: toIdString(invoice?.sectionTaskId),
    subsection: invoice?.subsection ?? "",
    subsectionTaskId: toIdString(invoice?.subsectionTaskId),
    status: invoice?.status ?? "UNPAID",
    currency: invoice?.currency ?? "USD",
    entryCurrency: invoice?.entryCurrency ?? invoice?.currency ?? "USD",
    usdToEntryRate: toMoney(Number(invoice?.usdToEntryRate ?? 1)),
    exchangeRateDate: toDateValue(invoice?.exchangeRateDate),
    totalAmount: toMoney(Number(invoice?.totalAmount ?? 0)),
    paidAmount: toMoney(Number(invoice?.paidAmount ?? 0)),
    paidAt: toDateValue(invoice?.paidAt),
    notes: invoice?.notes ?? "",
    itemCount: Array.isArray(invoice?.items) ? invoice.items.length : 0,
    items: Array.isArray(invoice?.items)
      ? invoice.items.map((item: any) => ({
          description: item?.description ?? "",
          category: item?.category ?? "",
          quantity: Number(item?.quantity ?? 0),
          unit: item?.unit ?? "",
          unitPrice: toMoney(Number(item?.unitPrice ?? 0)),
          amount: toMoney(Number(item?.amount ?? 0)),
          recordOnly: Boolean(item?.recordOnly),
          paid: Boolean(item?.paid)
        }))
      : []
  };
}

export async function recordHistoryEvent(input: {
  operationId?: string;
  entityType: HistoryEntityType;
  entityId: string;
  entityLabel: string;
  action: HistoryAction;
  summary: string;
  actor?: HistoryActorInput;
  scope?: HistoryScopeInput;
  before?: SnapshotRecord;
  after?: SnapshotRecord;
  changedFields?: HistoryChangedField[];
  moneyImpact?: HistoryMoneyImpactInput;
  metadata?: Record<string, unknown>;
}) {
  const actor = buildHistoryActor(input.actor);
  const scope = compactScope(input.scope);
  const beforeSnapshot = input.before ? toSnapshotRecord(normalizeHistoryValue(input.before)) : undefined;
  const afterSnapshot = input.after ? toSnapshotRecord(normalizeHistoryValue(input.after)) : undefined;
  const changedFields = (input.changedFields ?? []).map((field) => ({
    field: field.field,
    before: normalizeHistoryValue(field.before),
    after: normalizeHistoryValue(field.after)
  }));
  const moneyImpact = buildMoneyImpact(input.moneyImpact);
  const allocationImpact = buildExpenseAllocationSummary({
    entityType: input.entityType,
    action: input.action,
    before: beforeSnapshot,
    after: afterSnapshot,
    moneyImpact
  });
  const narrative = await generateHistoryNarrative({
    summary: input.summary,
    entityType: input.entityType,
    entityLabel: input.entityLabel,
    action: input.action,
    changedFields,
    moneyImpact,
    scope,
    allocationImpact
  });

  return HistoryEntryModel.create({
    operationId: input.operationId ?? randomUUID(),
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel,
    action: input.action,
    summary: input.summary,
    actor,
    scope,
    before: beforeSnapshot,
    after: afterSnapshot,
    changedFields,
    moneyImpact,
    narrative,
    metadata: input.metadata ? normalizeHistoryValue(input.metadata) : undefined
  });
}
