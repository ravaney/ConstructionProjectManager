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

export type MaterialPresetHistoryEntry = {
  unitPrice: number;
  changedAt: string;
  previousUnitPrice?: number;
};

export type MaterialPreset = {
  id: string;
  name: string;
  unit: string;
  unitPrice: number;
  priceHistory: MaterialPresetHistoryEntry[];
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

export type FloorPlanMarkupPlan = {
  attachmentId: string;
  name: string;
  strokes: FloorPlanStroke[];
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
  entryCurrency?: string;
  usdToEntryRate?: number;
  exchangeRateDate?: string;
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
  createdAt: string;
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
  allowPotentialDuplicate?: boolean;
};

export type PotentialDuplicateExpense = {
  expenseId: string;
  name: string;
  amount: number;
  date: string;
  vendor: string;
  phase: string;
  section: string;
  score: number;
  exactMatch: boolean;
  reasons: string[];
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
export type TaskFocusRequest = {
  taskId: string;
  requestKey: string;
};

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
  resources?: string[];
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
  resources?: string[];
  plannedStartDate?: string;
  plannedEndDate?: string;
  actualStartDate?: string;
  actualEndDate?: string;
  dueDate?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH";
  budgetImpact?: number;
  estimateAmount?: number;
  sortOrder?: number;
};

export type EstimateGroup = {
  _id: string;
  name: string;
  totalAmount: number;
  entryTotalAmount: number;
  entryCurrency: string;
  usdToEntryRate: number;
  exchangeRateDate?: string;
  phase: string;
  phaseTaskId: string;
  section: string;
  sectionTaskId: string;
  taskIds: string[];
  paidAmount: number;
  entryPaidAmount: number;
  remainingAmount: number;
  entryRemainingAmount: number;
  paymentEntries: Array<{
    entryAmount: number;
    amountUsd: number;
    entryCurrency: string;
    usdToEntryRate: number;
    exchangeRateDate?: string;
    recordedAt: string;
    expenseId?: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type EstimateGroupInput = {
  name: string;
  totalAmount: number;
  currency?: string;
  taskIds: string[];
};

export type EstimateGroupUpdate = {
  name?: string;
  totalAmount?: number;
  currency?: string;
  recordPayment?: {
    amount: number;
    date?: string;
  };
  taskAllocations?: Array<{
    taskId: string;
    estimateAmount: number;
  }>;
};

export type GeneratedPlanTask = {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: "LOW" | "MEDIUM" | "HIGH";
  estimateAmount?: number;
  resources?: string[];
  wbsId?: string;
  predecessor?: string;
  deliverable?: string;
};

export type GeneratedPlanSection = {
  title: string;
  description?: string;
  status?: TaskStatus;
  owner?: string;
  resources?: string[];
  estimateAmount?: number;
  tasks: GeneratedPlanTask[];
};

export type GeneratedPlanPhase = {
  title: string;
  description?: string;
  status?: TaskStatus;
  owner?: string;
  resources?: string[];
  priority?: "LOW" | "MEDIUM" | "HIGH";
  plannedStartDate?: string;
  plannedEndDate?: string;
  dueDate?: string;
  estimateAmount?: number;
  wbsId?: string;
  sections: GeneratedPlanSection[];
};

export type GeneratedTaskPlan = {
  phases: GeneratedPlanPhase[];
  assumptions: string[];
  verificationQuestions: string[];
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
    plans?: FloorPlanMarkupPlan[];
    strokes?: FloorPlanStroke[];
  };
};

export type JmdRateQuote = {
  sourceCurrency: string;
  targetCurrency: "JMD";
  rateDate: string;
  rate: number;
  source: string;
};

export type AssistantChatMessageRole = "user" | "assistant";

export type AssistantSectionCreateAction = {
  id: string;
  kind: "CREATE_SECTION";
  label: string;
  summary: string;
  payload: TaskInput;
};

export type AssistantSectionUpdateAction = {
  id: string;
  kind: "UPDATE_SECTION";
  label: string;
  summary: string;
  taskId: string;
  payload: Partial<TaskInput>;
};

export type AssistantChatAction = AssistantSectionCreateAction | AssistantSectionUpdateAction;

export type AssistantChatMessage = {
  id: string;
  role: AssistantChatMessageRole;
  content: string;
  sources?: AssistantChatSource[];
  actions?: AssistantChatAction[];
};

export type AssistantChatSource = {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
};

export type AssistantChatResponse = {
  answer: string;
  sources: AssistantChatSource[];
  actions?: AssistantChatAction[];
  model: string;
  usedFallback: boolean;
  warning?: string;
};

export type PhaseAnalysisOperation =
  | {
      id: string;
      kind: "CREATE_SECTION";
      summary: string;
      sectionRef: string;
      title: string;
      description?: string;
      owner?: string;
      status?: TaskStatus;
      afterSectionTaskId?: string;
    }
  | {
      id: string;
      kind: "UPDATE_SECTION";
      summary: string;
      sectionTaskId: string;
      title?: string;
      description?: string;
      owner?: string;
      status?: TaskStatus;
    }
  | {
      id: string;
      kind: "DELETE_SECTION";
      summary: string;
      sectionTaskId: string;
    }
  | {
      id: string;
      kind: "CREATE_TASK";
      summary: string;
      sectionTaskId?: string;
      targetSectionRef?: string;
      title: string;
      description?: string;
      owner?: string;
      status?: TaskStatus;
      dueDate?: string;
      priority?: "LOW" | "MEDIUM" | "HIGH";
      estimateAmount?: number;
      afterTaskId?: string;
    }
  | {
      id: string;
      kind: "UPDATE_TASK";
      summary: string;
      taskId: string;
      title?: string;
      description?: string;
      owner?: string;
      status?: TaskStatus;
      dueDate?: string;
      priority?: "LOW" | "MEDIUM" | "HIGH";
      estimateAmount?: number;
    }
  | {
      id: string;
      kind: "MOVE_TASK";
      summary: string;
      taskId: string;
      targetSectionTaskId?: string;
      targetSectionRef?: string;
      afterTaskId?: string;
      title?: string;
      description?: string;
      owner?: string;
      status?: TaskStatus;
      dueDate?: string;
      priority?: "LOW" | "MEDIUM" | "HIGH";
      estimateAmount?: number;
    }
  | {
      id: string;
      kind: "DELETE_TASK";
      summary: string;
      taskId: string;
    };

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

export type HistoryChangedField = {
  field: string;
  before?: unknown;
  after?: unknown;
};

export type HistoryMoneyImpact = {
  label: string;
  currency: string;
  before: number;
  after: number;
  delta: number;
  jmdConversion?: {
    sourceCurrency: string;
    targetCurrency: "JMD";
    rateDate: string;
    rate: number;
    source: string;
    before: number;
    after: number;
    delta: number;
  };
};

export type HistoryActor = {
  id: string;
  name: string;
  role: string;
};

export type HistoryScope = {
  phase?: string;
  phaseTaskId?: string;
  section?: string;
  sectionTaskId?: string;
  subsection?: string;
  subsectionTaskId?: string;
};

export type HistoryEntry = {
  _id: string;
  historyId: string;
  operationId: string;
  entityType: HistoryEntityType;
  entityId: string;
  entityLabel: string;
  action: HistoryAction;
  summary: string;
  changedFields: HistoryChangedField[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  moneyImpact?: HistoryMoneyImpact;
  actor: HistoryActor;
  scope?: HistoryScope;
  narrative?: {
    detail: string;
    highlights: string[];
    provider: "openai" | "fallback";
  };
  metadata?: Record<string, unknown>;
  createdAt: string;
};


