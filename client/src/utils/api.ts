import type {
  AppUser,
  Attachment,
  AuthResponse,
  DashboardSummary,
  Expense,
  ExpenseInput,
  ExpenseTallyDetails,
  Invoice,
  InvoiceInput,
  Project,
  ReportAlert,
  Task,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: buildHeaders(init)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(details || `HTTP ${response.status}`);
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
    const details = await response.text();
    throw new Error(details || `HTTP ${response.status}`);
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

  getInvoices: (status: "ALL" | "UNPAID" | "PARTIALLY_PAID" | "PAID" = "ALL") =>
    request<{ invoices: Invoice[] }>(`/invoices?status=${encodeURIComponent(status)}`),
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
  markInvoicePaid: (id: string, payload?: { paidDate?: string; phase?: string; notes?: string; itemIndexes?: number[] }) =>
    request<{ invoice: Invoice; createdExpenses: number; mergedTallies?: number; ignoredItems?: number; newlyPaidItems?: number; alreadyPaidItems?: number; remainingUnpaidItems?: number }>(`/invoices/${id}/mark-paid`, {
      method: "PATCH",
      body: JSON.stringify(payload ?? {})
    }),

  getTasks: () => request<{ tasks: Task[] }>("/tasks"),
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

  getProject: () => request<{ project: Project }>("/project"),
  updateProject: (payload: { totalBudget: number; name?: string; phase?: string; currency?: string; notes?: string }) =>
    request<{ project: Project }>("/project", {
      method: "PUT",
      body: JSON.stringify(payload)
    }),

  getAttachments: (entityType: "expense" | "task", entityId?: string) => {
    const params = new URLSearchParams({ entityType });
    if (entityId) {
      params.set("entityId", entityId);
    }

    return request<{ attachments: Attachment[] }>(`/attachments?${params.toString()}`);
  },
  uploadAttachment: (payload: { entityType: "expense" | "task"; entityId: string; file: File }) => {
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


