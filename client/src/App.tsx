import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthScreen } from "./components/AuthScreen";
import { BudgetOverview } from "./components/BudgetOverview";
import { ExpenseSection } from "./components/ExpenseSection";
import { HistoryPanel } from "./components/HistoryPanel";
import { InvoiceCenter } from "./components/InvoiceCenter";
import { ProjectManagement } from "./components/ProjectManagement";
import { ProjectAssistantWidget } from "./components/ProjectAssistantWidget";
import { ReportsPanel } from "./components/ReportsPanel";
import { TaskAlertDrawer } from "./components/TaskAlertDrawer";
import type { AppUser, DashboardSummary, Expense, ExpenseInput, JmdRateQuote, Project, Task, TaskFocusRequest, TaskInput } from "./types/models";
import { formatCurrency, parseCalendarDate } from "./utils/format";
import { api } from "./utils/api";
import { getCurrentPhase } from "./utils/workBreakdown";

type TabKey = "dashboard" | "expenses" | "invoices" | "reports" | "project-management" | "history";
type SectionKey = "budget" | "management";
type ThemeMode = "dark" | "light";
type IconName =
  | "budget"
  | "management"
  | "dashboard"
  | "expenses"
  | "invoices"
  | "reports"
  | "history"
  | "project"
  | "add"
  | "confirm"
  | "close"
  | "edit"
  | "refresh"
  | "notification"
  | "logout"
  | "sun"
  | "moon";

type TicketAlertSeverity = "TODAY" | "OVERDUE";

type TicketDueAlert = {
  key: string;
  taskId: string;
  title: string;
  phase: string;
  section: string;
  dueDate: string;
  severity: TicketAlertSeverity;
  daysLate: number;
};

type TicketAlertToast = {
  key: string;
  taskId: string;
  severity: TicketAlertSeverity;
  title: string;
  message: string;
};

type TaskDrawerState = {
  taskId: string;
  mode: "edit" | "readonly";
};

const TICKET_DUE_ALERT_SEEN_STORAGE_KEY = "construction_os.ticket_due_alerts_seen.v1";

const tabs: Array<{ key: TabKey; label: string; section: SectionKey; icon: IconName }> = [
  { key: "dashboard", label: "Budget Dashboard", section: "budget", icon: "dashboard" },
  { key: "expenses", label: "Expenses", section: "budget", icon: "expenses" },
  { key: "invoices", label: "Invoices", section: "budget", icon: "invoices" },
  { key: "reports", label: "Reports", section: "budget", icon: "reports" },
  { key: "project-management", label: "Project Management", section: "management", icon: "project" },
  { key: "history", label: "History", section: "management", icon: "history" }
];

function NavIcon({ name }: { name: IconName }) {
  const props = {
    className: "nav-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  switch (name) {
    case "budget":
      return (
        <svg {...props}>
          <path d="M3 7h18" />
          <path d="M6 12h12" />
          <path d="M9 17h6" />
        </svg>
      );
    case "management":
      return (
        <svg {...props}>
          <rect x="3" y="4" width="18" height="16" />
          <path d="M8 8h8" />
          <path d="M8 12h5" />
          <path d="M8 16h3" />
        </svg>
      );
    case "dashboard":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="4" />
          <rect x="14" y="10" width="7" height="11" />
          <rect x="3" y="13" width="7" height="8" />
        </svg>
      );
    case "expenses":
      return (
        <svg {...props}>
          <path d="M4 4h16v16H4z" />
          <path d="M8 8h8" />
          <path d="M8 12h8" />
          <path d="M8 16h5" />
        </svg>
      );
    case "invoices":
      return (
        <svg {...props}>
          <rect x="4" y="4" width="16" height="16" />
          <path d="M8 8h8" />
          <path d="M8 12h8" />
          <path d="M8 16h6" />
        </svg>
      );
    case "reports":
      return (
        <svg {...props}>
          <path d="M6 3h9l3 3v15H6z" />
          <path d="M14 3v4h4" />
          <path d="M9 12h6" />
          <path d="M9 16h4" />
        </svg>
      );
    case "history":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v5l3 2" />
        </svg>
      );
    case "project":
      return (
        <svg {...props}>
          <rect x="3" y="4" width="18" height="16" />
          <path d="M7 8h10" />
          <path d="M7 12h7" />
          <path d="M7 16h4" />
        </svg>
      );
    case "add":
      return (
        <svg {...props}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      );
    case "confirm":
      return (
        <svg {...props}>
          <path d="m5 12 4 4 10-10" />
        </svg>
      );
    case "close":
      return (
        <svg {...props}>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      );
    case "edit":
      return (
        <svg {...props}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...props}>
          <path d="M20 11a8 8 0 1 0 2 5" />
          <path d="M20 4v7h-7" />
        </svg>
      );
    case "notification":
      return (
        <svg {...props}>
          <path d="M15 17h5l-1.4-1.4a2 2 0 0 1-.6-1.4V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
          <path d="M9 17a3 3 0 0 0 6 0" />
        </svg>
      );
    case "logout":
      return (
        <svg {...props}>
          <path d="M9 4H4v16h5" />
          <path d="M16 16l5-4-5-4" />
          <path d="M21 12H9" />
        </svg>
      );
    case "sun":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2.5v2.2" />
          <path d="M12 19.3v2.2" />
          <path d="M4.9 4.9 6.5 6.5" />
          <path d="m17.5 17.5 1.6 1.6" />
          <path d="M2.5 12h2.2" />
          <path d="M19.3 12h2.2" />
          <path d="m4.9 19.1 1.6-1.6" />
          <path d="m17.5 6.5 1.6-1.6" />
        </svg>
      );
    case "moon":
      return (
        <svg {...props}>
          <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.8 7.8 0 1 0 9.5 9.5Z" />
        </svg>
      );
    default:
      return null;
  }
}

const budgetCurrencyFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

function isTabKey(value: string): value is TabKey {
  return tabs.some((tab) => tab.key === value);
}

function readInitialTab(): TabKey {
  if (typeof window === "undefined") {
    return "dashboard";
  }

  const hashTab = window.location.hash.replace(/^#/, "");
  if (isTabKey(hashTab)) {
    return hashTab;
  }

  const storedTab = window.localStorage.getItem("active_tab");
  if (storedTab && isTabKey(storedTab)) {
    return storedTab;
  }

  return "dashboard";
}

function readInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }

  const storedTheme = window.localStorage.getItem("app_theme");
  return storedTheme === "light" ? "light" : "dark";
}

function parseBudgetAmount(value: string): number {
  const digitsOnly = value.replace(/[^\d]/g, "");
  return digitsOnly ? Number(digitsOnly) : 0;
}

function formatBudgetAmount(value: number): string {
  return budgetCurrencyFormatter.format(Math.max(0, Math.round(value)));
}

function toStartOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readDueDate(value?: string): Date | null {
  const parsed = parseCalendarDate(value);
  return parsed ? toStartOfLocalDay(parsed) : null;
}

function daysBetween(lateDate: Date, earlyDate: Date): number {
  const diffMs = lateDate.getTime() - earlyDate.getTime();
  return Math.max(0, Math.floor(diffMs / 86_400_000));
}

function getTicketDueAlerts(tasks: Task[], now: Date): TicketDueAlert[] {
  const today = toStartOfLocalDay(now);
  const alerts: TicketDueAlert[] = [];

  for (const task of tasks) {
    if (task.nodeType !== "TASK" || task.status === "DONE") {
      continue;
    }

    const due = readDueDate(task.dueDate);
    if (!due) {
      continue;
    }

    let severity: TicketAlertSeverity | null = null;
    let daysLate = 0;
    if (due.getTime() < today.getTime()) {
      severity = "OVERDUE";
      daysLate = daysBetween(today, due);
    } else if (due.getTime() === today.getTime()) {
      severity = "TODAY";
    }

    if (!severity) {
      continue;
    }

    alerts.push({
      key: `${task._id}:${toDateKey(due)}:${severity}`,
      taskId: task._id,
      title: task.title,
      phase: task.phase,
      section: task.section || "",
      dueDate: task.dueDate ?? due.toISOString(),
      severity,
      daysLate
    });
  }

  return alerts.sort((left, right) => {
    if (left.severity !== right.severity) {
      return left.severity === "OVERDUE" ? -1 : 1;
    }

    const leftDue = readDueDate(left.dueDate)?.getTime() ?? 0;
    const rightDue = readDueDate(right.dueDate)?.getTime() ?? 0;
    if (leftDue !== rightDue) {
      return leftDue - rightDue;
    }

    return left.title.localeCompare(right.title);
  });
}

function formatDueAlertLabel(alert: Pick<TicketDueAlert, "severity" | "daysLate">): string {
  if (alert.severity === "OVERDUE") {
    return alert.daysLate === 1 ? "Overdue by 1 day" : `Overdue by ${alert.daysLate} days`;
  }

  return "Due today";
}

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readInitialTheme);
  const [activeTab, setActiveTab] = useState<TabKey>(readInitialTab);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [fxQuote, setFxQuote] = useState<JmdRateQuote | null>(null);
  const [budgetInput, setBudgetInput] = useState("");
  const [editingBudget, setEditingBudget] = useState(false);
  const [savingBudget, setSavingBudget] = useState(false);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [error, setError] = useState("");
  const [ticketAlertPanelOpen, setTicketAlertPanelOpen] = useState(false);
  const [ticketAlertToasts, setTicketAlertToasts] = useState<TicketAlertToast[]>([]);
  const [ticketAlertClock, setTicketAlertClock] = useState(() => Date.now());
  const [projectTaskFocusRequest, setProjectTaskFocusRequest] = useState<TaskFocusRequest | null>(null);
  const [taskDrawerState, setTaskDrawerState] = useState<TaskDrawerState | null>(null);
  const [assistantDockedOpen, setAssistantDockedOpen] = useState(false);
  const ticketAlertPanelRef = useRef<HTMLDivElement | null>(null);
  const seenTicketAlertKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    function syncTabFromHash() {
      const hashTab = window.location.hash.replace(/^#/, "");
      if (isTabKey(hashTab)) {
        setActiveTab((current) => (current === hashTab ? current : hashTab));
      }
    }

    window.addEventListener("hashchange", syncTabFromHash);
    return () => window.removeEventListener("hashchange", syncTabFromHash);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem("active_tab", activeTab);
    const currentHash = window.location.hash.replace(/^#/, "");
    if (currentHash !== activeTab) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${activeTab}`);
    }
  }, [activeTab]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem("app_theme", themeMode);
    document.body.dataset.theme = themeMode;

    return () => {
      delete document.body.dataset.theme;
    };
  }, [themeMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const raw = window.localStorage.getItem(TICKET_DUE_ALERT_SEEN_STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }

      const normalized = parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
      seenTicketAlertKeysRef.current = new Set(normalized);
    } catch {
      seenTicketAlertKeysRef.current = new Set();
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const timerId = window.setInterval(() => {
      setTicketAlertClock(Date.now());
    }, 60_000);

    return () => window.clearInterval(timerId);
  }, []);

  const refresh = useCallback(async () => {
    setError("");

    try {
      const [summaryData, expenseData, taskData, projectData] = await Promise.all([
        api.getSummary(),
        api.getExpenses(),
        api.getTasks(),
        api.getProject()
      ]);

      const fxResponse = await api.getProjectFxRate(projectData.project.currency || "USD").catch(() => null);

      setSummary(summaryData);
      setExpenses(expenseData.expenses);
      setTasks(taskData.tasks);
      setProject(projectData.project);
      setFxQuote(fxResponse?.quote ?? null);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Could not load project data";

      if (message.includes("Authentication") || message.includes("Invalid or expired token")) {
        api.clearSession();
        setCurrentUser(null);
      }

      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    async function bootstrap() {
      const token = api.getStoredToken();

      if (!token) {
        setLoading(false);
        setAuthReady(true);
        return;
      }

      try {
        const me = await api.getMe();
        setCurrentUser(me.user);
        await refresh();
      } catch (_error) {
        api.clearSession();
        setCurrentUser(null);
        setLoading(false);
      } finally {
        setAuthReady(true);
      }
    }

    bootstrap().catch(() => {
      setAuthReady(true);
      setLoading(false);
    });
  }, [refresh]);

  useEffect(() => {
    if (editingBudget) {
      return;
    }

    setBudgetInput(formatBudgetAmount(project?.totalBudget ?? summary?.metrics.totalBudget ?? 0));
  }, [editingBudget, project?.totalBudget, summary?.metrics.totalBudget]);

  useEffect(() => {
    let ignore = false;

    async function loadFxQuote() {
      if (!currentUser || !project?.currency) {
        if (!ignore) {
          setFxQuote(null);
        }
        return;
      }

      try {
        const response = await api.getProjectFxRate(project.currency);
        if (!ignore) {
          setFxQuote(response.quote);
        }
      } catch {
        if (!ignore) {
          setFxQuote(null);
        }
      }
    }

    void loadFxQuote();

    return () => {
      ignore = true;
    };
  }, [currentUser, project?.currency]);

  async function handleAuthenticated(user: AppUser) {
    setCurrentUser(user);
    setLoading(true);
    await refresh();
    setAuthReady(true);
  }

  function handleLogout() {
    api.clearSession();
    setCurrentUser(null);
    setSummary(null);
    setProject(null);
    setFxQuote(null);
    setBudgetInput("");
    setEditingBudget(false);
    setExpenses([]);
    setTasks([]);
    setActiveTab("dashboard");
  }

  async function handleUpdateProject(payload: Partial<Pick<Project, "name" | "phase" | "totalBudget" | "currency" | "notes" | "floorPlanMarkup">>) {
    await api.updateProject(payload);
    await refresh();
  }

  async function handleSaveBudget(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const parsedBudget = parseBudgetAmount(budgetInput);

    if (!isOwner || !Number.isFinite(parsedBudget) || parsedBudget < 1) {
      return;
    }

    setSavingBudget(true);
    setError("");

    try {
      await handleUpdateProject({ totalBudget: parsedBudget });
      setEditingBudget(false);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update budget");
    } finally {
      setSavingBudget(false);
    }
  }

  function startBudgetEdit() {
    setBudgetInput(formatBudgetAmount(project?.totalBudget ?? summary?.metrics.totalBudget ?? 0));
    setEditingBudget(true);
  }

  function cancelBudgetEdit() {
    setBudgetInput(formatBudgetAmount(project?.totalBudget ?? summary?.metrics.totalBudget ?? 0));
    setEditingBudget(false);
  }

  async function handleAddExpense(payload: ExpenseInput) {
    await api.addExpense(payload);
    await refresh();
  }

  async function handleUpdateExpense(id: string, payload: Partial<ExpenseInput>) {
    await api.updateExpense(id, payload);
    await refresh();
  }

  async function handleDeleteExpense(id: string) {
    await api.deleteExpense(id);
    await refresh();
  }

  async function handleCreateTask(payload: TaskInput) {
    await api.addTask(payload);
    await refresh();
  }

  async function handleUpdateTask(id: string, payload: Partial<TaskInput>) {
    await api.updateTask(id, payload);
    await refresh();
  }

  async function handleDeleteTask(id: string) {
    await api.deleteTask(id);
    await refresh();
  }

  async function handleClearAllPhases() {
    await api.clearAllPhases();
    await refresh();
  }

  function openTab(tab: TabKey) {
    setActiveTab(tab);
  }

  function openGlobalTaskDrawer(taskId: string, mode: "edit" | "readonly" = "edit") {
    setTaskDrawerState({ taskId, mode });
  }

  function openProjectTaskFromAlert(taskId: string) {
    openGlobalTaskDrawer(taskId);
    setTicketAlertPanelOpen(false);
  }

  function openTaskInProject(taskId: string) {
    setTaskDrawerState(null);
    setActiveTab("project-management");
    setProjectTaskFocusRequest({
      taskId,
      requestKey: `project-focus-${taskId}-${Date.now()}`
    });
  }

  function handleProjectTaskFocusHandled() {
    setProjectTaskFocusRequest(null);
  }

  const alertDrawerTask = useMemo(
    () => (taskDrawerState?.taskId ? tasks.find((task) => task._id === taskDrawerState.taskId) ?? null : null),
    [taskDrawerState?.taskId, tasks]
  );

  const pageTitle = useMemo(() => {
    if (!project) {
      return "Dream Home Construction Tracker";
    }

    return `${project.name} - ${project.phase}`;
  }, [project]);

  const totalTasks = useMemo(() => {
    if (!summary) {
      return 0;
    }

    return summary.taskCounts.reduce((total, item) => total + item.count, 0);
  }, [summary]);
  const currentPhaseNode = useMemo(() => getCurrentPhase(tasks), [tasks]);

  const activeSection = useMemo<SectionKey>(() => {
    return tabs.find((tab) => tab.key === activeTab)?.section ?? "budget";
  }, [activeTab]);

  const budgetTabs = useMemo(() => tabs.filter((tab) => tab.section === "budget"), []);
  const managementTabs = useMemo(() => tabs.filter((tab) => tab.section === "management"), []);
  const currentMonthLabel = useMemo(() => {
    const latestMonth = summary?.monthlySpend[summary.monthlySpend.length - 1]?.month;
    if (latestMonth) {
      const [year, month] = latestMonth.split("-");
      return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString(undefined, {
        month: "short",
        year: "numeric"
      });
    }

    return new Date().toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }, [summary]);
  const lastUpdatedLabel = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric"
      }),
    []
  );
  const dueTicketAlerts = useMemo(
    () => getTicketDueAlerts(tasks, new Date(ticketAlertClock)),
    [tasks, ticketAlertClock]
  );
  const isOwner = currentUser?.role === "OWNER";

  useEffect(() => {
    setTicketAlertPanelOpen(false);
  }, [activeTab]);

  useEffect(() => {
    if (!ticketAlertPanelOpen || typeof document === "undefined") {
      return;
    }

    function handleOutsideClick(event: MouseEvent) {
      const target = event.target as Node | null;
      if (ticketAlertPanelRef.current && target && !ticketAlertPanelRef.current.contains(target)) {
        setTicketAlertPanelOpen(false);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [ticketAlertPanelOpen]);

  useEffect(() => {
    if (dueTicketAlerts.length === 0) {
      return;
    }

    const unseenAlerts = dueTicketAlerts.filter((alert) => !seenTicketAlertKeysRef.current.has(alert.key));
    if (unseenAlerts.length === 0) {
      return;
    }

    unseenAlerts.forEach((alert) => {
      seenTicketAlertKeysRef.current.add(alert.key);
    });

    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          TICKET_DUE_ALERT_SEEN_STORAGE_KEY,
          JSON.stringify(Array.from(seenTicketAlertKeysRef.current).slice(-400))
        );
      } catch {
        // Ignore localStorage write issues.
      }
    }

    setTicketAlertToasts((current) => {
      const nextToasts = unseenAlerts.slice(0, 3).map((alert) => ({
        key: alert.key,
        taskId: alert.taskId,
        severity: alert.severity,
        title: alert.title,
        message: `${formatDueAlertLabel(alert)} • ${alert.section ? `${alert.phase} / ${alert.section}` : alert.phase}`
      }));
      return [...current, ...nextToasts].slice(-4);
    });
  }, [dueTicketAlerts]);

  function dismissTicketToast(key: string) {
    setTicketAlertToasts((current) => current.filter((toast) => toast.key !== key));
  }

  if (!authReady || (loading && !currentUser)) {
    return (
      <div className="auth-shell">
        <section className="panel auth-panel">Loading application...</section>
      </div>
    );
  }

  if (!currentUser) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div
      className={`app-shell ribbon-shell ${
        activeTab === "project-management" || activeTab === "history" ? "pm-view-lock" : ""
      } ${assistantDockedOpen ? "assistant-docked-layout" : ""} theme-${themeMode}`}
    >
      <header className="app-ribbon">
        <div className="ribbon-top-bar">
          <div className="ribbon-utility-brand">
            <div>
              <strong>Construction OS</strong>
              <span>{project?.name ?? "Dream Home"} workbook</span>
            </div>
          </div>

          <div className="ribbon-brand-pill">
            <div className="ribbon-brand-logo">{project?.name?.slice(0, 1) ?? "D"}</div>
            <div>
              <strong>{project?.name ?? "Dream Home"}</strong>
              <span>{currentPhaseNode?.title ?? project?.phase ?? "Phase 1"} | {currentUser.name}</span>
            </div>
          </div>

          <div className="ribbon-tab-groups">
            <div className="ribbon-tab-group">
              {budgetTabs.map((tab) => (
                <button
                  className={`ribbon-tab ${activeTab === tab.key ? "active" : ""}`}
                  key={tab.key}
                  onClick={() => openTab(tab.key)}
                  type="button"
                >
                  <NavIcon name={tab.icon} />
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>
            <div className="ribbon-tab-group ribbon-tab-group-secondary">
              {managementTabs.map((tab) => (
                <button
                  className={`ribbon-tab ${activeTab === tab.key ? "active" : ""}`}
                  key={tab.key}
                  onClick={() => openTab(tab.key)}
                  type="button"
                >
                  <NavIcon name={tab.icon} />
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="ribbon-utility-actions">
            <button
              className="ribbon-icon-btn ribbon-theme-btn"
              type="button"
              onClick={() => setThemeMode((current) => (current === "dark" ? "light" : "dark"))}
              aria-label={themeMode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              title={themeMode === "dark" ? "Light theme" : "Dark theme"}
            >
              <NavIcon name={themeMode === "dark" ? "sun" : "moon"} />
            </button>
            <div className="ribbon-alert-wrap" ref={ticketAlertPanelRef}>
              <button
                className={`ribbon-icon-btn ribbon-alert-btn ${dueTicketAlerts.length > 0 ? "has-alerts" : ""}`}
                type="button"
                onClick={() => setTicketAlertPanelOpen((current) => !current)}
                aria-label="Ticket alerts"
                aria-expanded={ticketAlertPanelOpen}
              >
                <NavIcon name="notification" />
                {dueTicketAlerts.length > 0 && (
                  <span className="ribbon-alert-count">{dueTicketAlerts.length > 99 ? "99+" : dueTicketAlerts.length}</span>
                )}
              </button>
              {ticketAlertPanelOpen && (
                <section className="ribbon-alert-panel" aria-label="Ticket due alerts">
                  <div className="ribbon-alert-panel-head">
                    <strong>Ticket Alerts</strong>
                    <span>{dueTicketAlerts.length}</span>
                  </div>
                  {dueTicketAlerts.length === 0 ? (
                    <p className="muted">No due or overdue tickets.</p>
                  ) : (
                    <ul className="ribbon-alert-list">
                      {dueTicketAlerts.slice(0, 12).map((alert) => (
                        <li
                          className={`ribbon-alert-item ${alert.severity === "OVERDUE" ? "overdue" : "today"}`}
                          key={alert.key}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              openProjectTaskFromAlert(alert.taskId);
                            }}
                          >
                            <strong>{alert.title}</strong>
                            <span>{alert.section ? `${alert.phase} / ${alert.section}` : alert.phase}</span>
                            <small>{formatDueAlertLabel(alert)}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </div>
            <button className="ribbon-account-btn" type="button" onClick={handleLogout}>
              <NavIcon name="logout" />
              <span>Logout</span>
            </button>
          </div>
        </div>
        {fxQuote && (
          <div className="ribbon-fx-line" aria-label="Current Jamaican dollar exchange rate">
            {fxQuote.sourceCurrency} to {fxQuote.targetCurrency} today:{" "}
            {fxQuote.rate.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 4
            })}{" "}
            on{" "}
            {new Date(fxQuote.rateDate).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric"
            })}
          </div>
        )}
      </header>

      <div className={`app-body-shell ${assistantDockedOpen ? "assistant-docked" : ""}`}>
        <section
          className={`main-column ribbon-main-column ${
            activeTab === "project-management"
              ? "ribbon-main-column-full"
              : activeTab === "history"
                ? "ribbon-main-column-history"
                : ""
          }`}
        >
          {activeTab === "dashboard" && (
            <header className="dashboard-head panel ribbon-page-head">
            <div className="dashboard-title">
              <p className="eyebrow">{activeTab === "dashboard" ? "Dashboard" : activeSection === "budget" ? "Budget Workspace" : "Management Workspace"}</p>
              <h1>{pageTitle}</h1>
              <p className="muted">
                {activeSection === "budget"
                  ? "Budget planning, invoices, and expense cash tracking for your build."
                  : "Execution tracking, worker profiles, and team coordination for construction."}
              </p>
            </div>

            <div className="ribbon-page-meta">
              <div>
                <span>Last Update</span>
                <strong>{lastUpdatedLabel}</strong>
              </div>
              <div>
                <span>Month</span>
                <strong>{currentMonthLabel}</strong>
              </div>
            </div>

            <div className="kpi-grid">
              <article className="kpi-card kpi-card-budget">
                <p>Budget</p>
                {editingBudget ? (
                  <form className="kpi-budget-editor" onSubmit={handleSaveBudget}>
                    <div className="kpi-budget-field">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={budgetInput}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          if (!nextValue.trim()) {
                            setBudgetInput("");
                            return;
                          }

                          setBudgetInput(formatBudgetAmount(parseBudgetAmount(nextValue)));
                        }}
                        disabled={savingBudget}
                        aria-label="Edit budget"
                        autoFocus
                      />
                      <div className="kpi-budget-editor-actions">
                        <button
                          className="kpi-inline-icon primary"
                          type="submit"
                          disabled={savingBudget || parseBudgetAmount(budgetInput) < 1}
                          aria-label="Save budget"
                        >
                          <NavIcon name="confirm" />
                        </button>
                        <button
                          className="kpi-inline-icon"
                          type="button"
                          onClick={cancelBudgetEdit}
                          disabled={savingBudget}
                          aria-label="Cancel budget edit"
                        >
                          <NavIcon name="close" />
                        </button>
                      </div>
                    </div>
                  </form>
                ) : (
                  <div className="kpi-value-row">
                    <h3>{formatBudgetAmount(summary?.metrics.totalBudget ?? 0)}</h3>
                    {isOwner && (
                      <button className="kpi-edit-btn" type="button" onClick={startBudgetEdit} aria-label="Edit budget">
                        <NavIcon name="edit" />
                      </button>
                    )}
                  </div>
                )}
              </article>
              <article className="kpi-card kpi-card-spent">
                <p>Spent (Paid)</p>
                <h3>{formatCurrency(summary?.metrics.totalSpent ?? 0)}</h3>
              </article>
              <article className="kpi-card kpi-card-committed">
                <p>Committed</p>
                <h3>{formatCurrency(summary?.metrics.unpaidCommitted ?? 0)}</h3>
              </article>
              <article className="kpi-card kpi-card-remaining">
                <p>Unused Funds</p>
                <h3>{formatCurrency(summary?.metrics.remainingBudget ?? 0)}</h3>
              </article>
              <article className="kpi-card kpi-card-cash">
                <p>After Commitments</p>
                <h3>{formatCurrency(summary?.metrics.remainingAfterCommitments ?? 0)}</h3>
              </article>
              <article className="kpi-card kpi-card-invoices">
                <p>Open Invoices</p>
                <h3>{summary?.metrics.unpaidInvoiceCount ?? 0}</h3>
              </article>
              <article className="kpi-card kpi-card-burn">
                <p>Budget Burn</p>
                <h3>{summary?.metrics.burnRate ?? 0}%</h3>
              </article>
              <article className="kpi-card kpi-card-tasks">
                <p>Tasks</p>
                <h3>{totalTasks}</h3>
              </article>
            </div>
            </header>
          )}

          {error && <p className="error-text panel">{error}</p>}

          <main className="content">
            {loading && !summary ? (
              <section className="panel">Loading your project dashboard...</section>
            ) : (
              <>
                {activeTab === "dashboard" && (
                  <BudgetOverview
                    summary={summary}
                    tasks={tasks}
                  />
                )}

                {activeTab === "expenses" && (
                  <ExpenseSection
                    expenses={expenses}
                    tasks={tasks}
                    globalPhaseTaskId={currentPhaseNode?._id}
                    globalPhaseName={currentPhaseNode?.title ?? project?.phase ?? ""}
                    canDeleteExpense={isOwner}
                    onAddExpense={handleAddExpense}
                    onUpdateExpense={handleUpdateExpense}
                    onDeleteExpense={handleDeleteExpense}
                    onOpenLinkedTask={openGlobalTaskDrawer}
                  />
                )}

                {activeTab === "invoices" && (
                  <InvoiceCenter
                    expenses={expenses}
                    tasks={tasks}
                    globalPhaseTaskId={currentPhaseNode?._id}
                    globalPhaseName={currentPhaseNode?.title ?? project?.phase ?? ""}
                    canMarkPaid={isOwner}
                    onInvoicePaid={refresh}
                  />
                )}

                {activeTab === "reports" && <ReportsPanel />}
                {activeTab === "history" && <HistoryPanel onOpenTask={(taskId) => openGlobalTaskDrawer(taskId, "readonly")} />}
                {activeTab === "project-management" && (
                  <ProjectManagement
                    project={project}
                    currentUser={currentUser}
                    tasks={tasks}
                    canDeleteTask={isOwner}
                    canDeleteWorker={isOwner}
                    focusTaskRequest={projectTaskFocusRequest}
                    onCreateTask={handleCreateTask}
                    onUpdateTask={handleUpdateTask}
                    onDeleteTask={handleDeleteTask}
                    onClearAllPhases={handleClearAllPhases}
                    onRefreshData={refresh}
                    onUpdateProject={handleUpdateProject}
                    onTaskFocusHandled={handleProjectTaskFocusHandled}
                  />
                )}
              </>
            )}
          </main>
        </section>
    <ProjectAssistantWidget
      activeTab={activeTab}
      currentUser={currentUser}
      tasks={tasks}
      currentPhaseTaskId={currentPhaseNode?._id}
      onOpenTask={(taskId) => openGlobalTaskDrawer(taskId, "readonly")}
      taskDrawerOpen={Boolean(alertDrawerTask)}
      onDockedLayoutChange={setAssistantDockedOpen}
          onProjectMutation={refresh}
        />
      </div>
      {ticketAlertToasts.length > 0 && (
        <div className="ticket-alert-toast-stack" role="status" aria-live="polite">
          {ticketAlertToasts.map((toast) => (
            <article className={`ticket-alert-toast ${toast.severity === "OVERDUE" ? "overdue" : "today"}`} key={toast.key}>
              <div className="ticket-alert-toast-copy">
                <strong>{toast.title}</strong>
                <p>{toast.message}</p>
              </div>
              <div className="ticket-alert-toast-actions">
                <button
                  className="ticket-alert-toast-view"
                  type="button"
                  onClick={() => {
                    openProjectTaskFromAlert(toast.taskId);
                    dismissTicketToast(toast.key);
                  }}
                >
                  View
                </button>
                <button
                  className="ticket-alert-toast-close"
                  type="button"
                  onClick={() => dismissTicketToast(toast.key)}
                  aria-label="Dismiss alert"
                >
                  <NavIcon name="close" />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <TaskAlertDrawer
        open={Boolean(alertDrawerTask)}
        task={alertDrawerTask}
        mode={taskDrawerState?.mode ?? "edit"}
        onClose={() => setTaskDrawerState(null)}
        onUpdateTask={handleUpdateTask}
        onViewInProject={openTaskInProject}
      />
    </div>
  );
}
