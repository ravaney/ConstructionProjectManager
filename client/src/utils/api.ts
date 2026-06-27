import type {
  AssistantChatMessage,
  AssistantChatResponse,
  AppUser,
  Attachment,
  AuthResponse,
  DashboardSummary,
  EstimateGroup,
  EstimateGroupInput,
  EstimateGroupUpdate,
  Expense,
  ExpenseInput,
  ExpenseTallyDetails,
  GeneratedTaskPlan,
  HistoryAction,
  HistoryEntityType,
  HistoryEntry,
  Invoice,
  InvoiceInput,
  JmdRateQuote,
  MaterialPreset,
  PhaseAnalysisApplyResult,
  PhaseAnalysisOperation,
  PhaseAnalysisPreview,
  PhaseAnalysisSuggestionsResult,
  Project,
  ReportAlert,
  Task,
  TaskListResponse,
  TaskInput,
  UserRole,
  Vendor,
  VendorInput,
  WorkerProfile,
  WorkerProfileInput
} from "../types/models";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";
const TOKEN_KEY = "dream_home_auth_token";

function getApiOrigin(): string {
  return API_BASE.replace(/\/api\/?$/, "");
}

function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setAuthToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearAuthToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function buildHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers ?? {});
  const token = getAuthToken();

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return headers;
}

export class ApiError<T = unknown> extends Error {
  status: number;
  data?: T;
  rawBody: string;

  constructor(message: string, status: number, data?: T, rawBody = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.rawBody = rawBody;
  }
}

export function isApiError<T = unknown>(error: unknown): error is ApiError<T> {
  return error instanceof ApiError;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: buildHeaders(init)
  });

  if (!response.ok) {
    const rawBody = await response.text();
    let data: unknown;

    if (rawBody) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        data = undefined;
      }
    }

    const message =
      typeof data === "object" && data !== null && "message" in data && typeof (data as { message?: unknown }).message === "string"
        ? ((data as { message: string }).message || `HTTP ${response.status}`)
        : rawBody || `HTTP ${response.status}`;

    throw new ApiError(message, response.status, data, rawBody);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: buildHeaders()
  });

  if (!response.ok) {
    const rawBody = await response.text();
    throw new ApiError(rawBody || `HTTP ${response.status}`, response.status, undefined, rawBody);
  }

  return response.blob();
}

export function resolveAssetUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  if (url.startsWith("/")) {
    return `${getApiOrigin()}${url}`;
  }

  return `${getApiOrigin()}/${url}`;
}

export const api = {
  getStoredToken: getAuthToken,
  clearSession: clearAuthToken,

  registerOwner: async (payload: { name: string; email: string; password: string }) => {
    const result = await request<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    setAuthToken(result.token);
    return result;
  },

  login: async (payload: { email: string; password: string }) => {
    const result = await request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    setAuthToken(result.token);
    return result;
  },

  getMe: () => request<{ user: AppUser }>("/auth/me"),
  getUsers: () => request<{ users: AppUser[] }>("/auth/users"),
  createUser: (payload: { name: string; email: string; password: string; role: UserRole }) =>
    request<{ user: AppUser }>("/auth/users", {
      method: "POST",
      body: JSON.stringify(payload)
    }),

  getSummary: () => request<DashboardSummary>("/dashboard/summary"),
  chatWithAssistant: (payload: { messages: Array<Pick<AssistantChatMessage, "role" | "content">>; activeTab?: string; model?: string }) =>
    request<AssistantChatResponse>("/assistant/chat", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  previewPhaseAnalysis: (payload: { phaseTaskId: string; instruction: string; model?: string }) =>
    request<PhaseAnalysisPreview>("/assistant/phase-analysis/preview", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  getPhaseAnalysisSuggestions: (payload: { phaseTaskId: string; model?: string }) =>
    request<PhaseAnalysisSuggestionsResult>("/assistant/phase-analysis/suggestions", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  applyPhaseAnalysis: (payload: { phaseTaskId: string; summary: string; operations: PhaseAnalysisOperation[] }) =>
    request<PhaseAnalysisApplyResult>("/assistant/phase-analysis/apply", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  getProjectFxRate: (currency = "USD", date?: string) => {
    const params = new URLSearchParams({ currency });
    if (date) {
      params.set("date", date);
    }

    return request<{ quote: JmdRateQuote }>(`/project/fx-rate?${params.toString()}`);
  },
  getMaterialPresets: () => request<{ presets: MaterialPreset[] }>("/material-presets"),
  migrateMaterialPresets: (payload: { presets: MaterialPreset[]; removedPresetIds: string[] }) =>
    request<{ presets: MaterialPreset[] }>("/material-presets/migrate", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  createMaterialPreset: (payload: { name: string; unit?: string; unitPrice?: number }) =>
    request<{ preset: MaterialPreset }>("/material-presets", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateMaterialPreset: (id: string, payload: { name?: string; unit?: string; unitPrice?: number }) =>
    request<{ preset: MaterialPreset }>(`/material-presets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  deleteMaterialPreset: (id: string) =>
    request<void>(`/material-presets/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),

  getWorkers: () => request<{ workers: WorkerProfile[] }>("/workers"),
  createWorker: (payload: WorkerProfileInput) =>
    request<{ worker: WorkerProfile }>("/workers", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateWorker: (id: string, payload: Partial<WorkerProfileInput>) =>
    request<{ worker: WorkerProfile }>(`/workers/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  deleteWorker: (id: string) =>
    request<void>(`/workers/${id}`, {
      method: "DELETE"
    }),

  getVendors: () => request<{ vendors: Vendor[] }>("/vendors"),
  createVendor: (payload: VendorInput) =>
    request<{ vendor: Vendor }>("/vendors", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deleteVendor: (id: string) =>
    request<void>(`/vendors/${id}`, {
      method: "DELETE"
    }),

  getExpenses: () => request<{ expenses: Expense[] }>("/expenses"),
  addExpense: (payload: ExpenseInput) =>
    request<{ expense: Expense }>("/expenses", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  reorderTasks: (payload: { sectionTaskId: string; taskIds: string[] }) =>
    request<{ reorderedCount: number }>("/tasks/reorder", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateExpense: (id: string, payload: Partial<ExpenseInput>) =>
    request<{ expense: Expense }>(`/expenses/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  deleteExpense: (id: string) =>
    request<void>(`/expenses/${id}`, {
      method: "DELETE"
    }),
  getExpenseTallyDetails: (id: string) => request<ExpenseTallyDetails>(`/expenses/${id}/tally-details`),
  bulkImportExpenses: (expenses: ExpenseInput[]) =>
    request<{ insertedCount: number }>("/expenses/bulk", {
      method: "POST",
      body: JSON.stringify({ expenses })
    }),
  getHistory: (filters?: {
    entityType?: HistoryEntityType | "ALL";
    action?: HistoryAction | "ALL";
    search?: string;
    moneyOnly?: boolean;
    from?: string;
    to?: string;
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    if (filters?.entityType) {
      params.set("entityType", filters.entityType);
    }
    if (filters?.action) {
      params.set("action", filters.action);
    }
    if (filters?.search?.trim()) {
      params.set("search", filters.search.trim());
    }
    if (typeof filters?.moneyOnly === "boolean") {
      params.set("moneyOnly", String(filters.moneyOnly));
    }
    if (filters?.from) {
      params.set("from", filters.from);
    }
    if (filters?.to) {
      params.set("to", filters.to);
    }
    if (typeof filters?.limit === "number") {
      params.set("limit", String(filters.limit));
    }

    const query = params.toString();
    return request<{ entries: HistoryEntry[] }>(`/history${query ? `?${query}` : ""}`);
  },
  getEstimateGroups: (filters?: { sectionTaskId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.sectionTaskId?.trim()) {
      params.set("sectionTaskId", filters.sectionTaskId.trim());
    }
    const query = params.toString();
    return request<{ estimateGroups: EstimateGroup[]; repairedPaymentExpenseCount?: number }>(`/estimate-groups${query ? `?${query}` : ""}`);
  },
  createEstimateGroup: (payload: EstimateGroupInput) =>
    request<{ estimateGroup: EstimateGroup }>("/estimate-groups", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateEstimateGroup: (id: string, payload: EstimateGroupUpdate) =>
    request<{ estimateGroup: EstimateGroup }>(`/estimate-groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  deleteEstimateGroup: (id: string) =>
    request<void>(`/estimate-groups/${id}`, {
      method: "DELETE"
    }),

  getInvoices: (status: "ALL" | "UNPAID" | "PARTIALLY_PAID" | "PAID" = "ALL") =>
    request<{ invoices: Invoice[] }>(`/invoices?status=${encodeURIComponent(status)}`),
  getNextInvoiceNumber: () => request<{ invoiceNumber: string }>("/invoices/next-number"),
  createInvoice: (payload: InvoiceInput) =>
    request<{ invoice: Invoice }>("/invoices", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateInvoice: (id: string, payload: InvoiceInput) =>
    request<{ invoice: Invoice }>(`/invoices/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  deleteInvoice: (id: string) =>
    request<void>(`/invoices/${id}`, {
      method: "DELETE"
    }),
  markInvoicePaid: (
    id: string,
    payload?: {
      paidDate?: string;
      phase?: string;
      phaseTaskId?: string;
      section?: string;
      sectionTaskId?: string;
      subsection?: string;
      subsectionTaskId?: string;
      notes?: string;
      itemIndexes?: number[];
    }
  ) =>
    request<{ invoice: Invoice; createdExpenses: number; mergedTallies?: number; ignoredItems?: number; newlyPaidItems?: number; alreadyPaidItems?: number; remainingUnpaidItems?: number }>(`/invoices/${id}/mark-paid`, {
      method: "PATCH",
      body: JSON.stringify(payload ?? {})
    }),

  getTasks: () => request<TaskListResponse>("/tasks"),
  addTask: (payload: TaskInput) =>
    request<{ task: Task }>("/tasks", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateTask: (id: string, payload: Partial<TaskInput>) =>
    request<{ task: Task }>(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  deleteTask: (id: string) =>
    request<void>(`/tasks/${id}`, {
      method: "DELETE"
    }),
  clearAllPhases: () =>
    request<{ deleted: { phases: number; sections: number; tasks: number } }>("/tasks/clear-phases", {
      method: "DELETE"
    }),
  generateTaskPlan: (payload: { prompt: string; maxPhases?: number }) =>
    request<{ plan: GeneratedTaskPlan; provider: "openai" | "fallback"; warning?: string }>("/tasks/generate-plan", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  buildTaskPlan: (payload: { plan: GeneratedTaskPlan }) =>
    request<{ created: { phases: number; sections: number; tasks: number } }>("/tasks/build-plan", {
      method: "POST",
      body: JSON.stringify(payload)
    }),

  getProject: () => request<{ project: Project }>("/project"),
  updateProject: (payload: {
    totalBudget?: number;
    name?: string;
    phase?: string;
    currency?: string;
    notes?: string;
    floorPlanMarkup?: {
      plans?: Array<{
        attachmentId: string;
        name: string;
        strokes: Array<{ color: string; width: number; points: Array<{ x: number; y: number }> }>;
      }>;
      strokes?: Array<{ color: string; width: number; points: Array<{ x: number; y: number }> }>;
    };
  }) =>
    request<{ project: Project }>("/project", {
      method: "PUT",
      body: JSON.stringify(payload)
    }),

  getAttachments: (entityType: "expense" | "task" | "project", entityId?: string) => {
    const params = new URLSearchParams({ entityType });
    if (entityId) {
      params.set("entityId", entityId);
    }

    return request<{ attachments: Attachment[] }>(`/attachments?${params.toString()}`);
  },
  uploadAttachment: (payload: { entityType: "expense" | "task" | "project"; entityId: string; file: File }) => {
    const form = new FormData();
    form.set("entityType", payload.entityType);
    form.set("entityId", payload.entityId);
    form.set("file", payload.file);

    return request<{ attachment: Attachment }>("/attachments/upload", {
      method: "POST",
      body: form
    });
  },
  deleteAttachment: (id: string) =>
    request<void>(`/attachments/${id}`, {
      method: "DELETE"
    }),

  getAlerts: () => request<{ generatedAt: string; alerts: ReportAlert[] }>("/reports/alerts"),
  downloadMonthlyCsv: (month: string) => requestBlob(`/reports/monthly.csv?month=${encodeURIComponent(month)}`),
  downloadMonthlyPdf: (month: string) => requestBlob(`/reports/monthly.pdf?month=${encodeURIComponent(month)}`)
};


