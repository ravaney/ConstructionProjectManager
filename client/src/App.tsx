import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthScreen } from "./components/AuthScreen";
import { BudgetOverview } from "./components/BudgetOverview";
import { CsvImporter } from "./components/CsvImporter";
import { ExpenseSection } from "./components/ExpenseSection";
import { InvoiceCenter } from "./components/InvoiceCenter";
import { ReportsPanel } from "./components/ReportsPanel";
import { TaskBoard } from "./components/TaskBoard";
import { TeamManagement } from "./components/TeamManagement";
import { WorkerProfiles } from "./components/WorkerProfiles";
import type { AppUser, DashboardSummary, Expense, ExpenseInput, Project, Task, TaskInput } from "./types/models";
import { formatCurrency } from "./utils/format";
import { api } from "./utils/api";

type TabKey = "dashboard" | "expenses" | "invoices" | "import" | "reports" | "tasks" | "workers" | "team";
type SectionKey = "budget" | "management";
type IconName =
  | "budget"
  | "management"
  | "dashboard"
  | "expenses"
  | "invoices"
  | "import"
  | "reports"
  | "tasks"
  | "workers"
  | "team"
  | "add"
  | "refresh"
  | "logout";

const tabs: Array<{ key: TabKey; label: string; section: SectionKey; icon: IconName }> = [
  { key: "dashboard", label: "Budget Dashboard", section: "budget", icon: "dashboard" },
  { key: "expenses", label: "Expenses", section: "budget", icon: "expenses" },
  { key: "invoices", label: "Invoices", section: "budget", icon: "invoices" },
  { key: "import", label: "Import CSV", section: "budget", icon: "import" },
  { key: "reports", label: "Reports", section: "budget", icon: "reports" },
  { key: "tasks", label: "Project Tasks", section: "management", icon: "tasks" },
  { key: "workers", label: "Worker Profiles", section: "management", icon: "workers" },
  { key: "team", label: "Team", section: "management", icon: "team" }
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
    case "import":
      return (
        <svg {...props}>
          <path d="M12 3v12" />
          <path d="M8 11l4 4 4-4" />
          <path d="M4 19h16" />
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
    case "tasks":
      return (
        <svg {...props}>
          <path d="M9 11l2 2 4-4" />
          <path d="M4 6h16" />
          <path d="M4 12h4" />
          <path d="M4 18h16" />
        </svg>
      );
    case "workers":
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="3" />
          <circle cx="16" cy="10" r="2" />
          <path d="M3 19c0-3.2 2.7-5.2 6-5.2" />
          <path d="M10.5 18.7c.6-1.8 2.1-3 4.2-3" />
        </svg>
      );
    case "team":
      return (
        <svg {...props}>
          <circle cx="9" cy="8" r="3" />
          <circle cx="17" cy="10" r="2" />
          <path d="M3 19c0-3 2.5-5 6-5s6 2 6 5" />
        </svg>
      );
    case "add":
      return (
        <svg {...props}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...props}>
          <path d="M20 11a8 8 0 1 0 2 5" />
          <path d="M20 4v7h-7" />
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
    default:
      return null;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("dashboard");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setError("");

    try {
      const [summaryData, expenseData, taskData, projectData] = await Promise.all([
        api.getSummary(),
        api.getExpenses(),
        api.getTasks(),
        api.getProject()
      ]);

      setSummary(summaryData);
      setExpenses(expenseData.expenses);
      setTasks(taskData.tasks);
      setProject(projectData.project);
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
    setExpenses([]);
    setTasks([]);
    setActiveTab("dashboard");
  }

  async function handleUpdateBudget(totalBudget: number) {
    await api.updateProject({ totalBudget });
    await refresh();
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

  async function handleImport(expenseRows: ExpenseInput[]) {
    const result = await api.bulkImportExpenses(expenseRows);
    await refresh();
    return result.insertedCount;
  }

  function openTab(tab: TabKey) {
    setActiveTab(tab);
  }

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

  const activeSection = useMemo<SectionKey>(() => {
    return tabs.find((tab) => tab.key === activeTab)?.section ?? "budget";
  }, [activeTab]);

  const budgetTabs = useMemo(() => tabs.filter((tab) => tab.section === "budget"), []);
  const managementTabs = useMemo(() => tabs.filter((tab) => tab.section === "management"), []);
  const isOwner = currentUser?.role === "OWNER";

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
    <div className="app-shell">
      <div className="layout-grid">
        <aside className="sidebar">
          <div className="sidebar-brand sidebar-card">
            <p className="eyebrow">Construction OS</p>
            <h2>{project?.phase ?? "Phase Tracker"}</h2>
            <p className="muted small-text">
              {currentUser.name} ({currentUser.role})
            </p>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-title">
              <NavIcon name="budget" />
              <span>Budget</span>
            </div>
            <div className="sidebar-group">
              {budgetTabs.map((tab) => (
                <button
                  className={`sidebar-btn ${activeTab === tab.key ? "active" : ""}`}
                  key={tab.key}
                  onClick={() => openTab(tab.key)}
                >
                  <span className="sidebar-btn-content">
                    <NavIcon name={tab.icon} />
                    <span>{tab.label}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-title">
              <NavIcon name="management" />
              <span>Management</span>
            </div>
            <div className="sidebar-group">
              {managementTabs.map((tab) => (
                <button
                  className={`sidebar-btn ${activeTab === tab.key ? "active" : ""}`}
                  key={tab.key}
                  onClick={() => openTab(tab.key)}
                >
                  <span className="sidebar-btn-content">
                    <NavIcon name={tab.icon} />
                    <span>{tab.label}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-group quick-actions">
            <p className="sidebar-label">Quick Actions</p>
            <p className="sidebar-mini-label">Budget</p>
            <button className="sidebar-btn quick-btn" onClick={() => openTab("expenses")}>
              <span className="sidebar-btn-content">
                <NavIcon name="add" />
                <span>Add Expense</span>
              </span>
            </button>
            <button className="sidebar-btn quick-btn" onClick={() => openTab("invoices")}>
              <span className="sidebar-btn-content">
                <NavIcon name="invoices" />
                <span>Only Invoices</span>
              </span>
            </button>
            <p className="sidebar-mini-label">Management</p>
            <button className="sidebar-btn quick-btn" onClick={() => openTab("tasks")}>
              <span className="sidebar-btn-content">
                <NavIcon name="tasks" />
                <span>Open Tasks</span>
              </span>
            </button>
            <button className="sidebar-btn quick-btn" onClick={() => refresh()} disabled={loading}>
              <span className="sidebar-btn-content">
                <NavIcon name="refresh" />
                <span>Refresh Data</span>
              </span>
            </button>
            <button className="sidebar-btn logout-btn" onClick={handleLogout}>
              <span className="sidebar-btn-content">
                <NavIcon name="logout" />
                <span>Logout</span>
              </span>
            </button>
          </div>
        </aside>

        <section className="main-column">
          {activeTab !== "invoices" && (
            <header className="dashboard-head panel">
              <div className="dashboard-title">
                <p className="eyebrow">Home Construction Dashboard</p>
                <h1>{pageTitle}</h1>
                <p className="muted">
                  {activeSection === "budget"
                    ? "Budget planning, invoices, and expense cash tracking for your build."
                    : "Execution tracking, worker profiles, and team coordination for construction."}
                </p>
              </div>

              <div className="kpi-grid">
                <article className="kpi-card">
                  <p>Budget</p>
                  <h3>{formatCurrency(summary?.metrics.totalBudget ?? 0)}</h3>
                </article>
                <article className="kpi-card">
                  <p>Spent (Paid)</p>
                  <h3>{formatCurrency(summary?.metrics.totalSpent ?? 0)}</h3>
                </article>
                <article className="kpi-card">
                  <p>Committed</p>
                  <h3>{formatCurrency(summary?.metrics.unpaidCommitted ?? 0)}</h3>
                </article>
                <article className="kpi-card">
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
                    project={project}
                    canEditBudget={isOwner}
                    onUpdateBudget={handleUpdateBudget}
                  />
                )}

                {activeTab === "expenses" && (
                  <ExpenseSection
                    expenses={expenses}
                    canDeleteExpense={isOwner}
                    onAddExpense={handleAddExpense}
                    onUpdateExpense={handleUpdateExpense}
                    onDeleteExpense={handleDeleteExpense}
                  />
                )}

                {activeTab === "invoices" && <InvoiceCenter expenses={expenses} canMarkPaid={isOwner} onInvoicePaid={refresh} />}

                {activeTab === "tasks" && (
                  <TaskBoard
                    tasks={tasks}
                    canDeleteTask={isOwner}
                    onCreateTask={handleCreateTask}
                    onUpdateTask={handleUpdateTask}
                    onDeleteTask={handleDeleteTask}
                  />
                )}

                {activeTab === "workers" && <WorkerProfiles canDelete={isOwner} />}

                {activeTab === "import" && <CsvImporter canImport={isOwner} onImport={handleImport} />}
                {activeTab === "reports" && <ReportsPanel />}
                {activeTab === "team" && <TeamManagement currentUser={currentUser} />}
              </>
            )}
          </main>
        </section>
      </div>
    </div>
  );
}
