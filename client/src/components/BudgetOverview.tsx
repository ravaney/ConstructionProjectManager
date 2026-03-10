import { useEffect, useMemo, useState } from "react";
import type { DashboardSummary, Project } from "../types/models";
import { formatCurrency } from "../utils/format";

type BudgetOverviewProps = {
  summary: DashboardSummary | null;
  project: Project | null;
  canEditBudget: boolean;
  onUpdateBudget: (totalBudget: number) => Promise<void>;
};

export function BudgetOverview({ summary, project, canEditBudget, onUpdateBudget }: BudgetOverviewProps) {
  const [budgetInput, setBudgetInput] = useState(project?.totalBudget ?? 100000);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (project) {
      setBudgetInput(project.totalBudget);
    }
  }, [project]);

  const maxCategory = useMemo(() => {
    if (!summary || summary.categoryTotals.length === 0) {
      return 1;
    }

    return Math.max(...summary.categoryTotals.map((item) => item.total), 1);
  }, [summary]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canEditBudget) {
      return;
    }

    setSaving(true);

    try {
      await onUpdateBudget(budgetInput);
    } finally {
      setSaving(false);
    }
  }

  if (!summary) {
    return <section className="panel">Loading dashboard...</section>;
  }

  return (
    <section className="stack-lg">
      <div className="metrics-grid">
        <article className="metric-card">
          <p className="metric-label">Total Budget</p>
          <h3>{formatCurrency(summary.metrics.totalBudget)}</h3>
        </article>
        <article className="metric-card danger">
          <p className="metric-label">Spent (Paid)</p>
          <h3>{formatCurrency(summary.metrics.totalSpent)}</h3>
        </article>
        <article className="metric-card">
          <p className="metric-label">Committed (Unpaid)</p>
          <h3>{formatCurrency(summary.metrics.unpaidCommitted)}</h3>
        </article>
        <article className="metric-card success">
          <p className="metric-label">Remaining Cash</p>
          <h3>{formatCurrency(summary.metrics.remainingBudget)}</h3>
        </article>
      </div>

      <div className="metrics-grid">
        <article className="metric-card">
          <p className="metric-label">Remaining After Commitments</p>
          <h3>{formatCurrency(summary.metrics.remainingAfterCommitments)}</h3>
        </article>
        <article className="metric-card">
          <p className="metric-label">Open Invoice Count</p>
          <h3>{summary.metrics.unpaidInvoiceCount}</h3>
        </article>
        <article className="metric-card">
          <p className="metric-label">Budget Burn</p>
          <h3>{summary.metrics.burnRate}%</h3>
        </article>
      </div>

      <form className="panel inline-form" onSubmit={handleSubmit}>
        <div>
          <h3>Project Budget</h3>
          <p className="muted">
            {canEditBudget ? "Update your phase budget anytime." : "Only owner can change budget values."}
          </p>
        </div>
        <label>
          Total Budget (USD)
          <input
            type="number"
            min={1}
            value={budgetInput}
            disabled={!canEditBudget}
            onChange={(event) => setBudgetInput(Number(event.target.value))}
          />
        </label>
        <button className="btn" type="submit" disabled={saving || !canEditBudget}>
          {saving ? "Saving..." : "Save Budget"}
        </button>
      </form>

      <div className="panel">
        <h3>Category Spend (Paid)</h3>
        <div className="stack-sm">
          {summary.categoryTotals.map((entry) => (
            <div className="bar-row" key={entry.category}>
              <span>{entry.category}</span>
              <div className="bar-track">
                <span style={{ width: `${Math.max((entry.total / maxCategory) * 100, 4)}%` }} />
              </div>
              <strong>{formatCurrency(entry.total)}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="two-col">
        <div className="panel">
          <h3>Monthly Spend</h3>
          <div className="stack-sm">
            {summary.monthlySpend.length === 0 && <p className="muted">No monthly data yet.</p>}
            {summary.monthlySpend.map((entry) => (
              <div className="row-between" key={entry.month}>
                <span>{entry.month}</span>
                <strong>{formatCurrency(entry.total)}</strong>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h3>Task Status Snapshot</h3>
          <div className="stack-sm">
            {summary.taskCounts.length === 0 && <p className="muted">No tasks added yet.</p>}
            {summary.taskCounts.map((entry) => (
              <div className="row-between" key={entry._id}>
                <span>{entry._id.replace("_", " ")}</span>
                <strong>{entry.count}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}