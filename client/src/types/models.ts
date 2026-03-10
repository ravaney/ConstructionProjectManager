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
  entityType: "expense" | "task" | "project";
  entityId: string;
  uploadedBy: string;
  createdAt: string;
};

export type FloorPlanPoint = {
  x: number;
  y: number;
};

export type FloorPlanStroke = {
  color: string;
  width: number;
  points: FloorPlanPoint[];
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
  phase: string;
  phaseTaskId?: string;
  section?: string;
  sectionTaskId?: string;
  subsection?: string;
  subsectionTaskId?: string;
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
  phase?: string;
  phaseTaskId?: string;
  section?: string;
  sectionTaskId?: string;
  subsection?: string;
  subsectionTaskId?: string;
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
  phaseTaskId?: string;
  section?: string;
  sectionTaskId?: string;
  subsection?: string;
  subsectionTaskId?: string;
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
  phaseTaskId?: string;
  section?: string;
  sectionTaskId?: string;
  subsection?: string;
  subsectionTaskId?: string;
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
export type TaskNodeType = "PHASE" | "SECTION" | "TASK";

export type TaskFinancials = {
  directSpent: number;
  directCommitted: number;
  rolledSpent: number;
  rolledCommitted: number;
  rolledEstimate: number;
  remaining: number;
};

export type TaskProgress = {
  totalTasks: number;
  completedTasks: number;
  percentComplete: number;
};

export type Task = {
  _id: string;
  title: string;
  description: string;
  phase: string;
  section: string;
  nodeType: TaskNodeType;
  parentTaskId?: string;
  phaseTaskId?: string;
  sectionTaskId?: string;
  status: TaskStatus;
  owner: string;
  dueDate?: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  budgetImpact: number;
  estimateAmount: number;
  sortOrder: number;
  closedAt?: string;
  financials: TaskFinancials;
  progress: TaskProgress;
};

export type TaskInput = {
  title: string;
  description?: string;
  nodeType?: TaskNodeType;
  parentTaskId?: string;
  status?: TaskStatus;
  owner?: string;
  dueDate?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH";
  budgetImpact?: number;
  estimateAmount?: number;
  sortOrder?: number;
};

export type TaskListResponse = {
  tasks: Task[];
  currentPhaseId?: string;
  currentSectionId?: string;
};

export type Project = {
  _id: string;
  name: string;
  phase: string;
  totalBudget: number;
  currency: string;
  notes: string;
  floorPlanMarkup?: {
    strokes: FloorPlanStroke[];
  };
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


