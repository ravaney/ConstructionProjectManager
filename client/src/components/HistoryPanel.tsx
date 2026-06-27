import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryAction, HistoryEntityType, HistoryEntry } from "../types/models";
import { api } from "../utils/api";
import { formatCalendarDate, formatCurrency } from "../utils/format";

const entityTypeOptions: Array<HistoryEntityType | "ALL"> = ["ALL", "PROJECT", "TASK", "EXPENSE", "INVOICE", "ESTIMATE_GROUP"];
const actionOptions: Array<HistoryAction | "ALL"> = [
  "ALL",
  "CREATE",
  "UPDATE",
  "DELETE",
  "STATUS_CHANGE",
  "MARK_PAID",
  "BUDGET_CHANGE",
  "BUILD_PLAN",
  "CLEAR_PHASES"
];

function HistoryMetaIcon({ kind }: { kind: "history" | "operation" | "actor" | "time" }) {
  switch (kind) {
    case "history":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5 6.2h6M5 8.1h6M5 10h3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "operation":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4.2 4.2h3.2v3.2H4.2zM8.6 8.6h3.2v3.2H8.6zM7.4 5.8h1.2v1h1v1.2H8.4v-1h-1z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M7.4 4.8h1.2M4.8 7.4v1.2M10 8.6h1.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "actor":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="5.2" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3.6 12.8c.6-2 2.3-3.2 4.4-3.2s3.8 1.2 4.4 3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "time":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 4.9v3.4l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return null;
  }
}

function HistoryFilterIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 3.5h11l-4.2 4.8v3.1l-2.1 1.1V8.3L2.5 3.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatHistoryDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function toDisplayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "--";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toLocaleString() : "--";
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatFieldLabel(field: string): string {
  return field
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function summarizeFieldChange(field: string, before: unknown, after: unknown): string {
  return `${formatFieldLabel(field)}: ${toDisplayValue(before)} -> ${toDisplayValue(after)}`;
}

function toNumberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function buildExpenseAllocationEffect(entry: HistoryEntry): { detail: string; highlights: string[] } | null {
  if (entry.entityType !== "EXPENSE") {
    return null;
  }

  const currency = entry.moneyImpact?.currency ?? "USD";
  const beforeCategory = typeof entry.before?.category === "string" ? entry.before.category.trim() : "";
  const afterCategory = typeof entry.after?.category === "string" ? entry.after.category.trim() : "";
  const beforeAmount = toNumberValue(entry.before?.amount) ?? entry.moneyImpact?.before ?? 0;
  const afterAmount = toNumberValue(entry.after?.amount) ?? entry.moneyImpact?.after ?? 0;
  const delta = Number((afterAmount - beforeAmount).toFixed(2));

  if (entry.action === "CREATE" && afterCategory) {
    return {
      detail: `This added ${formatCurrency(afterAmount, currency)} into ${afterCategory} allocation.`,
      highlights: [`${afterCategory}: +${formatCurrency(afterAmount, currency)}`]
    };
  }

  if (entry.action === "DELETE" && beforeCategory) {
    return {
      detail: `This removed ${formatCurrency(beforeAmount, currency)} from ${beforeCategory} allocation.`,
      highlights: [`${beforeCategory}: -${formatCurrency(beforeAmount, currency)}`]
    };
  }

  if (beforeCategory && afterCategory && beforeCategory !== afterCategory) {
    const highlights = [
      `${beforeCategory}: -${formatCurrency(beforeAmount, currency)}`,
      `${afterCategory}: +${formatCurrency(afterAmount, currency)}`
    ];
    if (delta !== 0) {
      highlights.push(`Net spend impact: ${delta > 0 ? "+" : "-"}${formatCurrency(Math.abs(delta), currency)}`);
    }

    return {
      detail:
        `This reclassified the expense from ${beforeCategory} to ${afterCategory}, ` +
        `moving ${formatCurrency(beforeAmount, currency)} out of ${beforeCategory} and ${formatCurrency(afterAmount, currency)} into ${afterCategory}.` +
        (delta !== 0
          ? ` Overall spend changed by ${delta > 0 ? "an increase of" : "a decrease of"} ${formatCurrency(Math.abs(delta), currency)}.`
          : ""),
      highlights
    };
  }

  const effectiveCategory = afterCategory || beforeCategory;
  if (effectiveCategory && delta !== 0) {
    return {
      detail:
        `This ${delta > 0 ? "increased" : "decreased"} ${effectiveCategory} allocation by ${formatCurrency(Math.abs(delta), currency)}, ` +
        `from ${formatCurrency(beforeAmount, currency)} to ${formatCurrency(afterAmount, currency)}.`,
      highlights: [`${effectiveCategory}: ${formatCurrency(beforeAmount, currency)} -> ${formatCurrency(afterAmount, currency)}`]
    };
  }

  return null;
}

function buildFallbackNarrative(entry: HistoryEntry): NonNullable<HistoryEntry["narrative"]> {
  const allocationEffect = buildExpenseAllocationEffect(entry);
  const moneyCurrency = entry.moneyImpact?.currency ?? "USD";
  const highlights = entry.changedFields
    .slice(0, 5)
    .map((field) => summarizeFieldChange(field.field, field.before, field.after));

  if (allocationEffect) {
    highlights.unshift(...allocationEffect.highlights);
  }

  if (entry.moneyImpact) {
    highlights.push(
      `${entry.moneyImpact.label}: ${formatCurrency(entry.moneyImpact.before, moneyCurrency)} -> ${formatCurrency(entry.moneyImpact.after, moneyCurrency)}`
    );
    if (entry.moneyImpact.jmdConversion && moneyCurrency !== "JMD") {
      highlights.push(
        `JMD @ ${formatCalendarDate(entry.moneyImpact.jmdConversion.rateDate)}: ${formatCurrency(entry.moneyImpact.jmdConversion.before, "JMD")} -> ${formatCurrency(entry.moneyImpact.jmdConversion.after, "JMD")}`
      );
    }
  }

  const scopeText = [entry.scope?.phase, entry.scope?.section, entry.scope?.subsection].filter(Boolean).join(" / ");
  const fieldText =
    entry.changedFields.length > 0
      ? `${entry.changedFields.length} field${entry.changedFields.length === 1 ? "" : "s"} changed.`
      : "No field-level changes were recorded.";
  const moneyText = entry.moneyImpact
    ? `${entry.moneyImpact.label} changed by ${formatCurrency(entry.moneyImpact.delta, moneyCurrency)}.`
    : "";
  const moneyConversionText =
    entry.moneyImpact?.jmdConversion && moneyCurrency !== "JMD"
      ? ` Jamaican dollar equivalent on ${formatCalendarDate(entry.moneyImpact.jmdConversion.rateDate)} was ${formatCurrency(entry.moneyImpact.jmdConversion.delta, "JMD")}.`
      : "";
  const allocationText = allocationEffect ? ` ${allocationEffect.detail}` : "";

  return {
    detail: `${entry.summary}. ${fieldText}${moneyText ? ` ${moneyText}` : ""}${moneyConversionText}${allocationText}${scopeText ? ` Scope: ${scopeText}.` : ""}`.trim(),
    highlights: highlights.slice(0, 5),
    provider: "fallback"
  };
}

type HistoryPanelProps = {
  onOpenTask?: (taskId: string) => void;
};

export function HistoryPanel({ onOpenTask }: HistoryPanelProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [entityType, setEntityType] = useState<HistoryEntityType | "ALL">("ALL");
  const [action, setAction] = useState<HistoryAction | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [moneyOnly, setMoneyOnly] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [showExpandedDetail, setShowExpandedDetail] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let ignore = false;

    async function loadHistory() {
      setLoading(true);
      setError("");
      try {
        const response = await api.getHistory({
          entityType,
          action,
          search,
          moneyOnly,
          from: fromDate || undefined,
          to: toDate || undefined,
          limit: 200
        });

        if (ignore) {
          return;
        }

        setEntries(response.entries);
        setSelectedHistoryId((current) => {
          if (current && response.entries.some((entry) => entry.historyId === current)) {
            return current;
          }

          return response.entries[0]?.historyId ?? "";
        });
      } catch (requestError) {
        if (!ignore) {
          setError(requestError instanceof Error ? requestError.message : "Could not load history.");
          setEntries([]);
          setSelectedHistoryId("");
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    loadHistory().catch(() => {
      // State handled above.
    });

    return () => {
      ignore = true;
    };
  }, [action, entityType, fromDate, moneyOnly, search, toDate]);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.historyId === selectedHistoryId) ?? entries[0] ?? null,
    [entries, selectedHistoryId]
  );
  const selectedNarrative = useMemo(
    () => (selectedEntry ? selectedEntry.narrative ?? buildFallbackNarrative(selectedEntry) : null),
    [selectedEntry]
  );
  const selectedTaskId = useMemo(() => {
    if (!selectedEntry || selectedEntry.entityType !== "TASK") {
      return "";
    }

    const afterNodeType = typeof selectedEntry.after?.nodeType === "string" ? selectedEntry.after.nodeType : "";
    const beforeNodeType = typeof selectedEntry.before?.nodeType === "string" ? selectedEntry.before.nodeType : "";
    const nodeType = afterNodeType || beforeNodeType;

    return nodeType === "TASK" ? selectedEntry.entityId : "";
  }, [selectedEntry]);
  const canOpenSelectedTask = Boolean(
    selectedEntry && selectedEntry.action !== "DELETE" && selectedTaskId && onOpenTask
  );
  const selectedAllocationEffect = useMemo(
    () => (selectedEntry ? buildExpenseAllocationEffect(selectedEntry) : null),
    [selectedEntry]
  );
  const hasExpandedDetail = useMemo(() => {
    if (!selectedEntry) {
      return false;
    }

    return Boolean(
      selectedEntry.moneyImpact ||
        selectedEntry.scope ||
        selectedEntry.changedFields.length > 0 ||
        selectedEntry.before ||
        selectedEntry.after ||
        selectedEntry.metadata
    );
  }, [selectedEntry]);

  useEffect(() => {
    setShowExpandedDetail(false);
  }, [selectedHistoryId]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!filterMenuRef.current) {
        return;
      }

      if (!filterMenuRef.current.contains(event.target as Node)) {
        setFilterMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (entityType !== "ALL") {
      count += 1;
    }
    if (action !== "ALL") {
      count += 1;
    }
    if (moneyOnly) {
      count += 1;
    }
    if (fromDate) {
      count += 1;
    }
    if (toDate) {
      count += 1;
    }
    return count;
  }, [action, entityType, fromDate, moneyOnly, toDate]);

  function clearFilters() {
    setEntityType("ALL");
    setAction("ALL");
    setMoneyOnly(false);
    setFromDate("");
    setToDate("");
  }

  return (
    <div className="history-layout">
      <section className="history-list-panel">
        <div className="history-toolbar">
          <div className="history-toolbar-summary">
            <strong>History</strong>
            <span>{loading ? "Loading..." : `${entries.length} entries`}</span>
          </div>
          <div className="history-filter-wrap" ref={filterMenuRef}>
            <button
              type="button"
              className={`history-filter-btn ${filterMenuOpen ? "active" : ""}`}
              onClick={() => setFilterMenuOpen((current) => !current)}
            >
              <HistoryFilterIcon />
              <span>Filters</span>
              {activeFilterCount > 0 && <span className="history-filter-count">{activeFilterCount}</span>}
            </button>
            {filterMenuOpen && (
              <div className="history-filter-menu">
                <div className="history-filter-menu-head">
                  <strong>Filter History</strong>
                  <button type="button" className="history-filter-clear" onClick={clearFilters}>
                    Reset
                  </button>
                </div>
                <label className="history-filter-field">
                  <span>Entity</span>
                  <select value={entityType} onChange={(event) => setEntityType(event.target.value as HistoryEntityType | "ALL")}>
                    {entityTypeOptions.map((option) => (
                      <option key={option} value={option}>
                        {option === "ALL" ? "All Entities" : option}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="history-filter-field">
                  <span>Action</span>
                  <select value={action} onChange={(event) => setAction(event.target.value as HistoryAction | "ALL")}>
                    {actionOptions.map((option) => (
                      <option key={option} value={option}>
                        {option === "ALL" ? "All Actions" : option.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="history-filter-field">
                  <span>From Date</span>
                  <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
                </label>
                <label className="history-filter-field">
                  <span>To Date</span>
                  <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
                </label>
                <label className="history-filter-checkbox">
                  <input type="checkbox" checked={moneyOnly} onChange={(event) => setMoneyOnly(event.target.checked)} />
                  <span>Financial changes only</span>
                </label>
              </div>
            )}
          </div>
        </div>

        {loading ? (
          <div className="history-empty-state">Loading history...</div>
        ) : error ? (
          <div className="history-empty-state error-text">{error}</div>
        ) : entries.length === 0 ? (
          <div className="history-empty-state">No history entries match these filters.</div>
        ) : (
          <div className="history-entry-list">
            {entries.map((entry) => (
              <button
                key={entry.historyId}
                type="button"
                className={`history-entry-card ${selectedEntry?.historyId === entry.historyId ? "active" : ""}`}
                onClick={() => setSelectedHistoryId(entry.historyId)}
              >
                <div className="history-entry-card-top">
                  <span className={`history-action-pill action-${entry.action.toLowerCase()}`}>{entry.action.replace(/_/g, " ")}</span>
                  <span className="history-entry-time">{formatHistoryDate(entry.createdAt)}</span>
                </div>
                <strong>{entry.summary}</strong>
                <span className="history-entry-meta">
                  {entry.actor.name} - {entry.entityType} - {entry.entityLabel}
                </span>
                {entry.moneyImpact && (
                  <>
                    <span className={`history-money-delta ${entry.moneyImpact.delta >= 0 ? "positive" : "negative"}`}>
                      {entry.moneyImpact.label}: {formatCurrency(entry.moneyImpact.delta, entry.moneyImpact.currency)}
                    </span>
                    {entry.moneyImpact.jmdConversion && entry.moneyImpact.currency !== "JMD" && (
                      <span className="history-money-conversion-note">
                        JMD: {formatCurrency(entry.moneyImpact.jmdConversion.delta, "JMD")} on{" "}
                        {formatCalendarDate(entry.moneyImpact.jmdConversion.rateDate)}
                      </span>
                    )}
                  </>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="history-search-dock">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search history"
          />
        </div>
      </section>

      <aside className="history-detail-panel">
        {!selectedEntry ? (
          <div className="history-empty-state">Select a history entry to inspect its details.</div>
        ) : (
          <div className="history-detail-content">
            <div className="history-detail-head">
              <div className="history-detail-topline">
                <div className="history-detail-main">
                  <p className="eyebrow">History Detail</p>
                  <h3>{selectedEntry.summary}</h3>
                </div>
                <div className="history-detail-actions">
                  <div className="history-detail-badges">
                    <span className={`history-detail-badge history-entity-badge entity-${selectedEntry.entityType.toLowerCase()}`}>
                      {selectedEntry.entityType}
                    </span>
                    <span className={`history-action-pill action-${selectedEntry.action.toLowerCase()}`}>
                      {selectedEntry.action.replace(/_/g, " ")}
                    </span>
                    {canOpenSelectedTask && (
                      <button
                        type="button"
                        className="history-view-task-chip"
                        onClick={() => onOpenTask?.(selectedTaskId)}
                      >
                        View Task
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="history-primary-meta history-primary-meta-strip">
                <div className="history-primary-meta-item history-primary-meta-card">
                  <span className="history-primary-meta-label-row">
                    <span className="history-primary-meta-icon">
                      <HistoryMetaIcon kind="history" />
                    </span>
                    <span className="history-primary-meta-label">History ID</span>
                  </span>
                  <strong className="history-primary-meta-value history-primary-meta-code">{selectedEntry.historyId}</strong>
                </div>
                <div className="history-primary-meta-item history-primary-meta-card">
                  <span className="history-primary-meta-label-row">
                    <span className="history-primary-meta-icon">
                      <HistoryMetaIcon kind="operation" />
                    </span>
                    <span className="history-primary-meta-label">Operation ID</span>
                  </span>
                  <strong className="history-primary-meta-value history-primary-meta-code">{selectedEntry.operationId}</strong>
                </div>
                <div className="history-primary-meta-item history-primary-meta-card">
                  <span className="history-primary-meta-label-row">
                    <span className="history-primary-meta-icon">
                      <HistoryMetaIcon kind="actor" />
                    </span>
                    <span className="history-primary-meta-label">Actor</span>
                  </span>
                  <strong className="history-primary-meta-value">
                    {selectedEntry.actor.name} - {selectedEntry.actor.role}
                  </strong>
                </div>
                <div className="history-primary-meta-item history-primary-meta-card">
                  <span className="history-primary-meta-label-row">
                    <span className="history-primary-meta-icon">
                      <HistoryMetaIcon kind="time" />
                    </span>
                    <span className="history-primary-meta-label">Timestamp</span>
                  </span>
                  <strong className="history-primary-meta-value">{formatHistoryDate(selectedEntry.createdAt)}</strong>
                </div>
              </div>
            </div>

            {selectedNarrative && (
              <section className="history-section">
                <div className="history-narrative-panel">
                  <div className="history-narrative-head">
                    <h4>Change Narrative</h4>
                    <span className="history-detail-badge">
                      {selectedNarrative.provider === "openai" ? "AI Generated" : "Structured Fallback"}
                    </span>
                  </div>
                  <p className="history-narrative-detail">{selectedNarrative.detail}</p>
                  {selectedNarrative.highlights.length > 0 && (
                    <ul className="history-narrative-highlights">
                      {selectedNarrative.highlights.map((highlight) => (
                        <li key={`${selectedEntry.historyId}-${highlight}`}>{highlight}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            )}

            {selectedAllocationEffect && (
              <section className="history-section">
                <div className="history-allocation-panel">
                  <div className="history-narrative-head">
                    <h4>Cost Allocation Effect</h4>
                    <span className="history-detail-badge">Expense Allocation</span>
                  </div>
                  <p className="history-narrative-detail">{selectedAllocationEffect.detail}</p>
                  {selectedAllocationEffect.highlights.length > 0 && (
                    <ul className="history-narrative-highlights">
                      {selectedAllocationEffect.highlights.map((highlight) => (
                        <li key={`${selectedEntry.historyId}-allocation-${highlight}`}>{highlight}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            )}

            {hasExpandedDetail && (
              <section className="history-section history-section-collapsible">
                <button
                  type="button"
                  className={`history-collapse-toggle ${showExpandedDetail ? "expanded" : ""}`}
                  onClick={() => setShowExpandedDetail((current) => !current)}
                >
                  <span>{showExpandedDetail ? "Hide raw change detail" : "Show raw change detail"}</span>
                  <span className="history-collapse-toggle-icon" aria-hidden="true">
                    {showExpandedDetail ? "−" : "+"}
                  </span>
                </button>

                {showExpandedDetail && (
                  <div className="history-expanded-detail">
                    {selectedEntry.moneyImpact && (
                      <section className="history-money-panel">
                        <div>
                          <span className="muted">{selectedEntry.moneyImpact.label}</span>
                          <strong>{selectedEntry.moneyImpact.currency}</strong>
                        </div>
                        <div>
                          <span className="muted">Before</span>
                          <strong>{formatCurrency(selectedEntry.moneyImpact.before, selectedEntry.moneyImpact.currency)}</strong>
                        </div>
                        <div>
                          <span className="muted">After</span>
                          <strong>{formatCurrency(selectedEntry.moneyImpact.after, selectedEntry.moneyImpact.currency)}</strong>
                        </div>
                        <div>
                          <span className="muted">Delta</span>
                          <strong className={selectedEntry.moneyImpact.delta >= 0 ? "positive-text" : "negative-text"}>
                            {formatCurrency(selectedEntry.moneyImpact.delta, selectedEntry.moneyImpact.currency)}
                          </strong>
                        </div>
                        {selectedEntry.moneyImpact.jmdConversion && selectedEntry.moneyImpact.currency !== "JMD" && (
                          <>
                            <div className="history-money-conversion-block">
                              <span className="muted">JMD Before</span>
                              <strong>{formatCurrency(selectedEntry.moneyImpact.jmdConversion.before, "JMD")}</strong>
                            </div>
                            <div className="history-money-conversion-block">
                              <span className="muted">JMD After</span>
                              <strong>{formatCurrency(selectedEntry.moneyImpact.jmdConversion.after, "JMD")}</strong>
                            </div>
                            <div className="history-money-conversion-block">
                              <span className="muted">JMD Delta</span>
                              <strong className={selectedEntry.moneyImpact.jmdConversion.delta >= 0 ? "positive-text" : "negative-text"}>
                                {formatCurrency(selectedEntry.moneyImpact.jmdConversion.delta, "JMD")}
                              </strong>
                            </div>
                            <div className="history-money-conversion-block">
                              <span className="muted">JMD Rate</span>
                              <strong>
                                {selectedEntry.moneyImpact.jmdConversion.rate.toLocaleString(undefined, {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 4
                                })}{" "}
                                on {formatCalendarDate(selectedEntry.moneyImpact.jmdConversion.rateDate)}
                              </strong>
                            </div>
                          </>
                        )}
                      </section>
                    )}

                    {selectedEntry.scope && (
                      <section className="history-section history-nested-section">
                        <h4>Scope</h4>
                        <div className="history-meta-grid">
                          <div>
                            <span className="muted">Phase</span>
                            <strong>{selectedEntry.scope.phase || "--"}</strong>
                          </div>
                          <div>
                            <span className="muted">Section</span>
                            <strong>{selectedEntry.scope.section || "--"}</strong>
                          </div>
                          <div>
                            <span className="muted">Subsection</span>
                            <strong>{selectedEntry.scope.subsection || "--"}</strong>
                          </div>
                        </div>
                      </section>
                    )}

                    <section className="history-section history-nested-section">
                      <h4>Changed Fields</h4>
                      {selectedEntry.changedFields.length === 0 ? (
                        <p className="muted">No field-level changes were recorded for this event.</p>
                      ) : (
                        <div className="history-changed-section">
                          <div className="history-change-summary">
                            <strong>
                              {selectedEntry.changedFields.length} field{selectedEntry.changedFields.length === 1 ? "" : "s"} changed
                            </strong>
                            <div className="history-change-summary-list">
                              {selectedEntry.changedFields.map((field) => (
                                <span key={`${selectedEntry.historyId}-summary-${field.field}`}>
                                  {summarizeFieldChange(field.field, field.before, field.after)}
                                </span>
                              ))}
                            </div>
                          </div>

                          <div className="history-changed-list">
                            {selectedEntry.changedFields.map((field) => (
                              <div className="history-changed-card" key={`${selectedEntry.historyId}-${field.field}`}>
                                <div className="history-changed-head">
                                  <strong>{formatFieldLabel(field.field)}</strong>
                                  <span className="history-field-updated">Updated</span>
                                </div>
                                <div className="history-changed-values">
                                  <div className="history-value-panel before">
                                    <span className="history-value-label">Before</span>
                                    <code>{toDisplayValue(field.before)}</code>
                                  </div>
                                  <div className="history-change-arrow" aria-hidden="true">
                                    <span>{"->"}</span>
                                  </div>
                                  <div className="history-value-panel after">
                                    <span className="history-value-label">After</span>
                                    <code>{toDisplayValue(field.after)}</code>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </section>

                    {(selectedEntry.before || selectedEntry.after || selectedEntry.metadata) && (
                      <section className="history-section history-nested-section">
                        <h4>Snapshots</h4>
                        <div className="history-snapshot-grid">
                          {selectedEntry.before && (
                            <div className="history-snapshot-card">
                              <span className="muted">Before</span>
                              <pre>{JSON.stringify(selectedEntry.before, null, 2)}</pre>
                            </div>
                          )}
                          {selectedEntry.after && (
                            <div className="history-snapshot-card">
                              <span className="muted">After</span>
                              <pre>{JSON.stringify(selectedEntry.after, null, 2)}</pre>
                            </div>
                          )}
                          {selectedEntry.metadata && (
                            <div className="history-snapshot-card">
                              <span className="muted">Metadata</span>
                              <pre>{JSON.stringify(selectedEntry.metadata, null, 2)}</pre>
                            </div>
                          )}
                        </div>
                      </section>
                    )}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
