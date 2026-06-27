import { useEffect, useRef, useState } from "react";
import type { Task, TaskInput, TaskStatus } from "../types/models";
import { getTaskStatusLabel, taskStatuses } from "../utils/taskStatus";

type TaskAlertDrawerProps = {
  task: Task | null;
  open: boolean;
  mode?: "edit" | "readonly";
  onClose: () => void;
  onUpdateTask: (id: string, payload: Partial<TaskInput>) => Promise<void>;
  onViewInProject?: (taskId: string) => void;
};

function toDateInputValue(value?: string): string {
  if (!value) {
    return "";
  }

  return value.slice(0, 10);
}

function parseEstimateInput(value: string): number {
  const cleaned = value.replace(/,/g, "").trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatEstimateInput(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "";
  }

  return value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: value % 1 === 0 ? 0 : 2
  });
}

function formatEstimateEditorValue(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "";
  }

  return value === 0 ? "0" : String(value);
}

function formatReadonlyDate(value?: string): string {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function getPriorityLabel(priority: Task["priority"]): string {
  return priority.charAt(0) + priority.slice(1).toLowerCase();
}

function openDateInputPicker(input: HTMLInputElement) {
  const pickerInput = input as HTMLInputElement & { showPicker?: () => void };
  pickerInput.showPicker?.();
}

function TaskReadonlyIcon({ kind }: { kind: "state" | "date" | "owner" | "priority" | "estimate" | "reference" }) {
  switch (kind) {
    case "state":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="m5.4 8.1 1.7 1.7 3.5-3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "date":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.4" y="3.2" width="11.2" height="10.1" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5.2 2.2v2.2M10.8 2.2v2.2M2.4 6h11.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "owner":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="5.1" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3.8 12.9c.6-1.9 2.3-3 4.2-3s3.6 1.1 4.2 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "priority":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 13.3V2.7m0 0h6l-1.5 2.5L10 7.7H4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "estimate":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2.4v11.2M10.7 4.6A2.6 2.6 0 0 0 8 3.2c-1.4 0-2.5.7-2.5 1.9 0 2.9 5.1 1.4 5.1 4 0 1.1-1 1.9-2.6 1.9A3.3 3.3 0 0 1 5 9.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "reference":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.2 4.1h9.6M3.2 8h9.6M3.2 11.9h5.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    default:
      return null;
  }
}

function DrawerCloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function TaskAlertDrawer({
  task,
  open,
  mode = "edit",
  onClose,
  onUpdateTask,
  onViewInProject
}: TaskAlertDrawerProps) {
  const [form, setForm] = useState<Partial<TaskInput>>({});
  const [estimateInput, setEstimateInput] = useState("");
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  const isReadOnly = mode === "readonly";

  useEffect(() => {
    if (!task) {
      setForm({});
      setEstimateInput("");
      return;
    }

    setForm({
      title: task.title,
      description: task.description,
      owner: task.owner,
      status: task.status,
      priority: task.priority,
      estimateAmount: task.estimateAmount,
      dueDate: toDateInputValue(task.dueDate),
      actualStartDate: toDateInputValue(task.actualStartDate),
      actualEndDate: toDateInputValue(task.actualEndDate)
    });
    setEstimateInput(formatEstimateEditorValue(task.estimateAmount));
  }, [task]);

  useEffect(() => {
    if (isReadOnly) {
      return;
    }

    const titleArea = titleRef.current;
    if (titleArea) {
      titleArea.style.height = "auto";
      titleArea.style.height = `${titleArea.scrollHeight}px`;
      titleArea.style.overflowY = "hidden";
    }

    const textarea = notesRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    const minHeight = 136;
    const maxHeight = 300;
    const nextHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [form.description, isReadOnly, open]);

  if (!open || !task) {
    return null;
  }

  const activeTask = task;
  const ownerDisplayName = activeTask.owner?.trim() || "Unassigned";
  const headerPhase = activeTask.phase?.trim() || "No phase";
  const headerSection = activeTask.section?.trim() || "";
  const estimateManagedByGroup = Boolean(activeTask.estimateGroupId);

  async function handleSave() {
    setSaving(true);
    try {
      await onUpdateTask(activeTask._id, form);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusToggle() {
    setSaving(true);
    try {
      await onUpdateTask(activeTask._id, { status: activeTask.status === "DONE" ? "PLANNED" : "DONE" });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="global-task-drawer-backdrop" onClick={() => !saving && onClose()}>
      <aside className="global-task-drawer" role="dialog" aria-modal="true" aria-labelledby="global-task-drawer-title" onClick={(event) => event.stopPropagation()}>
        <header className="global-task-drawer-head">
          <div>
            {isReadOnly ? (
              <div className="global-task-drawer-readonly-head">
                <p className="eyebrow">Task Snapshot</p>
                <p className="global-task-drawer-phase">{headerPhase}</p>
                {headerSection ? <p className="global-task-drawer-section">{headerSection}</p> : null}
                <h3 className="global-task-drawer-readonly-title" id="global-task-drawer-title">
                  {activeTask.title}
                </h3>
                <p className="global-task-drawer-context">WBS ID {activeTask.wbsId?.trim() || "--"}</p>
              </div>
            ) : (
              <div className="global-task-drawer-readonly-head">
                <p className="eyebrow">Edit Task</p>
                <p className="global-task-drawer-phase">{headerPhase}</p>
                {headerSection ? <p className="global-task-drawer-section">{headerSection}</p> : null}
                  <textarea
                    ref={titleRef}
                    id="global-task-drawer-title"
                    className="global-task-drawer-title-input"
                    rows={1}
                    value={form.title ?? ""}
                    onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                    aria-label="Task title"
                  />
                  <p className="global-task-drawer-context">WBS ID {activeTask.wbsId?.trim() || "--"}</p>
              </div>
            )}
          </div>
          <button className="global-task-drawer-close" type="button" onClick={onClose} disabled={saving} aria-label="Close task details">
            <DrawerCloseIcon />
          </button>
        </header>

        {isReadOnly ? (
          <div className="global-task-readonly-sheet">
            <div className="global-task-owner-hero">
              <div className="global-task-owner-avatar" aria-hidden="true">
                <TaskReadonlyIcon kind="owner" />
              </div>
              <div className="global-task-owner-copy">
                <strong className="global-task-owner-name">{ownerDisplayName}</strong>
              </div>
            </div>

            <div className="global-task-readonly-notes-block">
              {(activeTask.wbsId?.trim() || activeTask.predecessorWbsId?.trim()) ? (
                <div className="global-task-readonly-notes-meta-row">
                  {activeTask.wbsId?.trim() ? (
                    <p className="global-task-readonly-notes-meta">WBS ID: {activeTask.wbsId.trim()}</p>
                  ) : null}
                  {activeTask.predecessorWbsId?.trim() ? (
                    <p className="global-task-readonly-notes-meta">Predecessor: {activeTask.predecessorWbsId.trim()}</p>
                  ) : null}
                </div>
              ) : null}
              <div className="global-task-readonly-notes">
                {activeTask.description?.trim() || "No notes recorded."}
              </div>
            </div>

            <div className="global-task-readonly-rows">
              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="state" />
                  </span>
                  <span className="global-task-readonly-key-label">State</span>
                </div>
                <strong className="global-task-readonly-pill status">{getTaskStatusLabel(activeTask.status)}</strong>
              </div>

              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="date" />
                  </span>
                  <span className="global-task-readonly-key-label">Due</span>
                </div>
                <strong className="global-task-readonly-pill">{formatReadonlyDate(activeTask.dueDate)}</strong>
              </div>

              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="priority" />
                  </span>
                  <span className="global-task-readonly-key-label">Priority</span>
                </div>
                <strong className="global-task-readonly-pill">{getPriorityLabel(activeTask.priority)}</strong>
              </div>

              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="estimate" />
                  </span>
                  <span className="global-task-readonly-key-label">Estimate</span>
                </div>
                <strong className="global-task-readonly-value">
                  {formatEstimateInput(activeTask.estimateAmount || 0) || "0"}
                </strong>
              </div>

              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="date" />
                  </span>
                  <span className="global-task-readonly-key-label">Actual Start</span>
                </div>
                <strong className="global-task-readonly-value">{formatReadonlyDate(activeTask.actualStartDate)}</strong>
              </div>

              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="date" />
                  </span>
                  <span className="global-task-readonly-key-label">Actual End</span>
                </div>
                <strong className="global-task-readonly-value">{formatReadonlyDate(activeTask.actualEndDate)}</strong>
              </div>

            </div>
          </div>
        ) : (
          <fieldset className="global-task-edit-sheet global-task-edit-fieldset" disabled={saving}>
            <div className="global-task-owner-hero global-task-owner-hero-edit">
              <div className="global-task-owner-avatar" aria-hidden="true">
                <TaskReadonlyIcon kind="owner" />
              </div>
              <div className="global-task-owner-copy">
                <strong className="global-task-owner-name">{ownerDisplayName}</strong>
              </div>
            </div>

            <div className="global-task-readonly-notes-block">
              {(activeTask.wbsId?.trim() || activeTask.predecessorWbsId?.trim()) ? (
                <div className="global-task-readonly-notes-meta-row">
                  {activeTask.wbsId?.trim() ? (
                    <p className="global-task-readonly-notes-meta">WBS ID: {activeTask.wbsId.trim()}</p>
                  ) : null}
                  {activeTask.predecessorWbsId?.trim() ? (
                    <p className="global-task-readonly-notes-meta">Predecessor: {activeTask.predecessorWbsId.trim()}</p>
                  ) : null}
                </div>
              ) : null}
              <textarea
                ref={notesRef}
                className="global-task-readonly-notes global-task-edit-notes"
                rows={6}
                placeholder="Add notes"
                value={form.description ?? ""}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
              />
            </div>

            <div className="global-task-readonly-rows">
              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="reference" />
                  </span>
                  <span className="global-task-readonly-key-label">WBS ID</span>
                </div>
                <strong className="global-task-readonly-value">{activeTask.wbsId?.trim() || "--"}</strong>
              </div>

              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="state" />
                  </span>
                  <span className="global-task-readonly-key-label">State</span>
                </div>
                <div className="global-task-edit-control">
                  <select
                    value={form.status ?? activeTask.status}
                    onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as TaskStatus }))}
                  >
                    {taskStatuses.map((status) => (
                      <option key={status} value={status}>
                        {getTaskStatusLabel(status)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="date" />
                  </span>
                  <span className="global-task-readonly-key-label">Due</span>
                </div>
                <div className="global-task-edit-control">
                  <input
                    type="date"
                    value={toDateInputValue(form.dueDate)}
                    onClick={(event) => openDateInputPicker(event.currentTarget)}
                    onChange={(event) => setForm((current) => ({ ...current, dueDate: event.target.value || undefined }))}
                  />
                </div>
              </div>

              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="priority" />
                  </span>
                  <span className="global-task-readonly-key-label">Priority</span>
                </div>
                <div className="global-task-edit-control">
                  <select
                    value={form.priority ?? activeTask.priority}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        priority: event.target.value as "LOW" | "MEDIUM" | "HIGH"
                      }))
                    }
                  >
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                  </select>
                </div>
              </div>

              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="estimate" />
                  </span>
                  <span className="global-task-readonly-key-label">Estimate</span>
                </div>
                <div className="global-task-edit-control">
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    value={estimateInput}
                    disabled={estimateManagedByGroup}
                    onFocus={() =>
                      {
                        if (estimateManagedByGroup) {
                          return;
                        }
                        if (estimateInput.trim() === "0") {
                          setEstimateInput("");
                          setForm((current) => ({ ...current, estimateAmount: undefined }));
                        }
                      }
                    }
                    onChange={(event) =>
                      {
                        const nextValue = event.target.value;
                        setEstimateInput(nextValue);
                        setForm((current) => ({
                          ...current,
                          estimateAmount: nextValue.trim() === "" ? undefined : parseEstimateInput(nextValue)
                        }));
                      }
                    }
                  />
                  {estimateManagedByGroup && (
                    <span className="global-task-edit-note">Managed from a grouped estimate in Project Management.</span>
                  )}
                </div>
              </div>

              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="date" />
                  </span>
                  <span className="global-task-readonly-key-label">Actual Start</span>
                </div>
                <div className="global-task-edit-control">
                  <input
                    type="date"
                    value={toDateInputValue(form.actualStartDate)}
                    onClick={(event) => openDateInputPicker(event.currentTarget)}
                    onChange={(event) => setForm((current) => ({ ...current, actualStartDate: event.target.value || undefined }))}
                  />
                </div>
              </div>

              <div className="global-task-readonly-row">
                <div className="global-task-readonly-key">
                  <span className="global-task-readonly-key-icon">
                    <TaskReadonlyIcon kind="date" />
                  </span>
                  <span className="global-task-readonly-key-label">Actual End</span>
                </div>
                <div className="global-task-edit-control">
                  <input
                    type="date"
                    value={toDateInputValue(form.actualEndDate)}
                    onClick={(event) => openDateInputPicker(event.currentTarget)}
                    onChange={(event) => setForm((current) => ({ ...current, actualEndDate: event.target.value || undefined }))}
                  />
                </div>
              </div>
            </div>
          </fieldset>
        )}

        <footer className="global-task-drawer-actions">
          {isReadOnly ? (
            <>
              {onViewInProject && (
                <button className="btn primary" type="button" onClick={() => onViewInProject(activeTask._id)}>
                  View in Project
                </button>
              )}
              <button className="btn ghost" type="button" onClick={onClose}>
                Close
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" type="button" onClick={() => void handleStatusToggle()} disabled={saving}>
                {activeTask.status === "DONE" ? "Reopen" : "Mark Complete"}
              </button>
              <button className="btn ghost" type="button" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button className="btn primary" type="button" onClick={() => void handleSave()} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </>
          )}
        </footer>
      </aside>
    </div>
  );
}
