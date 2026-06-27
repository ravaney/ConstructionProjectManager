import { useEffect, useMemo, useState } from "react";
import type { DashboardSummary, HistoryEntry, Task, TaskStatus } from "../types/models";
import { api } from "../utils/api";
import { formatCurrency } from "../utils/format";
import { getTaskStatusLabel } from "../utils/taskStatus";
import { getChildTasks, getCurrentPhase, getPhaseNodes, getSectionsForPhase } from "../utils/workBreakdown";

type BudgetOverviewProps = {
  summary: DashboardSummary | null;
  tasks: Task[];
};

const chartPalette = ["#e76f72", "#7f6a8e", "#d88a66", "#c9a45d", "#8a7cc4", "#a5717e"];
const summarySegmentColors = {
  materials: "#4fb4ff",
  land: "#f1c36d",
  labour: "#ff9b9f",
  equipment: "#b08cff",
  other: "#7f93a6",
  remaining: "#69d68f"
} as const;

type MoneyFeedTone = keyof Pick<typeof summarySegmentColors, "materials" | "land" | "labour" | "equipment" | "other">;
type MoneyFeedCategory = {
  tone: MoneyFeedTone;
  label: "Materials" | "Labour" | "Equipment" | "Land" | "Other";
};

function sortTasks(nodes: Task[]): Task[] {
  return [...nodes].sort((left, right) => {
    const orderDiff = left.sortOrder - right.sortOrder;
    if (orderDiff !== 0) {
      return orderDiff;
    }

    return left.title.localeCompare(right.title);
  });
}

function dedupeById(nodes: Task[]): Task[] {
  const map = new Map(nodes.map((node) => [node._id, node]));
  return sortTasks(Array.from(map.values()));
}

function getPhaseLinkedSections(tasks: Task[], phaseId?: string, phaseTitle?: string): Task[] {
  if (!phaseId && !phaseTitle) {
    return [];
  }

  const candidates: Task[] = [];
  if (phaseId) {
    const parentLinked = getSectionsForPhase(tasks, phaseId);
    candidates.push(...parentLinked);
    candidates.push(...tasks.filter((task) => task.nodeType === "SECTION" && task.phaseTaskId === phaseId));
  }

  if (phaseTitle) {
    const normalizedTitle = phaseTitle.trim().toLowerCase();
    candidates.push(
      ...tasks.filter(
        (task) => task.nodeType === "SECTION" && task.phase.trim().toLowerCase() === normalizedTitle
      )
    );
  }

  return dedupeById(candidates);
}

function getPhaseLinkedLeafTasks(tasks: Task[], phaseId?: string, phaseTitle?: string): Task[] {
  if (!phaseId && !phaseTitle) {
    return [];
  }

  const candidates: Task[] = [];
  if (phaseId) {
    candidates.push(...getChildTasks(tasks, phaseId).filter((task) => task.nodeType === "TASK"));
    candidates.push(
      ...tasks.filter(
        (task) => task.nodeType === "TASK" && task.phaseTaskId === phaseId && !task.sectionTaskId
      )
    );
  }

  if (phaseTitle) {
    const normalizedTitle = phaseTitle.trim().toLowerCase();
    candidates.push(
      ...tasks.filter(
        (task) =>
          task.nodeType === "TASK" &&
          !task.sectionTaskId &&
          task.phase.trim().toLowerCase() === normalizedTitle
      )
    );
  }

  return dedupeById(candidates);
}

function collectHistoryCategorySignals(entry: HistoryEntry): string[] {
  const signals: string[] = [];

  const addSignal = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized) {
      signals.push(normalized);
    }
  };

  addSignal(entry.summary);
  addSignal(entry.entityLabel);
  addSignal(entry.moneyImpact?.label);
  addSignal(entry.before?.category);
  addSignal(entry.after?.category);

  const beforeItems = Array.isArray(entry.before?.items) ? entry.before.items : [];
  const afterItems = Array.isArray(entry.after?.items) ? entry.after.items : [];

  for (const item of [...beforeItems, ...afterItems]) {
    if (item && typeof item === "object" && "category" in item) {
      addSignal((item as { category?: unknown }).category);
    }
  }

  if (entry.metadata && typeof entry.metadata === "object") {
    if ("category" in entry.metadata) {
      addSignal((entry.metadata as Record<string, unknown>).category);
    }

    if ("categories" in entry.metadata) {
      const categories = (entry.metadata as Record<string, unknown>).categories;
      if (Array.isArray(categories)) {
        categories.forEach(addSignal);
      }
    }
  }

  return signals;
}

function resolveMoneyFeedCategory(entry: HistoryEntry): MoneyFeedCategory {
  const text = collectHistoryCategorySignals(entry).join(" ");

  if (
    text.includes("materials") ||
    text.includes("cement") ||
    text.includes("steel") ||
    text.includes("sand") ||
    text.includes("gravel") ||
    text.includes("lumber")
  ) {
    return { tone: "materials", label: "Materials" };
  }

  if (
    text.includes("labour") ||
    text.includes("labor") ||
    text.includes("subcontract") ||
    text.includes("contractor") ||
    text.includes("grouped payment") ||
    text.includes("estimate-group-payment") ||
    text.includes("service")
  ) {
    return { tone: "labour", label: "Labour" };
  }

  if (text.includes("equipment")) {
    return { tone: "equipment", label: "Equipment" };
  }

  if (text.includes("land")) {
    return { tone: "land", label: "Land" };
  }

  return { tone: "other", label: "Other" };
}

function getMoneyFeedEntryPriority(entry: HistoryEntry): number {
  const category = resolveMoneyFeedCategory(entry);
  const categoryWeight = category.tone === "other" ? 0 : 3;
  const entityWeight =
    entry.entityType === "EXPENSE"
      ? 5
      : entry.entityType === "INVOICE"
        ? 4
        : entry.entityType === "TASK"
          ? 3
          : entry.entityType === "ESTIMATE_GROUP"
            ? 2
            : 1;
  const snapshotWeight =
    typeof entry.before?.category === "string" || typeof entry.after?.category === "string" ? 2 : 0;

  return categoryWeight + entityWeight + snapshotWeight;
}

function formatFeedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function BudgetOverview({ summary, tasks }: BudgetOverviewProps) {
  const phaseNodes = useMemo(() => getPhaseNodes(tasks), [tasks]);
  const currentPhase = useMemo(() => getCurrentPhase(tasks), [tasks]);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  const [moneyFeedEntries, setMoneyFeedEntries] = useState<HistoryEntry[]>([]);
  const [moneyFeedLoading, setMoneyFeedLoading] = useState(true);
  const selectedPhase = useMemo(
    () => phaseNodes.find((phase) => phase._id === selectedPhaseId),
    [phaseNodes, selectedPhaseId]
  );
  const sectionNodes = useMemo(() => {
    if (!selectedPhaseId) {
      return [];
    }

    const phaseTitle = phaseNodes.find((phase) => phase._id === selectedPhaseId)?.title;
    const sections = getPhaseLinkedSections(tasks, selectedPhaseId, phaseTitle);
    if (sections.length > 0) {
      return sections;
    }

    // Backward-compatible fallback for phases with direct task children and no SECTION nodes.
    return getPhaseLinkedLeafTasks(tasks, selectedPhaseId, phaseTitle);
  }, [phaseNodes, tasks, selectedPhaseId]);

  useEffect(() => {
    if (selectedPhaseId && !phaseNodes.some((phase) => phase._id === selectedPhaseId)) {
      setSelectedPhaseId(null);
    }
  }, [phaseNodes, selectedPhaseId]);

  useEffect(() => {
    let ignore = false;

    async function loadMoneyFeed() {
      setMoneyFeedLoading(true);
      try {
        const response = await api.getHistory({ moneyOnly: true, limit: 36 });
        if (!ignore) {
          setMoneyFeedEntries(response.entries);
        }
      } catch {
        if (!ignore) {
          setMoneyFeedEntries([]);
        }
      } finally {
        if (!ignore) {
          setMoneyFeedLoading(false);
        }
      }
    }

    void loadMoneyFeed();

    return () => {
      ignore = true;
    };
  }, [summary]);

  const summaryBreakdown = useMemo(() => {
    const radius = 86;
    const circumference = 2 * Math.PI * radius;
    if (!summary) {
      return {
        radius,
        circumference,
        burnPercent: 0,
        spent: 0,
        remaining: 0,
        segments: [] as Array<{
          label: string;
          value: number;
          color: string;
          dasharray: string;
          dashoffset: number;
        }>
      };
    }

    const groupedSpent = {
      materials: 0,
      land: 0,
      labour: 0,
      equipment: 0,
      other: 0
    };

    summary.categoryTotals.forEach((entry) => {
      const normalizedCategory = entry.category.trim().toLowerCase();

      if (normalizedCategory.startsWith("materials")) {
        groupedSpent.materials += entry.total;
        return;
      }

      if (normalizedCategory === "land" || normalizedCategory.startsWith("land /")) {
        groupedSpent.land += entry.total;
        return;
      }

      if (normalizedCategory.includes("labour") || normalizedCategory.includes("labor")) {
        groupedSpent.labour += entry.total;
        return;
      }

      if (normalizedCategory.includes("equipment")) {
        groupedSpent.equipment += entry.total;
        return;
      }

      groupedSpent.other += entry.total;
    });

    const remaining = Math.max(summary.metrics.remainingBudget, 0);
    const segmentSeed = [
      { label: "Materials", value: groupedSpent.materials, color: summarySegmentColors.materials },
      { label: "Land", value: groupedSpent.land, color: summarySegmentColors.land },
      { label: "Labour", value: groupedSpent.labour, color: summarySegmentColors.labour },
      { label: "Equipment", value: groupedSpent.equipment, color: summarySegmentColors.equipment },
      ...(groupedSpent.other > 0.009 ? [{ label: "Other Spent", value: groupedSpent.other, color: summarySegmentColors.other }] : []),
      { label: "Remaining Budget", value: remaining, color: summarySegmentColors.remaining }
    ].filter((segment) => segment.value > 0);

    const chartTotal = Math.max(
      segmentSeed.reduce((total, segment) => total + segment.value, 0),
      1
    );

    let offset = 0;
    const segments = segmentSeed.map((segment) => {
      const segmentLength = (segment.value / chartTotal) * circumference;
      const chartSegment = {
        ...segment,
        dasharray: `${segmentLength} ${circumference}`,
        dashoffset: -offset
      };
      offset += segmentLength;
      return chartSegment;
    });

    return {
      radius,
      circumference,
      burnPercent: Number(summary.metrics.burnRate.toFixed(1)),
      spent: summary.metrics.totalSpent,
      remaining,
      segments
    };
  }, [summary]);

  const categoryFocus = useMemo(() => {
    if (!summary) {
      return [];
    }

    return summary.categoryTotals.slice(0, 5).map((entry, index) => ({
      ...entry,
      percentOfBudget:
        summary.metrics.totalBudget > 0 ? Number(((entry.total / summary.metrics.totalBudget) * 100).toFixed(1)) : 0,
      color: chartPalette[index % chartPalette.length]
    }));
  }, [summary]);

  const moneyFeed = useMemo(() => {
    const bestByOperation = new Map<string, HistoryEntry>();

    for (const entry of moneyFeedEntries) {
      const key = entry.operationId || entry._id;
      const existing = bestByOperation.get(key);
      if (!existing) {
        bestByOperation.set(key, entry);
        continue;
      }

      if (getMoneyFeedEntryPriority(entry) > getMoneyFeedEntryPriority(existing)) {
        bestByOperation.set(key, entry);
      }
    }

    return Array.from(bestByOperation.values())
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .slice(0, 18)
      .map((entry) => {
      const category = resolveMoneyFeedCategory(entry);
      return {
        ...entry,
        tone: category.tone,
        categoryLabel: category.label,
        color: summarySegmentColors[category.tone]
      };
    });
  }, [moneyFeedEntries]);

  const phaseExpenseExplorer = useMemo(() => {
    const sourceNodes = selectedPhase ? sectionNodes : phaseNodes;
    const levelLabel = selectedPhase ? "Sections" : "Phases";
    const emptyMessage = selectedPhase
      ? "No sections have been created for this phase yet."
      : "Create phases in Project Tasks to start tracking phase costs.";

    const baseRows = sourceNodes.map((node) => {
      const estimate = node.financials.rolledEstimate;
      const spent = node.financials.rolledSpent;
      const committed = node.financials.rolledCommitted;
      const isCurrent = node._id === currentPhase?._id;
      const childCount = selectedPhase
        ? 0
        : (() => {
            const sections = getPhaseLinkedSections(tasks, node._id, node.title);
            if (sections.length > 0) {
              return sections.length;
            }

            return getPhaseLinkedLeafTasks(tasks, node._id, node.title).length;
          })();
      const clickable = !selectedPhase && childCount > 0;
      const subtitle = selectedPhase
        ? getTaskStatusLabel(node.status)
        : `${childCount} section${childCount === 1 ? "" : "s"}`;

      return {
        _id: node._id,
        title: node.title,
        subtitle,
        status: node.status,
        estimate,
        spent,
        committed,
        progress: node.progress.percentComplete,
        isCurrent,
        clickable
      };
    });

    const maxCost = Math.max(
      ...baseRows.map((row) => Math.max(row.estimate, row.spent, 1)),
      1
    );

    return {
      levelLabel,
      emptyMessage,
      rows: baseRows.map((row) => ({
        ...row,
        estimateRatio: row.estimate > 0 ? Math.max((row.estimate / maxCost) * 100, 6) : 0,
        spentRatio: row.spent > 0 ? Math.max((row.spent / maxCost) * 100, 6) : 0
      }))
    };
  }, [currentPhase?._id, phaseNodes, sectionNodes, selectedPhase, tasks]);

  if (!summary) {
    return <section className="panel">Loading dashboard...</section>;
  }

  return (
    <section className="stack-lg budget-dashboard-sheet">
      <div className="dashboard-news-layout">
        <aside className="panel budget-card dashboard-news-card">
          <div className="dashboard-news-head">
            <div>
              <h3>News Feed</h3>
            </div>
            <span className="dashboard-news-count">{moneyFeed.length}</span>
          </div>
          <div className="dashboard-news-list">
            {moneyFeedLoading ? (
              <p className="muted">Loading financial activity...</p>
            ) : moneyFeed.length === 0 ? (
              <p className="muted">No financial transactions yet.</p>
            ) : (
              moneyFeed.map((entry) => (
                <article className={`dashboard-news-item tone-${entry.tone}`} key={entry._id}>
                  <span className="dashboard-news-accent" style={{ background: entry.color }} />
                  <div className="dashboard-news-copy">
                    <div className="dashboard-news-meta-row">
                      <span className={`dashboard-news-tag tone-${entry.tone}`}>{entry.categoryLabel}</span>
                      <span>{formatFeedTime(entry.createdAt)}</span>
                    </div>
                    <strong title={entry.summary}>{entry.summary}</strong>
                    {entry.moneyImpact && (
                      <em style={{ color: entry.color }}>
                        {entry.moneyImpact.label}: {formatCurrency(entry.moneyImpact.delta, entry.moneyImpact.currency)}
                      </em>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>
        </aside>

        <div className="dashboard-news-main">
      <div className="budget-sheet-grid budget-sheet-grid-top">
        <article className="panel budget-card summary-ring-card">
          <h3>Summary This Build</h3>
          <div className="summary-ring-wrap">
            <svg viewBox="0 0 220 220" className="summary-ring" aria-label="Budget composition chart">
              <circle cx="110" cy="110" r={summaryBreakdown.radius} className="summary-ring-track" />
              {summaryBreakdown.segments.map((segment) => (
                <circle
                  key={segment.label}
                  cx="110"
                  cy="110"
                  r={summaryBreakdown.radius}
                  className="summary-ring-value"
                  strokeDasharray={segment.dasharray}
                  strokeDashoffset={segment.dashoffset}
                  style={{ stroke: segment.color }}
                />
              ))}
            </svg>
            <div className="summary-ring-copy">
              <strong>{summaryBreakdown.burnPercent}%</strong>
            </div>
          </div>

          <div className="summary-legend">
            {summaryBreakdown.segments.map((segment) => (
              <span key={segment.label}>
                <i style={{ background: segment.color }} />
                {segment.label}: <strong>{formatCurrency(segment.value)}</strong>
              </span>
            ))}
          </div>

          <div className="summary-amount">
            <div>
              <strong>{formatCurrency(summaryBreakdown.spent)}</strong>
              <span>Spent to date</span>
            </div>
            <div>
              <strong>{formatCurrency(summaryBreakdown.remaining)}</strong>
              <span>Remaining budget</span>
            </div>
          </div>
        </article>

        <article className="panel budget-card allocation-card">
          <h3>Cost Allocation</h3>
          <div className="allocation-stack">
            {categoryFocus.map((entry) => (
              <div className="allocation-row" key={entry.category}>
                <div className="allocation-icon" style={{ background: entry.color }} />
                <div className="allocation-main">
                  <div className="allocation-bar">
                    <span style={{ width: `${Math.max(Math.min(entry.percentOfBudget, 100), 4)}%`, background: entry.color }} />
                  </div>
                  <div className="allocation-copy">
                    <strong>{entry.percentOfBudget}%</strong>
                    <div>
                      <p>{entry.category}</p>
                      <span>{formatCurrency(entry.total)} spent on budget</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel budget-card phase-expense-card">
          <div className="phase-expense-head">
            <div>
              <h3>{selectedPhase ? "Phase Sections" : "Phase Expenses"}</h3>
              <p className="muted small-text">
                {selectedPhase
                  ? "Section bars for the selected phase."
                  : "Click any active phase bar to drill into its sections."}
              </p>
            </div>
            <div className="phase-expense-meta-stack">
              <span className="phase-expense-scope">{phaseExpenseExplorer.levelLabel}</span>
              <strong>{phaseExpenseExplorer.rows.length}</strong>
            </div>
          </div>

          {selectedPhase && (
            <div className="phase-expense-breadcrumbs">
              <button
                type="button"
                onClick={() => setSelectedPhaseId(null)}
              >
                Back to Phases
              </button>
            </div>
          )}

          <div key={selectedPhase?._id ?? "phases"} className="phase-expense-chart phase-expense-chart-animate">
            <div className="phase-expense-legend">
              <span><i className="phase-expense-legend-estimate" /> Estimate</span>
              <span><i className="phase-expense-legend-spent" /> Spent</span>
            </div>
            {phaseExpenseExplorer.rows.length === 0 ? (
              <p className="muted">{phaseExpenseExplorer.emptyMessage}</p>
            ) : (
              <div className="phase-expense-plot">
                {phaseExpenseExplorer.rows.map((row) => {
                  const groupContent = (
                    <>
                      <div className="phase-expense-bars" role="img" aria-label={`${row.title} estimate vs spent`}>
                        <span className="phase-expense-bar-col phase-expense-bar-col-estimate" style={{ height: `${row.estimateRatio}%` }} />
                        <span className="phase-expense-bar-col phase-expense-bar-col-spent" style={{ height: `${row.spentRatio}%` }} />
                      </div>
                      <div className="phase-expense-group-label" title={row.title}>{row.title}</div>
                      <div className="phase-expense-group-meta">
                        <span>E {formatCurrency(row.estimate)}</span>
                        <span>S {formatCurrency(row.spent)}</span>
                      </div>
                      <div className="phase-expense-group-sub">{row.subtitle}</div>
                    </>
                  );

                  if (row.clickable) {
                    return (
                      <button
                        className={`phase-expense-group is-clickable ${row.isCurrent ? "is-current" : ""}`}
                        key={row._id}
                        type="button"
                        onClick={() => setSelectedPhaseId(row._id)}
                      >
                        {groupContent}
                      </button>
                    );
                  }

                  return (
                    <div className={`phase-expense-group ${row.isCurrent ? "is-current" : ""} ${row.status === "PLANNED" ? "is-planned" : ""}`} key={row._id}>
                      {groupContent}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </article>
      </div>

      <div className="budget-sheet-grid budget-sheet-grid-bottom">
        <article className="panel budget-card category-table-card">
          <div className="card-title-row">
            <h3>Top Expenses This Build</h3>
            <span className="muted small-text">Categories</span>
          </div>
          <div className="category-table">
            {summary.categoryTotals.slice(0, 8).map((entry, index) => {
              const share =
                summary.metrics.totalSpent > 0 ? Number(((entry.total / summary.metrics.totalSpent) * 100).toFixed(1)) : 0;
              return (
                <div className="category-table-row" key={entry.category}>
                  <div className="category-table-label">
                    <i style={{ background: chartPalette[index % chartPalette.length] }} />
                    <span>{entry.category}</span>
                  </div>
                  <strong>{formatCurrency(entry.total)}</strong>
                  <span>{share}%</span>
                </div>
              );
            })}
          </div>
        </article>

      </div>
        </div>
      </div>
    </section>
  );
}
