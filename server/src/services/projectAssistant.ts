import { env } from "../env.js";
import { EstimateGroupModel } from "../models/EstimateGroup.js";
import { ExpenseModel } from "../models/Expense.js";
import { HistoryEntryModel } from "../models/HistoryEntry.js";
import { InvoiceModel } from "../models/Invoice.js";
import { MaterialPresetModel } from "../models/MaterialPreset.js";
import { VendorModel } from "../models/Vendor.js";
import { WorkerProfileModel } from "../models/WorkerProfile.js";
import { getJmdRateQuote } from "./exchangeRates.js";
import { toIdString } from "./history.js";
import { ensureProject } from "../utils/ensureProject.js";
import { getTaskHierarchySnapshot } from "../utils/taskHierarchy.js";

export type AssistantChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AssistantChatSource = {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
};

export type AssistantChatResult = {
  answer: string;
  sources: AssistantChatSource[];
  actions?: AssistantChatAction[];
  model: string;
  usedFallback: boolean;
  warning?: string;
};

export type AssistantChatAction =
  | {
      id: string;
      kind: "CREATE_SECTION";
      label: string;
      summary: string;
      payload: {
        title: string;
        description?: string;
        nodeType: "SECTION";
        parentTaskId: string;
        status?: "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "DONE";
        owner?: string;
        dueDate?: string;
        estimateAmount?: number;
      };
    }
  | {
      id: string;
      kind: "UPDATE_SECTION";
      label: string;
      summary: string;
      taskId: string;
      payload: {
        title?: string;
        description?: string;
        status?: "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "DONE";
        owner?: string;
        dueDate?: string;
        estimateAmount?: number;
      };
    };

type AssistantSourceRecord = AssistantChatSource & {
  body: string;
  searchText: string;
  createdAt?: number;
  priority: number;
};

type OpenAiAssistantResponse = {
  answer: string;
  sourceIds: string[];
};

type JmdQuoteCache = Map<string, Promise<Awaited<ReturnType<typeof getJmdRateQuote>>>>;
type AssistantProvider = "openai" | "qwen" | "deepseek";
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

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "to",
  "us",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "you"
]);

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

function normalizeDashboardCategory(category?: string): string {
  const normalized = (category ?? "").trim();
  if (!normalized) {
    return "Other";
  }

  if (/^materials(?:\s*\/.*)?$/i.test(normalized)) {
    return "Materials";
  }

  if (/^(labor|labour)\s+cost(?:\s*\/.*)?$/i.test(normalized)) {
    return "Labour Cost";
  }

  if (/equipment/i.test(normalized)) {
    return "Equipment";
  }

  if (/land/i.test(normalized)) {
    return "Land";
  }

  return normalized;
}

function formatTaskStatusLabel(status?: string): string {
  switch ((status ?? "").toUpperCase()) {
    case "PLANNED":
      return "Planned";
    case "IN_PROGRESS":
      return "In Progress";
    case "BLOCKED":
      return "Blocked";
    case "DONE":
      return "Completed";
    default:
      return (status ?? "--")
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (character) => character.toUpperCase()) || "--";
  }
}

function formatMoney(value: number, currency = "USD"): string {
  return Number(value ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatDate(value?: string | Date | null): string {
  if (!value) {
    return "--";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function formatDateTime(value?: string | Date | null): string {
  if (!value) {
    return "--";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function toCalendarDateKey(value?: string | Date | null): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}

function formatRate(value: number): string {
  return Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  });
}

async function getCachedUsdToJmdQuote(cache: JmdQuoteCache, date?: string | Date | null) {
  const dateKey = toCalendarDateKey(date);
  const cacheKey = `USD:${dateKey}`;
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pending = getJmdRateQuote({ currency: "USD", date: dateKey });
  cache.set(cacheKey, pending);
  return pending;
}

async function buildUsdJmdMoneyText(input: {
  label: string;
  usdAmount: number;
  date?: string | Date | null;
  cache: JmdQuoteCache;
  savedJmdAmount?: number;
  savedRate?: number;
  savedRateDate?: string | Date | null;
}) {
  const usdAmount = Number(input.usdAmount ?? 0);
  const hasSavedJmd = typeof input.savedJmdAmount === "number" && Number.isFinite(input.savedJmdAmount);

  if (hasSavedJmd) {
    const savedRate = Number(input.savedRate ?? 0);
    const rateSuffix = savedRate > 0 ? ` at 1 USD = ${formatRate(savedRate)} JMD` : "";
    return `${input.label}: ${formatMoney(usdAmount, "USD")} | ${formatMoney(Number(input.savedJmdAmount), "JMD")} (saved${input.savedRateDate ? ` on ${formatDate(input.savedRateDate)}` : ""}${rateSuffix})`;
  }

  const quote = await getCachedUsdToJmdQuote(input.cache, input.date);
  if (!quote) {
    return `${input.label}: ${formatMoney(usdAmount, "USD")}`;
  }

  const jmdAmount = Number((usdAmount * quote.rate).toFixed(2));
  return `${input.label}: ${formatMoney(usdAmount, "USD")} | ${formatMoney(jmdAmount, "JMD")} (converted using ${formatDate(quote.rateDate)} rate 1 USD = ${formatRate(quote.rate)} JMD)`;
}

function extractJsonString(rawText: string): string {
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return rawText.slice(start, end + 1);
  }

  return rawText.trim();
}

function normalizeAssistantResponse(raw: unknown): OpenAiAssistantResponse | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const answer = typeof (raw as { answer?: unknown }).answer === "string" ? (raw as { answer: string }).answer.trim() : "";
  const sourceIds = Array.isArray((raw as { sourceIds?: unknown[] }).sourceIds)
    ? (raw as { sourceIds: unknown[] }).sourceIds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  if (!answer) {
    return null;
  }

  return {
    answer,
    sourceIds
  };
}

function tokenize(input: string): string[] {
  const matches = input.toLowerCase().match(/[a-z0-9][a-z0-9./-]*/g) ?? [];
  const unique = new Set<string>();

  for (const token of matches) {
    if (token.length <= 1 || STOP_WORDS.has(token)) {
      continue;
    }

    unique.add(token);
  }

  return Array.from(unique);
}

function normalizeLookupText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractQuotedValue(query: string): string | undefined {
  const match = query.match(/["“”']([^"“”']+)["“”']/);
  return match?.[1]?.trim() || undefined;
}

function parseTaskStatus(value?: string) {
  const normalized = (value ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  if (normalized === "PLANNED" || normalized === "IN_PROGRESS" || normalized === "BLOCKED" || normalized === "DONE") {
    return normalized;
  }

  if (normalized === "COMPLETED" || normalized === "COMPLETE") {
    return "DONE" as const;
  }

  return undefined;
}

function findPhaseForAction(
  query: string,
  phases: Array<{ _id: string; title?: string; wbsId?: string }>,
  currentPhase?: { _id: string; title?: string; wbsId?: string }
) {
  const normalizedQuery = normalizeLookupText(query);
  if (currentPhase) {
    const currentTitle = normalizeLookupText(currentPhase.title ?? "");
    const currentWbs = normalizeLookupText(currentPhase.wbsId ?? "");
    if ((currentTitle && normalizedQuery.includes(currentTitle)) || (currentWbs && normalizedQuery.includes(currentWbs))) {
      return currentPhase;
    }
  }

  const exactMatch = phases.find((phase) => {
    const title = normalizeLookupText(phase.title ?? "");
    const wbsId = normalizeLookupText(phase.wbsId ?? "");
    return (title && normalizedQuery.includes(title)) || (wbsId && normalizedQuery.includes(wbsId));
  });

  return exactMatch ?? currentPhase ?? phases[0];
}

function findSectionForAction(
  name: string,
  sections: Array<{ _id: string; title?: string; phaseTaskId?: string; wbsId?: string }>,
  currentSection?: { _id: string; title?: string; phaseTaskId?: string; wbsId?: string },
  currentPhaseId?: string
) {
  const normalizedName = normalizeLookupText(name);
  if (!normalizedName) {
    return undefined;
  }

  if (currentSection) {
    const currentTitle = normalizeLookupText(currentSection.title ?? "");
    const currentWbs = normalizeLookupText(currentSection.wbsId ?? "");
    if (normalizedName === currentTitle || normalizedName === currentWbs) {
      return currentSection;
    }
  }

  const candidates = sections.filter((section) => {
    const title = normalizeLookupText(section.title ?? "");
    const wbsId = normalizeLookupText(section.wbsId ?? "");
    return normalizedName === title || normalizedName === wbsId || title.includes(normalizedName) || normalizedName.includes(title);
  });

  if (candidates.length === 0) {
    return undefined;
  }

  const currentPhaseMatch = currentPhaseId ? candidates.find((section) => section.phaseTaskId === currentPhaseId) : undefined;
  return currentPhaseMatch ?? candidates[0];
}

function buildAssistantSectionActions(input: {
  query: string;
  tasks: Array<{
    _id: string;
    title?: string;
    nodeType?: string;
    wbsId?: string;
    phaseTaskId?: string;
    sectionTaskId?: string;
    section?: string;
    description?: string;
    owner?: string;
    status?: string;
    dueDate?: string;
    estimateAmount?: number;
  }>;
  currentPhase?: { _id: string; title?: string; wbsId?: string };
  currentSection?: { _id: string; title?: string; phaseTaskId?: string; wbsId?: string };
}) {
  const query = input.query.trim();
  if (!query) {
    return { actions: [] as AssistantChatAction[], answer: "", sourceIds: [] as string[] };
  }

  const phases = input.tasks.filter((task) => task.nodeType === "PHASE");
  const sections = input.tasks.filter((task) => task.nodeType === "SECTION");
  const quotedValue = extractQuotedValue(query);

  const createMatch = query.match(/\b(?:create|add|make)\b[\w\s-]*\bsection\b/i);
  if (createMatch) {
    let sectionTitle =
      quotedValue ??
      query.match(/\b(?:called|named)\s+(.+?)(?:\s+\b(?:under|in|on)\b|\s*$)/i)?.[1]?.trim() ??
      query.match(/\bsection\s+(.+?)(?:\s+\b(?:under|in|on)\b|\s*$)/i)?.[1]?.trim() ??
      "";

    sectionTitle = sectionTitle.replace(/\b(?:called|named)\b/i, "").trim();
    if (sectionTitle) {
      const phase = findPhaseForAction(query, phases, input.currentPhase);
      if (phase) {
        const action: AssistantChatAction = {
          id: `assistant-create-section-${Date.now()}`,
          kind: "CREATE_SECTION",
          label: "Create Section",
          summary: `Create section "${sectionTitle}" under ${phase.title}`,
          payload: {
            title: sectionTitle,
            nodeType: "SECTION",
            parentTaskId: phase._id
          }
        };
        return {
          actions: [action],
          answer: `I prepared a section action for you. Review it below and apply it to create "${sectionTitle}" under ${phase.title}.`,
          sourceIds: [`task.${phase._id}`]
        };
      }
    }
  }

  const renameMatch = query.match(/\brename\s+section\s+(.+?)\s+to\s+(.+)\s*$/i);
  if (renameMatch) {
    const currentName = renameMatch[1].trim().replace(/^["“”']|["“”']$/g, "");
    const nextName = renameMatch[2].trim().replace(/^["“”']|["“”']$/g, "");
    const section = findSectionForAction(currentName, sections, input.currentSection, input.currentPhase?._id);
    if (section && nextName) {
      const action: AssistantChatAction = {
        id: `assistant-update-section-${Date.now()}`,
        kind: "UPDATE_SECTION",
        label: "Rename Section",
        summary: `Rename ${section.title} to "${nextName}"`,
        taskId: section._id,
        payload: {
          title: nextName
        }
      };
      return {
        actions: [action],
        answer: `I prepared a section update for you. Review it below and apply it to rename ${section.title} to "${nextName}".`,
        sourceIds: [`task.${section._id}`]
      };
    }
  }

  const statusMatch = query.match(/\b(?:mark|set|change)\s+section\s+(.+?)\s+(?:as|to)\s+(planned|in progress|blocked|done|completed)\b/i);
  if (statusMatch) {
    const sectionName = statusMatch[1].trim().replace(/^["“”']|["“”']$/g, "");
    const status = parseTaskStatus(statusMatch[2]);
    const section = findSectionForAction(sectionName, sections, input.currentSection, input.currentPhase?._id);
    if (section && status) {
      const action: AssistantChatAction = {
        id: `assistant-update-section-${Date.now()}`,
        kind: "UPDATE_SECTION",
        label: "Update Section Status",
        summary: `Set ${section.title} to ${formatTaskStatusLabel(status)}`,
        taskId: section._id,
        payload: {
          status
        }
      };
      return {
        actions: [action],
        answer: `I prepared a section status update for you. Review it below and apply it to set ${section.title} to ${formatTaskStatusLabel(status)}.`,
        sourceIds: [`task.${section._id}`]
      };
    }
  }

  const ownerMatch = query.match(/\bset\s+section\s+(.+?)\s+owner\s+to\s+(.+)\s*$/i);
  if (ownerMatch) {
    const sectionName = ownerMatch[1].trim().replace(/^["“”']|["“”']$/g, "");
    const owner = ownerMatch[2].trim().replace(/^["“”']|["“”']$/g, "");
    const section = findSectionForAction(sectionName, sections, input.currentSection, input.currentPhase?._id);
    if (section && owner) {
      const action: AssistantChatAction = {
        id: `assistant-update-section-${Date.now()}`,
        kind: "UPDATE_SECTION",
        label: "Update Section Owner",
        summary: `Set owner on ${section.title} to ${owner}`,
        taskId: section._id,
        payload: {
          owner
        }
      };
      return {
        actions: [action],
        answer: `I prepared a section owner update for you. Review it below and apply it to set ${section.title} to ${owner}.`,
        sourceIds: [`task.${section._id}`]
      };
    }
  }

  const descriptionMatch = query.match(/\bset\s+section\s+(.+?)\s+description\s+to\s+(.+)\s*$/i);
  if (descriptionMatch) {
    const sectionName = descriptionMatch[1].trim().replace(/^["“”']|["“”']$/g, "");
    const description = descriptionMatch[2].trim().replace(/^["“”']|["“”']$/g, "");
    const section = findSectionForAction(sectionName, sections, input.currentSection, input.currentPhase?._id);
    if (section && description) {
      const action: AssistantChatAction = {
        id: `assistant-update-section-${Date.now()}`,
        kind: "UPDATE_SECTION",
        label: "Update Section Description",
        summary: `Update the description for ${section.title}`,
        taskId: section._id,
        payload: {
          description
        }
      };
      return {
        actions: [action],
        answer: `I prepared a section description update for you. Review it below and apply it to update ${section.title}.`,
        sourceIds: [`task.${section._id}`]
      };
    }
  }

  return { actions: [] as AssistantChatAction[], answer: "", sourceIds: [] as string[] };
}

function buildSourceRecord(input: AssistantChatSource & { body: string; createdAt?: string | Date | null; priority?: number }) {
  const createdAtValue = input.createdAt ? new Date(input.createdAt).getTime() : undefined;
  const searchText = `${input.kind} ${input.title} ${input.subtitle ?? ""} ${input.body}`.toLowerCase();

  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    subtitle: input.subtitle,
    body: input.body,
    createdAt: Number.isFinite(createdAtValue) ? createdAtValue : undefined,
    priority: input.priority ?? 0,
    searchText
  } satisfies AssistantSourceRecord;
}

function buildTopCategorySummary(expenses: Array<{ category?: string; amount?: number }>) {
  const totals = new Map<string, number>();

  for (const expense of expenses) {
    const category = normalizeDashboardCategory(expense.category);
    const current = totals.get(category) ?? 0;
    totals.set(category, current + Number(expense.amount ?? 0));
  }

  return Array.from(totals.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([category, total]) => `${category}: ${formatMoney(total)}`)
    .join(" | ");
}

function buildRecentActivitySummary(historyEntries: Array<{ summary?: string; createdAt?: string | Date }>): string {
  return historyEntries
    .slice(0, 6)
    .map((entry) => `${formatDateTime(entry.createdAt)} - ${(entry.summary ?? "").trim()}`)
    .join("\n");
}

function normalizeWorkerRoleLabel(role?: string): string {
  const normalized = (role ?? "").trim().toUpperCase();
  if (!normalized) {
    return "Other";
  }

  if (normalized === "STEEL_MAN" || normalized === "STEELWORKER") {
    return "Steelworker";
  }

  return normalized
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildTradeSpendSummary(
  expenses: Array<{ amount?: number; category?: string; workerRole?: string; workerProfileId?: unknown }>,
  workers: Array<{ _id?: unknown; name?: string }>
) {
  const workerNameById = new Map(workers.map((worker) => [toIdString(worker._id), worker.name?.trim() || ""]));
  const roleTotals = new Map<string, number>();
  const workerTotals = new Map<string, number>();

  for (const expense of expenses) {
    const normalizedCategory = normalizeDashboardCategory(expense.category);
    const hasWorkerRole = typeof expense.workerRole === "string" && expense.workerRole.trim().length > 0 && expense.workerRole !== "OTHER";
    if (normalizedCategory !== "Labour Cost" && !hasWorkerRole) {
      continue;
    }

    const amount = Number(expense.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    const roleLabel = normalizeWorkerRoleLabel(expense.workerRole);
    roleTotals.set(roleLabel, (roleTotals.get(roleLabel) ?? 0) + amount);

    const workerName = workerNameById.get(toIdString(expense.workerProfileId)) ?? "";
    if (workerName) {
      workerTotals.set(workerName, (workerTotals.get(workerName) ?? 0) + amount);
    }
  }

  const roleSummary = Array.from(roleTotals.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([role, total]) => `${role}: ${formatMoney(total, "USD")}`);

  const workerSummary = Array.from(workerTotals.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 20)
    .map(([name, total]) => `${name}: ${formatMoney(total, "USD")}`);

  return {
    roleSummary,
    workerSummary,
    roleTotals,
    workerTotals
  };
}

function isFinanceQuestion(query: string): boolean {
  return /(expense|expenses|spent|spend|paid|pay|payment|payments|cost|costs|labou?r|material|materials|invoice|invoices|vendor|budget|quote|estimate|price|prices|rate|balance|committed|electrician|plumber|carpenter|mason|steelworker|steel man|contractor|worker|workers)/i.test(
    query
  );
}

type FinancialIntent = "budget" | "spend" | "invoice" | "estimate-group" | "task-finance" | "material-price" | "financial-history";

function getFinancialIntents(query: string): Set<FinancialIntent> {
  const loweredQuery = query.toLowerCase();
  const intents = new Set<FinancialIntent>();

  if (/(budget|remaining|available|left|over budget|under budget|burn rate|financial summary|overall cost|total cost)/.test(loweredQuery)) {
    intents.add("budget");
  }

  if (/(expense|expenses|spent|spend|actual cost|actuals|\bcosts?\b|\bpaid\b|paid for|payment made|payments made|cost by|costs by)/.test(loweredQuery)) {
    intents.add("spend");
  }

  if (/(invoice|invoices|payable|open balance|outstanding|amount due|due to|committed|vendor bill|vendor payment)/.test(loweredQuery)) {
    intents.add("invoice");
  }

  if (/(estimate group|grouped estimate|quote|quotation|contractor estimate|contractor quote|package price|package estimate)/.test(loweredQuery)) {
    intents.add("estimate-group");
  }

  if (/(task estimate|task budget|phase estimate|section estimate|task cost|phase cost|section cost|wbs)/.test(loweredQuery)) {
    intents.add("task-finance");
  }

  if (/(material preset|price list|pricelist|unit price|material price|current price|price of|rate for)/.test(loweredQuery)) {
    intents.add("material-price");
  }

  if (/(financial history|money history|recent financial|recent payment|recent expense|cost change|budget change|price change)/.test(loweredQuery)) {
    intents.add("financial-history");
  }

  return intents;
}

function isWorkerSpendQuestion(query: string): boolean {
  return /(how much|total|paid|pay|spent|spend).*(worker|electrician|plumber|carpenter|mason|steelworker|steel man|contractor|labou?rer)|\b(worker|electrician|plumber|carpenter|mason|steelworker|steel man|contractor|labou?rer)\b/i.test(
    query
  );
}

function buildFallbackAssistantAnswer(
  userQuestion: string,
  sources: AssistantSourceRecord[],
  warning?: string,
  model?: string
): AssistantChatResult {
  const visibleSources = sources.slice(0, 5);
  const lines = [
    warning || "OpenAI is unavailable right now, so this is a grounded local answer from your project data.",
    "",
    `Question: ${userQuestion.trim()}`,
    "",
    "Relevant project records:"
  ];

  for (const source of visibleSources) {
    lines.push(`- ${source.title}${source.subtitle ? ` (${source.subtitle})` : ""}: ${clipText(source.body, 180)}`);
  }

  return {
    answer: lines.join("\n"),
    sources: visibleSources.map(({ id, kind, title, subtitle }) => ({ id, kind, title, subtitle })),
    actions: [],
    model: model || env.OPENAI_MODEL,
    usedFallback: true,
    warning
  };
}

function isQwenModel(model?: string): boolean {
  return /^qwen/i.test((model ?? "").trim());
}


function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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

function sourceKindMatchesQuery(kind: string, query: string): boolean {
  const loweredKind = kind.toLowerCase();
  const loweredQuery = query.toLowerCase();

  if (loweredKind === "task" && /(task|tasks|phase|section|wbs|due|overdue|owner|worker|schedule)/.test(loweredQuery)) {
    return true;
  }

  if (
    loweredKind === "expense" &&
    /(expense|expenses|material|materials|labou?r|equipment|land|spent|spend|cost|paid|pay|payment|payments|worker|electrician|plumber|carpenter|mason|steelworker|steel man|contractor)/.test(
      loweredQuery
    )
  ) {
    return true;
  }

  if (loweredKind === "invoice" && /(invoice|invoices|vendor|vendors|payable|committed|payment)/.test(loweredQuery)) {
    return true;
  }

  if (loweredKind === "estimate group" && /(group|estimate group|quote|contractor|package)/.test(loweredQuery)) {
    return true;
  }

  if (loweredKind === "history" && /(history|change|changed|recent|update|updated|deleted)/.test(loweredQuery)) {
    return true;
  }

  if (loweredKind === "worker" && /(worker|workers|team|owner|assigned|resource)/.test(loweredQuery)) {
    return true;
  }

  if (loweredKind === "vendor" && /(vendor|vendors|supplier|suppliers)/.test(loweredQuery)) {
    return true;
  }

  if (loweredKind === "material preset" && /(preset|price list|pricelist|material preset|preset price|unit price|sand|cement|gravel|blocks|steel)/.test(loweredQuery)) {
    return true;
  }

  return false;
}

function buildRetrievalQuery(messages: AssistantChatMessage[], userQuestion: string): string {
  const currentTokens = tokenize(userQuestion);
  const isVagueFollowUp =
    currentTokens.length <= 4 ||
    /^(and|also|but|so|yes|no|okay|ok|seriously|really|what about)\b/i.test(userQuestion.trim()) ||
    /\b(it|that|those|them|there|this one|the same)\b/i.test(userQuestion);

  if (!isVagueFollowUp) {
    return userQuestion;
  }

  const priorUserQuestion = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim() !== userQuestion.trim())?.content;

  return priorUserQuestion ? `${priorUserQuestion}\nFollow-up: ${userQuestion}` : userQuestion;
}

function selectRelevantSources(sources: AssistantSourceRecord[], query: string, activeTab?: string) {
  const loweredQuery = query.toLowerCase();
  const tokens = tokenize(query);
  const wantsRecent = /(recent|latest|today|last|newest)/.test(loweredQuery);
  const financeQuestion = isFinanceQuestion(query);
  const financialIntents = getFinancialIntents(query);
  const workerSpendQuestion = isWorkerSpendQuestion(query);
  const scored = sources.map((source) => {
    let score = source.priority;

    if (source.id === "summary.project") {
      score += 120;
    }

    if (activeTab && source.searchText.includes(activeTab.toLowerCase().replace(/-/g, " "))) {
      score += 10;
    }

    if (sourceKindMatchesQuery(source.kind, loweredQuery)) {
      score += 30;
    }

    if (financeQuestion && source.kind === "task" && !financialIntents.has("task-finance")) {
      score -= 100;
    }

    if (workerSpendQuestion && source.kind === "task") {
      score -= 120;
    }

    if (workerSpendQuestion && (source.id === "summary.labour-by-role" || source.id === "summary.labour-by-worker")) {
      score += 180;
    }

    if (financeQuestion && source.id === "summary.tasks") {
      score -= 140;
    }

    if (financialIntents.has("budget") && (source.id === "summary.project" || source.id === "summary.financial")) {
      score += 170;
    }

    if (financialIntents.has("spend") && source.kind === "expense") {
      score += 150;
    }

    if (financialIntents.has("invoice") && source.kind === "invoice") {
      score += 170;
    }

    if (financialIntents.has("estimate-group") && source.kind === "estimate group") {
      score += 190;
    }

    if (financialIntents.has("task-finance") && source.kind === "task") {
      score += 170;
    }

    if (financialIntents.has("material-price") && source.kind === "material preset") {
      score += 190;
    }

    if (financialIntents.has("financial-history") && source.kind === "history") {
      score += 180;
    }

    if (financeQuestion && financialIntents.size > 0) {
      const matchesFinancialAuthority =
        (financialIntents.has("spend") && source.kind === "expense") ||
        (financialIntents.has("invoice") && source.kind === "invoice") ||
        (financialIntents.has("estimate-group") && source.kind === "estimate group") ||
        (financialIntents.has("task-finance") && source.kind === "task") ||
        (financialIntents.has("material-price") && source.kind === "material preset") ||
        (financialIntents.has("financial-history") && source.kind === "history") ||
        (financialIntents.has("budget") && (source.id === "summary.project" || source.id === "summary.financial"));

      if (!matchesFinancialAuthority && source.kind !== "summary") {
        score -= 45;
      }
    }

    for (const token of tokens) {
      if (source.title.toLowerCase().includes(token)) {
        score += 18;
      }

      if ((source.subtitle ?? "").toLowerCase().includes(token)) {
        score += 10;
      }

      const occurrences = source.searchText.split(token).length - 1;
      if (occurrences > 0) {
        score += Math.min(occurrences, 6) * 6;
      }
    }

    if (wantsRecent && source.createdAt) {
      const ageHours = Math.max(1, (Date.now() - source.createdAt) / 3_600_000);
      score += Math.max(0, 16 - Math.log(ageHours + 1) * 4);
    }

    return { source, score };
  });

  const selected = scored
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return (right.source.createdAt ?? 0) - (left.source.createdAt ?? 0);
    })
    .filter((entry) => entry.score > 0)
    .slice(0, 18)
    .map((entry) => entry.source);

  const requiredIds = financeQuestion ? ["summary.project", "summary.financial"] : ["summary.project", "summary.financial", "summary.tasks"];
  if (workerSpendQuestion) {
    requiredIds.push("summary.labour-by-role", "summary.labour-by-worker");
  }
  for (const requiredId of requiredIds) {
    const requiredSource = sources.find((source) => source.id === requiredId);
    if (requiredSource && !selected.some((entry) => entry.id === requiredId)) {
      selected.unshift(requiredSource);
    }
  }

  return selected.slice(0, 18);
}

async function callOpenAiAssistant(input: {
  messages: AssistantChatMessage[];
  activeTab?: string;
  sources: AssistantSourceRecord[];
  model?: string;
}): Promise<OpenAiAssistantResponse | null> {
  const provider = resolveAssistantProvider(input.model);
  if (!provider.apiKey) {
    return null;
  }

  const sourceText = input.sources
    .map(
      (source) =>
        `[${source.id}] ${source.kind.toUpperCase()} | ${source.title}${source.subtitle ? ` | ${source.subtitle}` : ""}\n${source.body}`
    )
    .join("\n\n");

  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are Construction OS Project Assistant for a construction finance and execution app. " +
            "You are read-only. Never claim to have changed data. " +
            "Answer only from the provided database sources. If the sources do not contain the answer, say that clearly. " +
            "Return strict JSON with keys answer and sourceIds. " +
            "answer should be concise, accurate, and practical. " +
            "sourceIds must be an array of the source IDs you actually used."
        },
        {
          role: "system",
          content:
            `Current app tab: ${input.activeTab ?? "unknown"}.\n` +
            "Prefer exact values, dates, statuses, and currencies. " +
            "Choose the authoritative financial source for the question: expenses are actual spend, invoices are vendor bills and open commitments, estimate groups are contractor quotes and grouped estimate payments, tasks are task/phase/section estimates and rollups, material presets are current unit prices, and project/financial summaries are overall budget totals. " +
            "Do not answer a specific financial question from a task or generic summary when the matching detailed financial records are available. " +
            "When records disagree, explain the difference in what they measure instead of silently choosing one. " +
            "When mentioning money, include both USD and JMD whenever the sources provide enough information. " +
            "Prefer stored JMD amounts and stored exchange-rate dates when they exist on the record. " +
            "If only USD is stored, use the provided record-date conversion notes from the sources. " +
            "If a question asks for reasoning or comparison, do the reasoning from the supplied data. " +
            "Use prose for short direct answers, but if the answer contains multiple distinct records, changes, transactions, invoices, tasks, or categories, format them as bullet points. " +
            "For recent change summaries and financial change summaries, prefer a short lead sentence followed by one bullet per change. " +
            "When using bullet points, put each bullet on its own new line and begin it with '- '. " +
            "Put the most important label and number near the start of each bullet so the answer is easy to scan. " +
            "Do not bury multi-item answers in one paragraph when a list would be clearer."
        },
        {
          role: "system",
          content: `Available project database sources:\n\n${sourceText}`
        },
        ...input.messages.map((message) => ({
          role: message.role,
          content: message.content.trim()
        }))
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

    const providerLabelByProvider: Record<AssistantProvider, string> = {
      openai: "OpenAI",
      qwen: "Qwen",
      deepseek: "DeepSeek"
    };
    const providerLabel = providerLabelByProvider[provider.provider];
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

  return normalizeAssistantResponse(JSON.parse(extractJsonString(rawText)));
}

export async function answerProjectAssistantQuestion(input: {
  messages: AssistantChatMessage[];
  activeTab?: string;
  model?: string;
}): Promise<AssistantChatResult> {
  const provider = resolveAssistantProvider(input.model);
  const userQuestion = [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const retrievalQuery = buildRetrievalQuery(input.messages, userQuestion || "project overview");
  const trimmedMessages = input.messages
    .slice(-10)
    .map((message) => ({ role: message.role, content: clipText(message.content, 4000) }))
    .filter((message) => message.content.length > 0);

  const [project, taskSnapshot, expenses, invoices, estimateGroups, historyEntries, workers, vendors, materialPresets] = await Promise.all([
    ensureProject(),
    getTaskHierarchySnapshot(),
    ExpenseModel.find().sort({ createdAt: -1 }).lean(),
    InvoiceModel.find().sort({ createdAt: -1 }).lean(),
    EstimateGroupModel.find().sort({ updatedAt: -1 }).lean(),
    HistoryEntryModel.find().sort({ createdAt: -1 }).limit(160).lean(),
    WorkerProfileModel.find().sort({ name: 1 }).lean(),
    VendorModel.find().sort({ name: 1 }).lean(),
    MaterialPresetModel.find({ removed: false }).sort({ name: 1 }).lean()
  ]);

  const tasks = taskSnapshot.tasks;
  const currentPhase = tasks.find((task) => task._id === taskSnapshot.currentPhaseId);
  const currentSection = tasks.find((task) => task._id === taskSnapshot.currentSectionId);
  const totalSpent = expenses.reduce((sum, expense) => sum + Number(expense.amount ?? 0), 0);
  const unpaidCommitted = invoices.reduce((sum, invoice) => {
    const totalAmount = Number(invoice.totalAmount ?? 0);
    const paidAmount = Number(invoice.paidAmount ?? 0);
    return sum + Math.max(totalAmount - paidAmount, 0);
  }, 0);
  const remainingBudget = Number(project.totalBudget ?? 0) - totalSpent;
  const remainingAfterCommitments = remainingBudget - unpaidCommitted;
  const taskCountSummary = ["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE"].map((status) => ({
    status: formatTaskStatusLabel(status),
    count: tasks.filter((task) => task.nodeType === "TASK" && task.status === status).length
  }));
  const overdueTasks = tasks.filter((task) => {
    if (task.nodeType !== "TASK" || task.status === "DONE" || !task.dueDate) {
      return false;
    }

    const dueDate = new Date(task.dueDate);
    return !Number.isNaN(dueDate.getTime()) && dueDate.getTime() < Date.now();
  });

  const estimateGroupTaskTitles = new Map<string, string>();
  for (const task of tasks) {
    estimateGroupTaskTitles.set(task._id, task.title);
  }
  const workerNameById = new Map(workers.map((worker) => [toIdString(worker._id), worker.name?.trim() || ""]));
  const tradeSpendSummary = buildTradeSpendSummary(expenses, workers);
  const taskById = new Map(tasks.map((task) => [task._id, task]));
  const expenseById = new Map(expenses.map((expense) => [toIdString(expense._id), expense]));
  const invoiceById = new Map(invoices.map((invoice) => [toIdString(invoice._id), invoice]));
  const estimateGroupById = new Map(estimateGroups.map((group) => [toIdString(group._id), group]));
  const historyById = new Map(historyEntries.map((entry) => [entry.historyId, entry]));

  const sources: AssistantSourceRecord[] = [];

  sources.push(
    buildSourceRecord({
      id: "summary.project",
      kind: "summary",
      title: `${project.name} project summary`,
      subtitle: project.phase,
      priority: 180,
      body: [
        `Project: ${project.name}`,
        `Current phase: ${currentPhase?.title ?? project.phase}`,
        `Current section: ${currentSection?.title ?? "--"}`,
        `Budget: ${formatMoney(project.totalBudget, project.currency || "USD")}`,
        `Spent: ${formatMoney(totalSpent, project.currency || "USD")}`,
        `Committed: ${formatMoney(unpaidCommitted, project.currency || "USD")}`,
        `Remaining budget: ${formatMoney(remainingBudget, project.currency || "USD")}`,
        `Remaining after commitments: ${formatMoney(remainingAfterCommitments, project.currency || "USD")}`,
        `Project notes: ${clipText(project.notes, 320) || "--"}`
      ].join("\n")
    }),
    buildSourceRecord({
      id: "summary.financial",
      kind: "summary",
      title: "Financial summary",
      subtitle: `${expenses.length} expenses | ${invoices.length} invoices`,
      priority: 140,
      body: [
        `Budget currency: ${project.currency || "USD"}`,
        `Total spent: ${formatMoney(totalSpent, project.currency || "USD")}`,
        `Open committed invoices: ${formatMoney(unpaidCommitted, project.currency || "USD")}`,
        `Category totals: ${buildTopCategorySummary(expenses) || "--"}`,
        `Estimate groups: ${estimateGroups.length}`,
        `Recent financial activity:`,
        buildRecentActivitySummary(
          historyEntries.filter((entry) => entry.moneyImpact).slice(0, 6).map((entry) => ({
            summary: entry.summary,
            createdAt: entry.createdAt
          }))
        ) || "--"
      ].join("\n")
    }),
    buildSourceRecord({
      id: "summary.labour-by-role",
      kind: "summary",
      title: "Labour spend by trade",
      subtitle: `${tradeSpendSummary.roleTotals.size} trade buckets`,
      priority: 150,
      body:
        tradeSpendSummary.roleSummary.length > 0
          ? tradeSpendSummary.roleSummary.join("\n")
          : "No labour expenses with worker roles recorded."
    }),
    buildSourceRecord({
      id: "summary.labour-by-worker",
      kind: "summary",
      title: "Labour spend by worker",
      subtitle: `${tradeSpendSummary.workerTotals.size} workers with spend`,
      priority: 150,
      body:
        tradeSpendSummary.workerSummary.length > 0
          ? tradeSpendSummary.workerSummary.join("\n")
          : "No worker-linked labour expenses recorded."
    }),
    buildSourceRecord({
      id: "summary.tasks",
      kind: "summary",
      title: "Task execution summary",
      subtitle: `${tasks.filter((task) => task.nodeType === "TASK").length} task items`,
      priority: 140,
      body: [
        `Current phase: ${currentPhase?.title ?? "--"}`,
        `Current section: ${currentSection?.title ?? "--"}`,
        `Task counts: ${taskCountSummary.map((entry) => `${entry.status}: ${entry.count}`).join(" | ")}`,
        `Overdue tasks: ${overdueTasks.length}`,
        `Top overdue items: ${
          overdueTasks
            .slice(0, 5)
            .map((task) => `${task.wbsId ?? "--"} ${task.title} (${formatDate(task.dueDate)})`)
            .join(" | ") || "--"
        }`
      ].join("\n")
    }),
    buildSourceRecord({
      id: "summary.history",
      kind: "summary",
      title: "Recent change summary",
      subtitle: `${historyEntries.length} history items sampled`,
      priority: 100,
      body: buildRecentActivitySummary(historyEntries) || "--"
    }),
    buildSourceRecord({
      id: "summary.workers",
      kind: "summary",
      title: "Team summary",
      subtitle: `${workers.length} workers`,
      priority: 70,
      body:
        workers.length > 0
          ? workers
              .slice(0, 20)
              .map((worker) => `${worker.name} | ${worker.role} | ${worker.company || "--"} | ${worker.isActive ? "Active" : "Inactive"}`)
              .join("\n")
          : "No workers recorded."
    }),
    buildSourceRecord({
      id: "summary.vendors",
      kind: "summary",
      title: "Vendor summary",
      subtitle: `${vendors.length} vendors`,
      priority: 60,
      body: vendors.length > 0 ? vendors.map((vendor) => vendor.name).join("\n") : "No vendors recorded."
    }),
    buildSourceRecord({
      id: "summary.material-presets",
      kind: "summary",
      title: "Material preset summary",
      subtitle: `${materialPresets.length} presets`,
      priority: 75,
      body:
        materialPresets.length > 0
          ? materialPresets
              .slice(0, 16)
              .map((preset) => `${preset.name} | ${preset.unit || "--"} | ${formatMoney(Number(preset.unitPrice ?? 0))}`)
              .join("\n")
          : "No material presets recorded."
    })
  );

  for (const task of tasks) {
    sources.push(
      buildSourceRecord({
        id: `task.${task._id}`,
        kind: "task",
        title: `${task.wbsId ?? "--"} ${task.title}`,
        subtitle: [task.phase, task.section, formatTaskStatusLabel(task.status)].filter(Boolean).join(" | "),
        createdAt: task.actualEndDate ?? task.actualStartDate ?? task.dueDate,
        priority: task.nodeType === "TASK" ? 42 : task.nodeType === "SECTION" ? 28 : 24,
        body: [
          `Node type: ${task.nodeType}`,
          `Phase: ${task.phase}`,
          `Section: ${task.section || "--"}`,
          `Status: ${formatTaskStatusLabel(task.status)}`,
          `Owner: ${task.owner || "--"}`,
          `Resources: ${task.resources?.join(", ") || "--"}`,
          `Due date: ${formatDate(task.dueDate)}`,
          `Actual start: ${formatDate(task.actualStartDate)}`,
          `Actual end: ${formatDate(task.actualEndDate)}`,
          `Priority: ${task.priority}`,
          `Estimate: ${formatMoney(task.estimateAmount || 0)}`,
          `Spent: ${formatMoney(task.financials.rolledSpent || 0)}`,
          `Committed: ${formatMoney(task.financials.rolledCommitted || 0)}`,
          `Remaining: ${formatMoney(task.financials.remaining || 0)}`,
          `Progress: ${task.progress.completedTasks}/${task.progress.totalTasks} (${task.progress.percentComplete}%)`,
          `Predecessor WBS: ${task.predecessorWbsId || "--"}`,
          `Description: ${clipText(task.description, 500) || "--"}`
        ].join("\n")
      })
    );
  }

  for (const expense of expenses) {
    const workerName = workerNameById.get(toIdString(expense.workerProfileId)) || "";
    sources.push(
      buildSourceRecord({
        id: `expense.${toIdString(expense._id)}`,
        kind: "expense",
        title: expense.name ?? "Expense",
        subtitle: `${normalizeDashboardCategory(expense.category)} | ${workerName || normalizeWorkerRoleLabel(expense.workerRole)} | ${formatMoney(Number(expense.amount ?? 0))}`,
        createdAt: expense.createdAt ?? expense.date,
        priority: 24,
        body: [
          `Category: ${normalizeDashboardCategory(expense.category)}`,
          `Amount: ${formatMoney(Number(expense.amount ?? 0))}`,
          `Date: ${formatDate(expense.date)}`,
          `Vendor: ${expense.vendor || "--"}`,
          `Phase: ${expense.phase || "--"}`,
          `Section: ${expense.section || "--"}`,
          `Task: ${expense.subsection || "--"}`,
          `Source: ${expense.source || "manual"}`,
          `Worker: ${workerName || "--"}`,
          `Worker role: ${expense.workerRole || "--"}`,
          `Notes: ${clipText(expense.notes, 320) || "--"}`
        ].join("\n")
      })
    );
  }

  for (const invoice of invoices) {
    const openBalance = Math.max(Number(invoice.totalAmount ?? 0) - Number(invoice.paidAmount ?? 0), 0);
    sources.push(
      buildSourceRecord({
        id: `invoice.${toIdString(invoice._id)}`,
        kind: "invoice",
        title: `Invoice ${invoice.invoiceNumber}`,
        subtitle: `${invoice.vendor} | ${invoice.status}`,
        createdAt: invoice.createdAt ?? invoice.issueDate,
        priority: 26,
        body: [
          `Vendor: ${invoice.vendor}`,
          `Invoice number: ${invoice.invoiceNumber}`,
          `Status: ${invoice.status}`,
          `Issue date: ${formatDate(invoice.issueDate)}`,
          `Due date: ${formatDate(invoice.dueDate)}`,
          `Total amount: ${formatMoney(Number(invoice.totalAmount ?? 0), invoice.currency || "USD")}`,
          `Paid amount: ${formatMoney(Number(invoice.paidAmount ?? 0), invoice.currency || "USD")}`,
          `Open balance: ${formatMoney(openBalance, invoice.currency || "USD")}`,
          `Phase: ${invoice.phase || "--"}`,
          `Section: ${invoice.section || "--"}`,
          `Task: ${invoice.subsection || "--"}`,
          `Items: ${
            Array.isArray(invoice.items) && invoice.items.length > 0
              ? invoice.items
                  .slice(0, 6)
                  .map((item) => `${item.description} (${item.category}) ${formatMoney(Number(item.amount ?? 0), invoice.currency || "USD")}`)
                  .join(" | ")
              : "--"
          }`,
          `Notes: ${clipText(invoice.notes, 320) || "--"}`
        ].join("\n")
      })
    );
  }

  for (const estimateGroup of estimateGroups) {
    const paymentEntries = Array.isArray(estimateGroup.paymentEntries) ? estimateGroup.paymentEntries : [];
    const paidAmount = paymentEntries.reduce((sum, entry) => sum + Number(entry.amountUsd ?? 0), 0);
    const remainingAmount = Math.max(Number(estimateGroup.totalAmount ?? 0) - paidAmount, 0);
    sources.push(
      buildSourceRecord({
        id: `estimate-group.${toIdString(estimateGroup._id)}`,
        kind: "estimate group",
        title: estimateGroup.name ?? "Grouped Estimate",
        subtitle: `${estimateGroup.phase} | ${estimateGroup.section}`,
        createdAt: estimateGroup.updatedAt ?? estimateGroup.createdAt,
        priority: 28,
        body: [
          `Group name: ${estimateGroup.name}`,
          `Phase: ${estimateGroup.phase}`,
          `Section: ${estimateGroup.section}`,
          `Entry currency: ${estimateGroup.entryCurrency || "USD"}`,
          `Total quote USD: ${formatMoney(Number(estimateGroup.totalAmount ?? 0))}`,
          `Entry total: ${formatMoney(Number(estimateGroup.entryTotalAmount ?? 0), estimateGroup.entryCurrency || "USD")}`,
          `Paid USD: ${formatMoney(paidAmount)}`,
          `Remaining USD: ${formatMoney(remainingAmount)}`,
          `Tasks: ${
            Array.isArray(estimateGroup.taskIds) && estimateGroup.taskIds.length > 0
              ? estimateGroup.taskIds.map((taskId) => estimateGroupTaskTitles.get(toIdString(taskId)) ?? toIdString(taskId)).join(" | ")
              : "--"
          }`
        ].join("\n")
      })
    );
  }

  for (const historyEntry of historyEntries) {
    const moneyLine = historyEntry.moneyImpact
      ? `Money impact: ${historyEntry.moneyImpact.label} ${formatMoney(Number(historyEntry.moneyImpact.before ?? 0), historyEntry.moneyImpact.currency || "USD")} -> ${formatMoney(Number(historyEntry.moneyImpact.after ?? 0), historyEntry.moneyImpact.currency || "USD")} (delta ${formatMoney(Number(historyEntry.moneyImpact.delta ?? 0), historyEntry.moneyImpact.currency || "USD")})`
      : "";

    sources.push(
      buildSourceRecord({
        id: `history.${historyEntry.historyId}`,
        kind: "history",
        title: historyEntry.summary,
        subtitle: `${historyEntry.entityType} | ${historyEntry.action}`,
        createdAt: historyEntry.createdAt,
        priority: 18,
        body: [
          `Entity label: ${historyEntry.entityLabel}`,
          `Actor: ${historyEntry.actor?.name ?? "--"} (${historyEntry.actor?.role ?? "--"})`,
          `Created at: ${formatDateTime(historyEntry.createdAt)}`,
          `Scope: ${[historyEntry.scope?.phase, historyEntry.scope?.section, historyEntry.scope?.subsection].filter(Boolean).join(" / ") || "--"}`,
          moneyLine,
          `Narrative: ${clipText(historyEntry.narrative?.detail, 340) || "--"}`
        ]
          .filter(Boolean)
          .join("\n")
      })
    );
  }

  for (const worker of workers) {
    sources.push(
      buildSourceRecord({
        id: `worker.${toIdString(worker._id)}`,
        kind: "worker",
        title: worker.name,
        subtitle: `${worker.role} | ${worker.company || "Independent"}`,
        createdAt: worker.updatedAt ?? worker.createdAt,
        priority: 14,
        body: [
          `Role: ${worker.role}`,
          `Company: ${worker.company || "--"}`,
          `Phone: ${worker.phone || "--"}`,
          `Email: ${worker.email || "--"}`,
          `Status: ${worker.isActive ? "Active" : "Inactive"}`,
          `Notes: ${clipText(worker.notes, 220) || "--"}`
        ].join("\n")
      })
    );
  }

  for (const vendor of vendors) {
    sources.push(
      buildSourceRecord({
        id: `vendor.${toIdString(vendor._id)}`,
        kind: "vendor",
        title: vendor.name,
        subtitle: "Vendor",
        createdAt: vendor.createdAt,
        priority: 10,
        body: `Vendor name: ${vendor.name}`
      })
    );
  }

  for (const preset of materialPresets) {
    sources.push(
      buildSourceRecord({
        id: `material-preset.${preset.key}`,
        kind: "material preset",
        title: preset.name,
        subtitle: `${preset.unit || "--"} | ${formatMoney(Number(preset.unitPrice ?? 0))}`,
        createdAt: preset.updatedAt ?? preset.createdAt,
        priority: 20,
        body: [
          `Material: ${preset.name}`,
          `Unit: ${preset.unit || "--"}`,
          await buildUsdJmdMoneyText({
            label: "Current preset price",
            usdAmount: Number(preset.unitPrice ?? 0),
            date: preset.updatedAt ?? preset.createdAt,
            cache: new Map()
          }),
          `Recent price history: ${
            Array.isArray(preset.priceHistory) && preset.priceHistory.length > 0
              ? preset.priceHistory
                  .slice(-5)
                  .reverse()
                  .map((entry: any) =>
                    entry.previousUnitPrice !== undefined
                      ? `${formatDate(entry.changedAt)}: ${formatMoney(Number(entry.previousUnitPrice ?? 0))} -> ${formatMoney(Number(entry.unitPrice ?? 0))}`
                      : `${formatDate(entry.changedAt)}: ${formatMoney(Number(entry.unitPrice ?? 0))}`
                  )
                  .join(" | ")
              : "--"
          }`
        ].join("\n")
      })
    );
  }

  const selectedSources = selectRelevantSources(sources, retrievalQuery, input.activeTab);
  const jmdQuoteCache: JmdQuoteCache = new Map();
  const selectedSourcesWithCurrencyContext = await Promise.all(
    selectedSources.map(async (source) => {
      if (source.id === "summary.project") {
        return {
          ...source,
          body: [
            `Project: ${project.name}`,
            `Current phase: ${currentPhase?.title ?? project.phase}`,
            `Current section: ${currentSection?.title ?? "--"}`,
            await buildUsdJmdMoneyText({
              label: "Budget",
              usdAmount: Number(project.totalBudget ?? 0),
              date: new Date(),
              cache: jmdQuoteCache
            }),
            await buildUsdJmdMoneyText({
              label: "Spent",
              usdAmount: totalSpent,
              date: new Date(),
              cache: jmdQuoteCache
            }),
            await buildUsdJmdMoneyText({
              label: "Committed",
              usdAmount: unpaidCommitted,
              date: new Date(),
              cache: jmdQuoteCache
            }),
            await buildUsdJmdMoneyText({
              label: "Remaining budget",
              usdAmount: remainingBudget,
              date: new Date(),
              cache: jmdQuoteCache
            }),
            await buildUsdJmdMoneyText({
              label: "Remaining after commitments",
              usdAmount: remainingAfterCommitments,
              date: new Date(),
              cache: jmdQuoteCache
            }),
            `Project notes: ${clipText(project.notes, 320) || "--"}`
          ].join("\n")
        };
      }

      if (source.id === "summary.financial") {
        return {
          ...source,
          body: [
            `Budget currency: ${project.currency || "USD"}`,
            await buildUsdJmdMoneyText({
              label: "Total spent",
              usdAmount: totalSpent,
              date: new Date(),
              cache: jmdQuoteCache
            }),
            await buildUsdJmdMoneyText({
              label: "Open committed invoices",
              usdAmount: unpaidCommitted,
              date: new Date(),
              cache: jmdQuoteCache
            }),
            `Category totals: ${buildTopCategorySummary(expenses) || "--"}`,
            `Estimate groups: ${estimateGroups.length}`,
            `Recent financial activity:`,
            buildRecentActivitySummary(
              historyEntries.filter((entry) => entry.moneyImpact).slice(0, 6).map((entry) => ({
                summary: entry.summary,
                createdAt: entry.createdAt
              }))
            ) || "--"
          ].join("\n")
        };
      }

      if (source.id === "summary.labour-by-role") {
        const lines =
          tradeSpendSummary.roleTotals.size > 0
            ? await Promise.all(
                Array.from(tradeSpendSummary.roleTotals.entries())
                  .sort((left, right) => right[1] - left[1])
                  .map(([role, total]) =>
                    buildUsdJmdMoneyText({
                      label: role,
                      usdAmount: total,
                      date: new Date(),
                      cache: jmdQuoteCache
                    })
                  )
              )
            : ["No labour expenses with worker roles recorded."];

        return {
          ...source,
          body: lines.join("\n")
        };
      }

      if (source.id === "summary.labour-by-worker") {
        const lines =
          tradeSpendSummary.workerTotals.size > 0
            ? await Promise.all(
                Array.from(tradeSpendSummary.workerTotals.entries())
                  .sort((left, right) => right[1] - left[1])
                  .map(([workerName, total]) =>
                    buildUsdJmdMoneyText({
                      label: workerName,
                      usdAmount: total,
                      date: new Date(),
                      cache: jmdQuoteCache
                    })
                  )
              )
            : ["No worker-linked labour expenses recorded."];

        return {
          ...source,
          body: lines.join("\n")
        };
      }

      if (source.id.startsWith("task.")) {
        const task = taskById.get(source.id.slice("task.".length));
        if (!task) {
          return source;
        }

        return {
          ...source,
          body: [
            `Node type: ${task.nodeType}`,
            `Phase: ${task.phase}`,
            `Section: ${task.section || "--"}`,
            `Status: ${formatTaskStatusLabel(task.status)}`,
            `Owner: ${task.owner || "--"}`,
            `Resources: ${task.resources?.join(", ") || "--"}`,
            `Due date: ${formatDate(task.dueDate)}`,
            `Actual start: ${formatDate(task.actualStartDate)}`,
            `Actual end: ${formatDate(task.actualEndDate)}`,
            `Priority: ${task.priority}`,
            await buildUsdJmdMoneyText({
              label: "Estimate",
              usdAmount: task.estimateAmount || 0,
              date: new Date(),
              cache: jmdQuoteCache
            }),
            await buildUsdJmdMoneyText({
              label: "Spent",
              usdAmount: task.financials.rolledSpent || 0,
              date: new Date(),
              cache: jmdQuoteCache
            }),
            await buildUsdJmdMoneyText({
              label: "Committed",
              usdAmount: task.financials.rolledCommitted || 0,
              date: new Date(),
              cache: jmdQuoteCache
            }),
            await buildUsdJmdMoneyText({
              label: "Remaining",
              usdAmount: task.financials.remaining || 0,
              date: new Date(),
              cache: jmdQuoteCache
            }),
            `Progress: ${task.progress.completedTasks}/${task.progress.totalTasks} (${task.progress.percentComplete}%)`,
            `Predecessor WBS: ${task.predecessorWbsId || "--"}`,
            `Description: ${clipText(task.description, 500) || "--"}`
          ].join("\n")
        };
      }

      if (source.id.startsWith("expense.")) {
        const expense = expenseById.get(source.id.slice("expense.".length));
        if (!expense) {
          return source;
        }
        const workerName = workerNameById.get(toIdString(expense.workerProfileId)) || "";

        return {
          ...source,
          body: [
            `Category: ${normalizeDashboardCategory(expense.category)}`,
            await buildUsdJmdMoneyText({
              label: "Amount",
              usdAmount: Number(expense.amount ?? 0),
              date: expense.date ?? expense.createdAt,
              cache: jmdQuoteCache
            }),
            `Date: ${formatDate(expense.date)}`,
            `Vendor: ${expense.vendor || "--"}`,
            `Phase: ${expense.phase || "--"}`,
            `Section: ${expense.section || "--"}`,
            `Task: ${expense.subsection || "--"}`,
            `Source: ${expense.source || "manual"}`,
            `Worker: ${workerName || "--"}`,
            `Worker role: ${expense.workerRole || "--"}`,
            `Notes: ${clipText(expense.notes, 320) || "--"}`
          ].join("\n")
        };
      }

      if (source.id.startsWith("invoice.")) {
        const invoice = invoiceById.get(source.id.slice("invoice.".length));
        if (!invoice) {
          return source;
        }

        const openBalance = Math.max(Number(invoice.totalAmount ?? 0) - Number(invoice.paidAmount ?? 0), 0);
        const savedRate = Number(invoice.usdToEntryRate ?? 1);
        const issueDate = invoice.issueDate ?? invoice.exchangeRateDate ?? invoice.createdAt;
        const hasSavedJmd = (invoice.entryCurrency ?? "USD").toUpperCase() === "JMD";
        const itemText =
          Array.isArray(invoice.items) && invoice.items.length > 0
            ? await Promise.all(
                invoice.items.slice(0, 6).map(async (item) => {
                  const amountUsd = Number(item.amount ?? 0);
                  const amountText = hasSavedJmd
                    ? await buildUsdJmdMoneyText({
                        label: `${item.description} (${item.category})`,
                        usdAmount: amountUsd,
                        cache: jmdQuoteCache,
                        savedJmdAmount: Number((amountUsd * savedRate).toFixed(2)),
                        savedRate,
                        savedRateDate: invoice.exchangeRateDate ?? issueDate
                      })
                    : await buildUsdJmdMoneyText({
                        label: `${item.description} (${item.category})`,
                        usdAmount: amountUsd,
                        date: issueDate,
                        cache: jmdQuoteCache
                      });
                  return amountText;
                })
              ).then((lines) => lines.join(" | "))
            : "--";

        return {
          ...source,
          body: [
            `Vendor: ${invoice.vendor}`,
            `Invoice number: ${invoice.invoiceNumber}`,
            `Status: ${invoice.status}`,
            `Issue date: ${formatDate(invoice.issueDate)}`,
            `Due date: ${formatDate(invoice.dueDate)}`,
            await buildUsdJmdMoneyText({
              label: "Total amount",
              usdAmount: Number(invoice.totalAmount ?? 0),
              date: issueDate,
              cache: jmdQuoteCache,
              savedJmdAmount: hasSavedJmd ? Number((Number(invoice.totalAmount ?? 0) * savedRate).toFixed(2)) : undefined,
              savedRate: hasSavedJmd ? savedRate : undefined,
              savedRateDate: hasSavedJmd ? invoice.exchangeRateDate ?? issueDate : undefined
            }),
            await buildUsdJmdMoneyText({
              label: "Paid amount",
              usdAmount: Number(invoice.paidAmount ?? 0),
              date: issueDate,
              cache: jmdQuoteCache,
              savedJmdAmount: hasSavedJmd ? Number((Number(invoice.paidAmount ?? 0) * savedRate).toFixed(2)) : undefined,
              savedRate: hasSavedJmd ? savedRate : undefined,
              savedRateDate: hasSavedJmd ? invoice.exchangeRateDate ?? issueDate : undefined
            }),
            await buildUsdJmdMoneyText({
              label: "Open balance",
              usdAmount: openBalance,
              date: issueDate,
              cache: jmdQuoteCache,
              savedJmdAmount: hasSavedJmd ? Number((openBalance * savedRate).toFixed(2)) : undefined,
              savedRate: hasSavedJmd ? savedRate : undefined,
              savedRateDate: hasSavedJmd ? invoice.exchangeRateDate ?? issueDate : undefined
            }),
            `Phase: ${invoice.phase || "--"}`,
            `Section: ${invoice.section || "--"}`,
            `Task: ${invoice.subsection || "--"}`,
            `Items: ${itemText}`,
            `Notes: ${clipText(invoice.notes, 320) || "--"}`
          ].join("\n")
        };
      }

      if (source.id.startsWith("estimate-group.")) {
        const estimateGroup = estimateGroupById.get(source.id.slice("estimate-group.".length));
        if (!estimateGroup) {
          return source;
        }

        const paymentEntries = Array.isArray(estimateGroup.paymentEntries) ? estimateGroup.paymentEntries : [];
        const paidAmount = paymentEntries.reduce((sum, entry) => sum + Number(entry.amountUsd ?? 0), 0);
        const remainingAmount = Math.max(Number(estimateGroup.totalAmount ?? 0) - paidAmount, 0);
        const entryPaidAmount = paymentEntries.reduce((sum, entry) => sum + Number(entry.entryAmount ?? 0), 0);
        const entryTotalAmount = Number(estimateGroup.entryTotalAmount ?? estimateGroup.totalAmount ?? 0);
        const entryRemainingAmount = Math.max(entryTotalAmount - entryPaidAmount, 0);
        const savedRate = Number(estimateGroup.usdToEntryRate ?? 1);
        const hasSavedJmd = (estimateGroup.entryCurrency ?? "USD").toUpperCase() === "JMD";
        const recentPayments =
          paymentEntries.length > 0
            ? paymentEntries
                .slice(-3)
                .reverse()
                .map((entry) => {
                  const base = `${formatDate(entry.recordedAt)}: ${formatMoney(Number(entry.amountUsd ?? 0), "USD")}`;
                  if ((entry.entryCurrency ?? "").toUpperCase() === "JMD") {
                    return `${base} | ${formatMoney(Number(entry.entryAmount ?? 0), "JMD")} (saved at ${formatRate(Number(entry.usdToEntryRate ?? 1))} JMD)`;
                  }

                  return base;
                })
                .join(" | ")
            : "--";

        return {
          ...source,
          body: [
            `Group name: ${estimateGroup.name}`,
            `Phase: ${estimateGroup.phase}`,
            `Section: ${estimateGroup.section}`,
            `Entry currency: ${estimateGroup.entryCurrency || "USD"}`,
            await buildUsdJmdMoneyText({
              label: "Total quote",
              usdAmount: Number(estimateGroup.totalAmount ?? 0),
              date: estimateGroup.exchangeRateDate ?? estimateGroup.updatedAt ?? estimateGroup.createdAt,
              cache: jmdQuoteCache,
              savedJmdAmount: hasSavedJmd ? entryTotalAmount : undefined,
              savedRate: hasSavedJmd ? savedRate : undefined,
              savedRateDate: hasSavedJmd ? estimateGroup.exchangeRateDate : undefined
            }),
            await buildUsdJmdMoneyText({
              label: "Paid total",
              usdAmount: paidAmount,
              date: estimateGroup.exchangeRateDate ?? estimateGroup.updatedAt ?? estimateGroup.createdAt,
              cache: jmdQuoteCache,
              savedJmdAmount: hasSavedJmd ? entryPaidAmount : undefined,
              savedRate: hasSavedJmd ? savedRate : undefined,
              savedRateDate: hasSavedJmd ? estimateGroup.exchangeRateDate : undefined
            }),
            await buildUsdJmdMoneyText({
              label: "Remaining total",
              usdAmount: remainingAmount,
              date: estimateGroup.exchangeRateDate ?? estimateGroup.updatedAt ?? estimateGroup.createdAt,
              cache: jmdQuoteCache,
              savedJmdAmount: hasSavedJmd ? entryRemainingAmount : undefined,
              savedRate: hasSavedJmd ? savedRate : undefined,
              savedRateDate: hasSavedJmd ? estimateGroup.exchangeRateDate : undefined
            }),
            `Recent payments: ${recentPayments}`,
            `Tasks: ${
              Array.isArray(estimateGroup.taskIds) && estimateGroup.taskIds.length > 0
                ? estimateGroup.taskIds.map((taskId) => estimateGroupTaskTitles.get(toIdString(taskId)) ?? toIdString(taskId)).join(" | ")
                : "--"
            }`
          ].join("\n")
        };
      }

      if (source.id.startsWith("history.")) {
        const historyEntry = historyById.get(source.id.slice("history.".length));
        if (!historyEntry) {
          return source;
        }

        const moneyLine = historyEntry.moneyImpact
          ? await (async () => {
              const moneyImpact = historyEntry.moneyImpact!;
              const historyCurrency = String(moneyImpact.currency ?? "USD").toUpperCase();
              const beforeAmount = Number(moneyImpact.before ?? 0);
              const afterAmount = Number(moneyImpact.after ?? 0);

              if (historyCurrency === "JMD") {
                const resolvedRate =
                  Number((historyEntry.after as Record<string, unknown> | undefined)?.usdToEntryRate ?? 0) ||
                  Number((historyEntry.before as Record<string, unknown> | undefined)?.usdToEntryRate ?? 0) ||
                  Number((historyEntry.metadata as Record<string, unknown> | undefined)?.usdToEntryRate ?? 0);
                const resolvedRateDate =
                  ((historyEntry.after as Record<string, unknown> | undefined)?.exchangeRateDate as string | undefined) ??
                  ((historyEntry.before as Record<string, unknown> | undefined)?.exchangeRateDate as string | undefined) ??
                  historyEntry.createdAt;
                const usdAfter = resolvedRate > 0 ? Number((afterAmount / resolvedRate).toFixed(2)) : afterAmount;
                const usdBefore = resolvedRate > 0 ? Number((beforeAmount / resolvedRate).toFixed(2)) : beforeAmount;
                const headline = await buildUsdJmdMoneyText({
                  label: `${moneyImpact.label} impact`,
                  usdAmount: usdAfter,
                  cache: jmdQuoteCache,
                  savedJmdAmount: afterAmount,
                  savedRate: resolvedRate > 0 ? resolvedRate : undefined,
                  savedRateDate: resolvedRateDate
                });

                return `${headline}\nChange: ${formatMoney(usdBefore, "USD")} -> ${formatMoney(usdAfter, "USD")} | ${formatMoney(beforeAmount, "JMD")} -> ${formatMoney(afterAmount, "JMD")}`;
              }

              const headline = await buildUsdJmdMoneyText({
                label: `${moneyImpact.label} impact`,
                usdAmount: afterAmount,
                date: historyEntry.createdAt,
                cache: jmdQuoteCache
              });

              return `${headline}\nChange: ${formatMoney(beforeAmount, historyCurrency || "USD")} -> ${formatMoney(afterAmount, historyCurrency || "USD")} (delta ${formatMoney(Number(moneyImpact.delta ?? 0), historyCurrency || "USD")})`;
            })()
          : "";

        return {
          ...source,
          body: [
            `Entity label: ${historyEntry.entityLabel}`,
            `Actor: ${historyEntry.actor?.name ?? "--"} (${historyEntry.actor?.role ?? "--"})`,
            `Created at: ${formatDateTime(historyEntry.createdAt)}`,
            `Scope: ${[historyEntry.scope?.phase, historyEntry.scope?.section, historyEntry.scope?.subsection].filter(Boolean).join(" / ") || "--"}`,
            moneyLine,
            `Narrative: ${clipText(historyEntry.narrative?.detail, 340) || "--"}`
          ]
            .filter(Boolean)
            .join("\n")
        };
      }

      return source;
    })
  );

  const actionProposal = buildAssistantSectionActions({
    query: userQuestion,
    tasks,
    currentPhase: currentPhase
      ? {
          _id: currentPhase._id,
          title: currentPhase.title,
          wbsId: currentPhase.wbsId
        }
      : undefined,
    currentSection: currentSection
      ? {
          _id: currentSection._id,
          title: currentSection.title,
          phaseTaskId: currentSection.phaseTaskId,
          wbsId: currentSection.wbsId
        }
      : undefined
  });

  if (actionProposal.actions.length > 0) {
    const sourceMap = new Map(selectedSourcesWithCurrencyContext.map((source) => [source.id, source]));
    const resolvedSources = actionProposal.sourceIds
      .map((id) => sourceMap.get(id))
      .filter((source): source is AssistantSourceRecord => Boolean(source));

    return {
      answer: actionProposal.answer,
      sources: (resolvedSources.length > 0 ? resolvedSources : selectedSourcesWithCurrencyContext.slice(0, 3)).map(
        ({ id, kind, title, subtitle }) => ({
          id,
          kind,
          title,
          subtitle
        })
      ),
      actions: actionProposal.actions,
      model: "action-router",
      usedFallback: false
    };
  }

  if (!provider.apiKey) {
    return buildFallbackAssistantAnswer(
      userQuestion,
      selectedSourcesWithCurrencyContext,
      provider.provider === "qwen"
        ? "DASHSCOPE_API_KEY is not configured. Returning a grounded local answer."
        : "OPENAI_API_KEY is not configured. Returning a grounded local answer.",
      provider.model
    );
  }

  try {
    const aiResponse = await callOpenAiAssistant({
      messages: trimmedMessages,
      activeTab: input.activeTab,
      sources: selectedSourcesWithCurrencyContext,
      model: input.model
    });

    if (!aiResponse) {
      return buildFallbackAssistantAnswer(
        userQuestion,
        selectedSourcesWithCurrencyContext,
        "The assistant could not generate a model response. Returning a grounded local answer.",
        provider.model
      );
    }

    const sourceMap = new Map(selectedSourcesWithCurrencyContext.map((source) => [source.id, source]));
    const resolvedSources = aiResponse.sourceIds
      .map((id) => sourceMap.get(id))
      .filter((source): source is AssistantSourceRecord => Boolean(source));

    return {
      answer: aiResponse.answer.trim(),
      sources: (resolvedSources.length > 0 ? resolvedSources : selectedSourcesWithCurrencyContext.slice(0, 5)).map(({ id, kind, title, subtitle }) => ({
        id,
        kind,
        title,
        subtitle
      })),
      actions: [],
      model: provider.model,
      usedFallback: false
    };
  } catch (error) {
    if (error instanceof AssistantProviderError) {
      return buildFallbackAssistantAnswer(userQuestion, selectedSourcesWithCurrencyContext, error.message, provider.model);
    }

    return buildFallbackAssistantAnswer(
      userQuestion,
      selectedSourcesWithCurrencyContext,
      provider.provider === "qwen"
        ? "The assistant could not reach Qwen. Returning a grounded local answer."
        : "The assistant could not reach OpenAI. Returning a grounded local answer.",
      provider.model
    );
  }
}
