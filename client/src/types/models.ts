export type UserRole = "OWNER" | "CONTRACTOR";

export type WorkerRole =
  | "PLUMBER"
  | "ELECTRICIAN"
  | "CONTRACTOR"
  | "STEELWORKER"
  | "CARPENTER"
  | "MASON"
  | "LABORER"
  | "OTHER";

export type AppUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
};

export type AuthResponse = {
  user: AppUser;
  token: string;
};

export type Attachment = {
  _id: string;
  fileName: string;
  url: string;
  mimeType: string;
  size: number;
  storage: "cloudinary" | "local";
  publicId?: string;
  entityType: "expense" | "task";
  entityId: string;
  uploadedBy: string;
  createdAt: string;
};

export type ReportAlert = {
  severity: "INFO" | "WARN" | "CRITICAL";
  message: string;
};

export type WorkerProfile = {
  _id: string;
  name: string;
  role: WorkerRole;
  phone: string;
  email: string;
  company: string;
  notes: string;
  isActive: boolean;
};

export type WorkerProfileInput = {
  name: string;
  role: WorkerRole;
  phone?: string;
  email?: string;
  company?: string;
  notes?: string;
  isActive?: boolean;
};

export type Vendor = {
  _id: string;
  name: string;
};

export type VendorInput = {
  name: string;
};

export type InvoiceItem = {
  description: string;
  category: string;
  workerRole: WorkerRole;
  quantity: number;
  unit?: string;
  unitPrice: number;
  amount: number;
  materialLabel?: string;
  trackToTally?: boolean;
  recordOnly?: boolean;
  paid?: boolean;
  paidAt?: string;
};

export type Invoice = {
  _id: string;
  vendor: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  status: "UNPAID" | "PARTIALLY_PAID" | "PAID";
  currency: string;
  notes: string;
  items: InvoiceItem[];
  totalAmount: number;
  paidAmount?: number;
  paidAt?: string;
};

export type InvoiceInput = {
  vendor: string;
  invoiceNumber: string;
  issueDate?: string;
  dueDate: string;
  currency?: string;
  notes?: string;
  items: InvoiceItem[];
};

export type Expense = {
  _id: string;
  name: string;
  category: string;
  amount: number;
  date: string;
  vendor: string;
  phase: string;
  unit: string;
  unitPrice: number;
  quantity: number;
  notes: string;
  source: string;
  workerRole: WorkerRole;
  workerProfileId?: string;
  invoiceId?: string;
  invoiceNumber?: string;
};

export type ExpenseInput = {
  name: string;
  category: string;
  amount: number;
  date?: string;
  vendor?: string;
  phase?: string;
  unit?: string;
  unitPrice?: number;
  quantity?: number;
  notes?: string;
  source?: string;
  workerRole?: WorkerRole;
  workerProfileId?: string;
  invoiceId?: string;
  invoiceNumber?: string;
};

export type MaterialTallyDetailLine = {
  invoiceId: string;
  invoiceNumber: string;
  vendor: string;
  paidAt: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  category: string;
  description: string;
};

export type ExpenseTallyDetails = {
  material: string;
  expense: {
    _id: string;
    name: string;
    category: string;
    unit: string;
    quantity: number;
    amount: number;
  };
  lines: MaterialTallyDetailLine[];
  totals: {
    quantity: number;
    amount: number;
    lineCount: number;
  };
  unmatched: {
    quantity: number;
    amount: number;
  };
};

export type TaskStatus = "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "DONE";

export type Task = {
  _id: string;
  title: string;
  description: string;
  phase: string;
  status: TaskStatus;
  owner: string;
  dueDate?: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  budgetImpact: number;
};

export type TaskInput = {
  title: string;
  description?: string;
  phase?: string;
  status?: TaskStatus;
  owner?: string;
  dueDate?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH";
  budgetImpact?: number;
};

export type Project = {
  _id: string;
  name: string;
  phase: string;
  totalBudget: number;
  currency: string;
  notes: string;
};

export type DashboardSummary = {
  project: Project;
  metrics: {
    totalBudget: number;
    totalSpent: number;
    unpaidCommitted: number;
    unpaidInvoiceCount: number;
    remainingBudget: number;
    remainingAfterCommitments: number;
    burnRate: number;
  };
  categoryTotals: Array<{ category: string; total: number }>;
  monthlySpend: Array<{ month: string; total: number }>;
  taskCounts: Array<{ _id: TaskStatus; count: number }>;
};


