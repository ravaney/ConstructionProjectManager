import { useEffect, useMemo, useState } from "react";
import type { DashboardSummary, Task, TaskStatus } from "../types/models";
import { formatCurrency } from "../utils/format";
import { getChildTasks, getCurrentPhase, getPhaseNodes, getSectionsForPhase } from "../utils/workBreakdown";

type BudgetOverviewProps = {
  summary: DashboardSummary | null;
  tasks: Task[];
};

const chartPalette = ["#e76f72", "#7f6a8e", "#d88a66", "#c9a45d", "#8a7cc4", "#a5717e"];
const taskStatusColors: Record<TaskStatus, string> = {
  PLANNED: "#c6bcd0",
  IN_PROGRESS: "#e76f72",
  BLOCKED: "#d3915f",
  DONE: "#8b7099"
};
const summarySegmentColors = {
  materials: "#4fb4ff",
  land: "#f1c36d",
  labour: "#ff9b9f",
  equipment: "#b08cff",
  other: "#7f93a6",
  remaining: "#69d68f"
} as const;
const phaseExpenseColors: Record<TaskStatus, string> = {
  PLANNED: "#6f7f90",
  IN_PROGRESS: "#4fb4ff",
  BLOCKED: "#f1c36d",
  DONE: "#69d68f"
};

function formatTaskStatusLabel(status: TaskStatus): string {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function canDrillIntoNode(status: TaskStatus): boolean {
  return status === "IN_PROGRESS" || status === "DONE" || status === "BLOCKED";
}

export function BudgetOverview({ summary, tasks }: BudgetOverviewProps) {
  const phaseNodes = useMemo(() => getPhaseNodes(tasks), [tasks]);
  const currentPhase = useMemo(() => getCurrentPhase(tasks), [tasks]);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const selectedPhase = useMemo(
    () => phaseNodes.find((phase) => phase._id === selectedPhaseId),
    [phaseNodes, selectedPhaseId]
  );
  const sectionNodes = useMemo(
    () => getSectionsForPhase(tasks, selectedPhaseId ?? undefined),
    [tasks, selectedPhaseId]
  );
  const selectedSection = useMemo(
    () => sectionNodes.find((section) => section._id === selectedSectionId),
    [sectionNodes, selectedSectionId]
  );
  const subsectionNodes = useMemo(
    () => getChildTasks(tasks, selectedSectionId ?? undefined),
    [tasks, selectedSectionId]
  );

  useEffect(() => {
    if (selectedPhaseId && !phaseNodes.some((phase) => phase._id === selectedPhaseId)) {
      setSelectedPhaseId(null);
      setSelectedSectionId(null);
      return;
    }

    if (selectedSectionId && !sectionNodes.some((section) => section._id === selectedSectionId)) {
      setSelectedSectionId(null);
    }
  }, [phaseNodes, sectionNodes, selectedPhaseId, selectedSectionId]);

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

  const phaseExpenseExplorer = useMemo(() => {
    const sourceNodes = selectedSection ? subsectionNodes : selectedPhase ? sectionNodes : phaseNodes;
    const levelLabel = selectedSection ? "Subsections" : selectedPhase ? "Sections" : "Phases";
    const emptyMessage = selectedSection
      ? "No subsections or tasks have been added under this section yet."
      : selectedPhase
        ? "No sections have been created for this phase yet."
        : "Create phases in Project Tasks to start tracking phase costs.";

    const baseRows = sourceNodes.map((node) => {
      const estimate = node.financials.rolledEstimate;
      const spent = node.financials.rolledSpent;
      const committed = node.financials.rolledCommitted;
      const costToDate = spent + committed;
      const displayCost = node.status === "PLANNED" ? estimate : costToDate;
      const childCount = selectedSection
        ? 0
        : selectedPhase
          ? getChildTasks(tasks, node._id).length
          : getSectionsForPhase(tasks, node._id).length;
      const clickable = childCount > 0 && !selectedSection && canDrillIntoNode(node.status);

      return {
        _id: node._id,
        title: node.title,
        status: node.status,
        estimate,
        spent,
        committed,
        displayCost,
        progress: node.progress.percentComplete,
        isCurrent: node._id === currentPhase?._id,
        clickable,
        color: phaseExpenseColors[node.status],
        childCount
      };
    });

    const maxCost = Math.max(
      ...baseRows.map((row) => Math.max(row.displayCost, row.estimate, row.spent + row.committed, 1)),
      1
    );

    return {
      levelLabel,
      emptyMessage,
      rows: baseRows.map((row) => ({
        ...row,
        ratio: row.displayCost > 0 ? Math.max((row.displayCost / maxCost) * 100, 4) : 0,
        totalLabel: row.status === "PLANNED" ? "Estimated" : "Cost to date"
      }))
    };
  }, [currentPhase?._id, phaseNodes, sectionNodes, selectedPhase, selectedSection, subsectionNodes, tasks]);

  const taskStatusRows = useMemo(() => {
    if (!summary) {
      return [];
    }

    const counts = new Map(summary.taskCounts.map((entry) => [entry._id, entry.count]));
    const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);

    return (["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE"] as TaskStatus[]).map((status) => ({
      status,
      count: counts.get(status) ?? 0,
      share: total > 0 ? Number((((counts.get(status) ?? 0) / total) * 100).toFixed(1)) : 0,
      color: taskStatusColors[status]
    }));
  }, [summary]);

  const phaseRows = useMemo(() => {
    return phaseNodes.slice(0, 5).map((phase) => ({
      _id: phase._id,
      title: phase.title,
      isCurrent: phase._id === currentPhase?._id,
      estimate: phase.financials.rolledEstimate,
      spent: phase.financials.rolledSpent,
      committed: phase.financials.rolledCommitted,
      remaining: phase.financials.remaining,
      progress: phase.progress.percentComplete,
      ratio:
        Math.max(phase.financials.rolledEstimate, 1) > 0
          ? Math.min(100, ((phase.financials.rolledSpent + phase.financials.rolledCommitted) / Math.max(phase.financials.rolledEstimate, 1)) * 100)
          : 0
    }));
  }, [currentPhase, phaseNodes]);

  if (!summary) {
    return <section className="panel">Loading dashboard...</section>;
  }

  return (
    <section className="stack-lg budget-dashboard-sheet">
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
              <h3>{selectedSection ? "Section Expenses" : selectedPhase ? "Phase Sections" : "Phase Expenses"}</h3>
              <p className="muted small-text">
                {selectedSection
                  ? "Task-level costs for this section."
                  : selectedPhase
                    ? "Section costs inside the selected phase. Planned sections show saved estimates."
                    : "Completed and active phases open drilldowns. Planned phases show saved estimates until AI forecasting is added in Project Tasks."}
              </p>
            </div>
            <div className="phase-expense-meta-stack">
              <span className="phase-expense-scope">{phaseExpenseExplorer.levelLabel}</span>
              <strong>{phaseExpenseExplorer.rows.length}</strong>
            </div>
          </div>

          <div className="phase-expense-breadcrumbs">
            <button
              className={!selectedPhase ? "active" : ""}
              type="button"
              onClick={() => {
                setSelectedPhaseId(null);
                setSelectedSectionId(null);
              }}
            >
              All Phases
            </button>
            {selectedPhase && (
              <button
                className={!selectedSection ? "active" : ""}
                type="button"
                onClick={() => setSelectedSectionId(null)}
              >
                {selectedPhase.title}
              </button>
            )}
            {selectedSection && <span>{selectedSection.title}</span>}
          </div>

          <div className="phase-expense-list">
            {phaseExpenseExplorer.rows.length === 0 ? (
              <p className="muted">{phaseExpenseExplorer.emptyMessage}</p>
            ) : (
              phaseExpenseExplorer.rows.map((row) => {
                const rowContent = (
                  <>
                    <div className="phase-expense-row-head">
                      <div className="phase-expense-row-copy">
                        <strong>{row.title}</strong>
                        <span>
                          {row.status === "PLANNED"
                            ? "Estimate only"
                            : row.clickable
                              ? `Open ${selectedPhase ? "subsections" : "sections"}`
                              : "No deeper items"}
                        </span>
                      </div>
                      <div className="phase-expense-row-side">
                        <span className={`phase-expense-status is-${row.status.toLowerCase()}`}>{formatTaskStatusLabel(row.status)}</span>
                        <strong>{formatCurrency(row.displayCost)}</strong>
                        <span>{row.totalLabel}</span>
                      </div>
                    </div>
                    <div className="phase-expense-bar">
                      <span style={{ width: `${row.ratio}%`, background: row.color }} />
                    </div>
                    <div className="phase-expense-row-meta">
                      <span>Estimate {formatCurrency(row.estimate)}</span>
                      <span>Spent {formatCurrency(row.spent)}</span>
                      <span>Committed {formatCurrency(row.committed)}</span>
                      <span>Progress {row.progress}%</span>
                    </div>
                  </>
                );

                if (row.clickable) {
                  return (
                    <button
                      className={`phase-expense-row is-clickable ${row.isCurrent ? "is-current" : ""}`}
                      key={row._id}
                      type="button"
                      onClick={() => {
                        if (selectedPhase) {
                          setSelectedSectionId(row._id);
                          return;
                        }

                        setSelectedPhaseId(row._id);
                        setSelectedSectionId(null);
                      }}
                    >
                      {rowContent}
                    </button>
                  );
                }

                return (
                  <div className={`phase-expense-row ${row.isCurrent ? "is-current" : ""} ${row.status === "PLANNED" ? "is-planned" : ""}`} key={row._id}>
                    {rowContent}
                  </div>
                );
              })
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

        <article className="panel budget-card phase-snapshot-card">
          <div className="card-title-row">
            <h3>Phase Snapshot</h3>
            <span className="muted small-text">{currentPhase?.title ?? "No active phase"}</span>
          </div>
          <div className="phase-snapshot-list">
            {phaseRows.length === 0 ? (
              <p className="muted">Create phases in Project Tasks to compare estimate, spend, and progress.</p>
            ) : (
              phaseRows.map((phase) => (
                <div className={`phase-snapshot-row ${phase.isCurrent ? "is-current" : ""}`} key={phase._id}>
                  <div className="phase-snapshot-head">
                    <strong>{phase.title}</strong>
                    <span>{phase.progress}%</span>
                  </div>
                  <div className="phase-snapshot-bar">
                    <span style={{ width: `${Math.max(phase.ratio, phase.spent > 0 || phase.committed > 0 ? 4 : 0)}%` }} />
                  </div>
                  <div className="phase-snapshot-meta">
                    <span>Estimate {formatCurrency(phase.estimate)}</span>
                    <span>Spent {formatCurrency(phase.spent)}</span>
                    <span>Committed {formatCurrency(phase.committed)}</span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="task-status-inline">
            {taskStatusRows.map((row) => (
              <div className="task-status-pill" key={row.status}>
                <i style={{ background: row.color }} />
                <span>{row.status.replace("_", " ")}</span>
                <strong>{row.count}</strong>
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}
