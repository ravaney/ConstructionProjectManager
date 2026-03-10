import { useEffect, useMemo, useState } from "react";
import type { Attachment, Task, TaskInput, TaskNodeType, TaskStatus } from "../types/models";
import { api, resolveAssetUrl } from "../utils/api";
import { formatCurrency, formatDate } from "../utils/format";
import { buildScopeLabel, getChildTasks, getCurrentPhase, getCurrentSection, getPhaseNodes, getSectionsForPhase } from "../utils/workBreakdown";

type TaskBoardProps = {
  tasks: Task[];
  canDeleteTask: boolean;
  onCreateTask: (payload: TaskInput) => Promise<void>;
  onUpdateTask: (id: string, payload: Partial<TaskInput>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
};

type DraftState = {
  title: string;
  description: string;
  owner: string;
  dueDate: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  estimateAmount: number;
};

const taskStatuses: TaskStatus[] = ["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE"];
const defaultDraft: DraftState = {
  title: "",
  description: "",
  owner: "",
  dueDate: "",
  priority: "MEDIUM",
  estimateAmount: 0
};

function ProgressMeter({ value }: { value: number }) {
  return (
    <div className="task-progress-meter" aria-label={`${value}% complete`}>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function getCreateButtonLabel(mode: TaskNodeType): string {
  if (mode === "PHASE") {
    return "Add Phase";
  }

  if (mode === "SECTION") {
    return "Add Section";
  }

  return "Add Task";
}

function getNodeStatusLabel(status: TaskStatus): string {
  return status.replace("_", " ");
}

export function TaskBoard({ tasks, canDeleteTask, onCreateTask, onUpdateTask, onDeleteTask }: TaskBoardProps) {
  const [createMode, setCreateMode] = useState<TaskNodeType>("TASK");
  const [draft, setDraft] = useState<DraftState>(defaultDraft);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<TaskInput>>({});
  const [selectedPhaseId, setSelectedPhaseId] = useState("");
  const [selectedSectionId, setSelectedSectionId] = useState("");
  const [attachmentMap, setAttachmentMap] = useState<Record<string, Attachment[]>>({});
  const [attachmentError, setAttachmentError] = useState("");

  const phases = useMemo(() => getPhaseNodes(tasks), [tasks]);
  const currentPhase = useMemo(() => getCurrentPhase(tasks), [tasks]);
  const currentSection = useMemo(() => getCurrentSection(tasks, currentPhase?._id), [tasks, currentPhase]);
  const sections = useMemo(() => getSectionsForPhase(tasks, selectedPhaseId), [tasks, selectedPhaseId]);
  const leafTasks = useMemo(() => tasks.filter((task) => task.nodeType === "TASK"), [tasks]);
  const completedLeafTasks = useMemo(() => leafTasks.filter((task) => task.status === "DONE").length, [leafTasks]);
  const totalEstimated = useMemo(() => phases.reduce((sum, phase) => sum + phase.financials.rolledEstimate, 0), [phases]);

  async function loadAttachments() {
    try {
      const response = await api.getAttachments("task");
      const groupedAttachments = response.attachments.reduce<Record<string, Attachment[]>>((acc, attachment) => {
        const current = acc[attachment.entityId] ?? [];
        acc[attachment.entityId] = [...current, attachment];
        return acc;
      }, {});

      setAttachmentMap(groupedAttachments);
    } catch (requestError) {
      setAttachmentError(requestError instanceof Error ? requestError.message : "Could not load task attachments");
    }
  }

  useEffect(() => {
    loadAttachments().catch(() => {
      // Attachment failures are handled in state.
    });
  }, [tasks.length]);

  useEffect(() => {
    if (selectedPhaseId && phases.some((phase) => phase._id === selectedPhaseId)) {
      return;
    }

    setSelectedPhaseId(currentPhase?._id ?? phases[0]?._id ?? "");
  }, [currentPhase, phases, selectedPhaseId]);

  useEffect(() => {
    if (selectedSectionId && sections.some((section) => section._id === selectedSectionId)) {
      return;
    }

    setSelectedSectionId(getCurrentSection(tasks, selectedPhaseId)?._id ?? sections[0]?._id ?? "");
  }, [sections, selectedPhaseId, selectedSectionId, tasks]);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);

    try {
      const payload: TaskInput = {
        title: draft.title,
        description: draft.description,
        owner: draft.owner,
        dueDate: draft.dueDate || undefined,
        priority: draft.priority,
        estimateAmount: draft.estimateAmount,
        nodeType: createMode,
        parentTaskId:
          createMode === "SECTION"
            ? selectedPhaseId || undefined
            : createMode === "TASK"
              ? selectedSectionId || undefined
              : undefined
      };

      await onCreateTask(payload);
      setDraft(defaultDraft);
      if (createMode === "PHASE" && phases.length === 0) {
        setCreateMode("SECTION");
      }
    } finally {
      setSaving(false);
    }
  }

  function startEdit(task: Task) {
    setEditingId(task._id);
    setEditForm({
      title: task.title,
      description: task.description,
      owner: task.owner,
      dueDate: task.dueDate?.slice(0, 10),
      priority: task.priority,
      estimateAmount: task.estimateAmount,
      status: task.status
    });
  }

  async function saveEdit(taskId: string) {
    await onUpdateTask(taskId, editForm);
    setEditingId(null);
    setEditForm({});
  }

  async function handleAttachmentUpload(taskId: string, file: File) {
    setAttachmentError("");
    try {
      await api.uploadAttachment({ entityType: "task", entityId: taskId, file });
      await loadAttachments();
    } catch (requestError) {
      setAttachmentError(requestError instanceof Error ? requestError.message : "Attachment upload failed");
    }
  }

  async function handleAttachmentDelete(attachmentId: string) {
    setAttachmentError("");
    try {
      await api.deleteAttachment(attachmentId);
      await loadAttachments();
    } catch (requestError) {
      setAttachmentError(requestError instanceof Error ? requestError.message : "Attachment delete failed");
    }
  }

  async function closeNode(task: Task) {
    await onUpdateTask(task._id, { status: "DONE" });
  }

  async function reopenTask(task: Task) {
    await onUpdateTask(task._id, { status: "PLANNED" });
  }

  function focusCreateSection(phaseId: string) {
    setCreateMode("SECTION");
    setSelectedPhaseId(phaseId);
  }

  function focusCreateTask(phaseId: string, sectionId: string) {
    setCreateMode("TASK");
    setSelectedPhaseId(phaseId);
    setSelectedSectionId(sectionId);
  }

  function renderNodeMetrics(task: Task) {
    return (
      <div className="task-node-metrics">
        <div>
          <span>Estimate</span>
          <strong>{formatCurrency(task.financials.rolledEstimate)}</strong>
        </div>
        <div>
          <span>Spent</span>
          <strong>{formatCurrency(task.financials.rolledSpent)}</strong>
        </div>
        <div>
          <span>Committed</span>
          <strong>{formatCurrency(task.financials.rolledCommitted)}</strong>
        </div>
        <div>
          <span>Remaining</span>
          <strong>{formatCurrency(task.financials.remaining)}</strong>
        </div>
      </div>
    );
  }

  function renderTaskLeaf(task: Task) {
    const isEditing = editingId === task._id;
    const attachments = attachmentMap[task._id] ?? [];

    return (
      <div className={`task-leaf ${task.status === "DONE" ? "is-complete" : ""}`} key={task._id}>
        <div className="task-leaf-main">
          {isEditing ? (
            <div className="task-edit-grid">
              <label>
                Task
                <input
                  value={editForm.title ?? ""}
                  onChange={(event) => setEditForm((current) => ({ ...current, title: event.target.value }))}
                />
              </label>
              <label>
                Owner
                <input
                  value={editForm.owner ?? ""}
                  onChange={(event) => setEditForm((current) => ({ ...current, owner: event.target.value }))}
                />
              </label>
              <label>
                Due Date
                <input
                  type="date"
                  value={editForm.dueDate ?? ""}
                  onChange={(event) => setEditForm((current) => ({ ...current, dueDate: event.target.value }))}
                />
              </label>
              <label>
                Priority
                <select
                  value={editForm.priority ?? "MEDIUM"}
                  onChange={(event) =>
                    setEditForm((current) => ({
                      ...current,
                      priority: event.target.value as "LOW" | "MEDIUM" | "HIGH"
                    }))
                  }
                >
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                </select>
              </label>
              <label>
                Estimate
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={editForm.estimateAmount ?? 0}
                  onChange={(event) => setEditForm((current) => ({ ...current, estimateAmount: Number(event.target.value) }))}
                />
              </label>
              <label>
                Status
                <select
                  value={editForm.status ?? task.status}
                  onChange={(event) => setEditForm((current) => ({ ...current, status: event.target.value as TaskStatus }))}
                >
                  {taskStatuses.map((status) => (
                    <option key={status} value={status}>
                      {getNodeStatusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="task-edit-wide">
                Notes
                <input
                  value={editForm.description ?? ""}
                  onChange={(event) => setEditForm((current) => ({ ...current, description: event.target.value }))}
                />
              </label>
            </div>
          ) : (
            <>
              <div className="row-between wrap">
                <div>
                  <strong>{task.title}</strong>
                  <p className="muted small-text">{buildScopeLabel(task.phase, task.section)}</p>
                </div>
                <div className="task-leaf-badges">
                  <span className={`status-badge status-${task.status.toLowerCase()}`}>{getNodeStatusLabel(task.status)}</span>
                  <span className="pill">{task.priority}</span>
                </div>
              </div>
              <p className="muted">{task.description || "No scope notes yet."}</p>
              <div className="task-leaf-meta">
                <span>Owner: {task.owner || "Unassigned"}</span>
                <span>Due: {formatDate(task.dueDate)}</span>
                <span>Estimate: {formatCurrency(task.estimateAmount)}</span>
              </div>
            </>
          )}
        </div>

        <div className="task-leaf-actions">
          {isEditing ? (
            <>
              <button className="btn" type="button" onClick={() => saveEdit(task._id)}>
                Save
              </button>
              <button className="btn ghost" type="button" onClick={() => { setEditingId(null); setEditForm({}); }}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" type="button" onClick={() => startEdit(task)}>
                Edit
              </button>
              {task.status === "DONE" ? (
                <button className="btn ghost" type="button" onClick={() => reopenTask(task)}>
                  Reopen
                </button>
              ) : (
                <button className="btn" type="button" onClick={() => closeNode(task)}>
                  Close Task
                </button>
              )}
              {canDeleteTask && (
                <button className="btn ghost" type="button" onClick={() => onDeleteTask(task._id)}>
                  Delete
                </button>
              )}
            </>
          )}
        </div>

        <div className="task-attachment-strip">
          {attachments.map((attachment) => (
            <div className="attachment-row" key={attachment._id}>
              <a href={resolveAssetUrl(attachment.url)} target="_blank" rel="noreferrer">
                {attachment.fileName}
              </a>
              <button className="btn ghost" type="button" onClick={() => handleAttachmentDelete(attachment._id)}>
                Remove
              </button>
            </div>
          ))}
          <label className="file-label compact">
            Add Attachment
            <input
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  handleAttachmentUpload(task._id, file).catch(() => {
                    // Attachment state handles the error.
                  });
                }
                event.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
    );
  }

  function renderSection(section: Task) {
    const isEditing = editingId === section._id;
    const sectionTasks = getChildTasks(tasks, section._id).filter((task) => task.nodeType === "TASK");

    return (
      <article className={`task-node section-node ${section._id === currentSection?._id ? "is-current" : ""}`} key={section._id}>
        <header className="task-node-header">
          <div>
            {isEditing ? (
              <div className="task-edit-grid">
                <label>
                  Section
                  <input
                    value={editForm.title ?? ""}
                    onChange={(event) => setEditForm((current) => ({ ...current, title: event.target.value }))}
                  />
                </label>
                <label>
                  Owner
                  <input
                    value={editForm.owner ?? ""}
                    onChange={(event) => setEditForm((current) => ({ ...current, owner: event.target.value }))}
                  />
                </label>
                <label>
                  Due Date
                  <input
                    type="date"
                    value={editForm.dueDate ?? ""}
                    onChange={(event) => setEditForm((current) => ({ ...current, dueDate: event.target.value }))}
                  />
                </label>
                <label>
                  Estimate
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={editForm.estimateAmount ?? 0}
                    onChange={(event) => setEditForm((current) => ({ ...current, estimateAmount: Number(event.target.value) }))}
                  />
                </label>
                <label className="task-edit-wide">
                  Scope Notes
                  <input
                    value={editForm.description ?? ""}
                    onChange={(event) => setEditForm((current) => ({ ...current, description: event.target.value }))}
                  />
                </label>
              </div>
            ) : (
              <>
                <p className="eyebrow">Section</p>
                <h4>{section.title}</h4>
                <p className="muted">{section.description || "Define the work packages inside this section."}</p>
              </>
            )}
          </div>
          <div className="task-node-header-side">
            <span className={`status-badge status-${section.status.toLowerCase()}`}>{getNodeStatusLabel(section.status)}</span>
            <div className="task-node-header-actions">
              {isEditing ? (
                <>
                  <button className="btn" type="button" onClick={() => saveEdit(section._id)}>
                    Save
                  </button>
                  <button className="btn ghost" type="button" onClick={() => { setEditingId(null); setEditForm({}); }}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="btn ghost" type="button" onClick={() => focusCreateTask(section.phaseTaskId ?? "", section._id)}>
                    Add Task
                  </button>
                  <button className="btn ghost" type="button" onClick={() => startEdit(section)}>
                    Edit
                  </button>
                  {section.status !== "DONE" && (
                    <button className="btn" type="button" onClick={() => closeNode(section)}>
                      Close Section
                    </button>
                  )}
                  {canDeleteTask && (
                    <button className="btn ghost" type="button" onClick={() => onDeleteTask(section._id)}>
                      Delete
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </header>

        {renderNodeMetrics(section)}
        <div className="task-progress-row">
          <span>{section.progress.completedTasks} of {section.progress.totalTasks} tasks complete</span>
          <ProgressMeter value={section.progress.percentComplete} />
        </div>

        <div className="task-leaf-list">
          {sectionTasks.length === 0 ? <p className="muted">No work items in this section yet.</p> : sectionTasks.map((task) => renderTaskLeaf(task))}
        </div>
      </article>
    );
  }

  function renderPhase(phase: Task) {
    const isEditing = editingId === phase._id;
    const phaseSections = getSectionsForPhase(tasks, phase._id);

    return (
      <article className={`task-node phase-node ${phase._id === currentPhase?._id ? "is-current" : ""}`} key={phase._id}>
        <header className="task-node-header">
          <div>
            {isEditing ? (
              <div className="task-edit-grid">
                <label>
                  Phase
                  <input
                    value={editForm.title ?? ""}
                    onChange={(event) => setEditForm((current) => ({ ...current, title: event.target.value }))}
                  />
                </label>
                <label>
                  Owner
                  <input
                    value={editForm.owner ?? ""}
                    onChange={(event) => setEditForm((current) => ({ ...current, owner: event.target.value }))}
                  />
                </label>
                <label>
                  Due Date
                  <input
                    type="date"
                    value={editForm.dueDate ?? ""}
                    onChange={(event) => setEditForm((current) => ({ ...current, dueDate: event.target.value }))}
                  />
                </label>
                <label>
                  Estimate
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={editForm.estimateAmount ?? 0}
                    onChange={(event) => setEditForm((current) => ({ ...current, estimateAmount: Number(event.target.value) }))}
                  />
                </label>
                <label className="task-edit-wide">
                  Phase Notes
                  <input
                    value={editForm.description ?? ""}
                    onChange={(event) => setEditForm((current) => ({ ...current, description: event.target.value }))}
                  />
                </label>
              </div>
            ) : (
              <>
                <p className="eyebrow">Phase</p>
                <h3>{phase.title}</h3>
                <p className="muted">{phase.description || "Track this build phase by section, estimate, and close-out progress."}</p>
              </>
            )}
          </div>

          <div className="task-node-header-side">
            <span className={`status-badge status-${phase.status.toLowerCase()}`}>{getNodeStatusLabel(phase.status)}</span>
            <div className="task-node-header-actions">
              {isEditing ? (
                <>
                  <button className="btn" type="button" onClick={() => saveEdit(phase._id)}>
                    Save
                  </button>
                  <button className="btn ghost" type="button" onClick={() => { setEditingId(null); setEditForm({}); }}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="btn ghost" type="button" onClick={() => focusCreateSection(phase._id)}>
                    Add Section
                  </button>
                  <button className="btn ghost" type="button" onClick={() => startEdit(phase)}>
                    Edit
                  </button>
                  {phase.status !== "DONE" && (
                    <button className="btn" type="button" onClick={() => closeNode(phase)}>
                      Close Phase
                    </button>
                  )}
                  {canDeleteTask && (
                    <button className="btn ghost" type="button" onClick={() => onDeleteTask(phase._id)}>
                      Delete
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </header>

        {renderNodeMetrics(phase)}
        <div className="task-progress-row">
          <span>{phase.progress.completedTasks} of {phase.progress.totalTasks} tasks complete</span>
          <ProgressMeter value={phase.progress.percentComplete} />
        </div>

        <div className="task-section-stack">
          {phaseSections.length === 0 ? <p className="muted">No sections added to this phase yet.</p> : phaseSections.map((section) => renderSection(section))}
        </div>
      </article>
    );
  }

  const canCreateSection = phases.length > 0 && Boolean(selectedPhaseId);
  const canCreateTask = sections.length > 0 && Boolean(selectedSectionId);

  return (
    <section className="stack-lg task-planner-shell">
      <div className="task-planner-hero panel">
        <div>
          <p className="eyebrow">Construction Planner</p>
          <h2>Work Breakdown Structure</h2>
          <p className="muted">
            Organize the build by phase, section, and work item, then close out each level as the crew advances.
          </p>
        </div>
        <div className="task-planner-stats">
          <article>
            <span>Current Phase</span>
            <strong>{currentPhase?.title ?? "No active phase"}</strong>
          </article>
          <article>
            <span>Current Section</span>
            <strong>{currentSection?.title ?? "No active section"}</strong>
          </article>
          <article>
            <span>Tasks Closed</span>
            <strong>{completedLeafTasks} / {leafTasks.length}</strong>
          </article>
          <article>
            <span>Estimated Work</span>
            <strong>{formatCurrency(totalEstimated)}</strong>
          </article>
        </div>
      </div>

      <div className="task-planner-layout">
        <aside className="panel task-create-panel">
          <div className="task-create-head">
            <h3>Create Work Item</h3>
            <div className="segmented-control">
              {(["PHASE", "SECTION", "TASK"] as TaskNodeType[]).map((mode) => (
                <button
                  className={createMode === mode ? "active" : ""}
                  key={mode}
                  type="button"
                  onClick={() => setCreateMode(mode)}
                >
                  {mode === "PHASE" ? "Phase" : mode === "SECTION" ? "Section" : "Task"}
                </button>
              ))}
            </div>
          </div>

          <form className="stack-sm" onSubmit={handleCreate}>
            {createMode !== "PHASE" && (
              <label>
                Phase
                <select value={selectedPhaseId} onChange={(event) => setSelectedPhaseId(event.target.value)} disabled={phases.length === 0}>
                  <option value="">{phases.length > 0 ? "Select phase" : "Add a phase first"}</option>
                  {phases.map((phase) => (
                    <option key={phase._id} value={phase._id}>
                      {phase.title}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {createMode === "TASK" && (
              <label>
                Section
                <select value={selectedSectionId} onChange={(event) => setSelectedSectionId(event.target.value)} disabled={sections.length === 0}>
                  <option value="">{sections.length > 0 ? "Select section" : "Add a section first"}</option>
                  {sections.map((section) => (
                    <option key={section._id} value={section._id}>
                      {section.title}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label>
              {createMode === "PHASE" ? "Phase Name" : createMode === "SECTION" ? "Section Name" : "Task Name"}
              <input
                required
                value={draft.title}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              />
            </label>

            <label>
              Scope Notes
              <textarea
                rows={3}
                value={draft.description}
                onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              />
            </label>

            <label>
              Owner
              <input value={draft.owner} onChange={(event) => setDraft((current) => ({ ...current, owner: event.target.value }))} />
            </label>

            <label>
              Target Due Date
              <input type="date" value={draft.dueDate} onChange={(event) => setDraft((current) => ({ ...current, dueDate: event.target.value }))} />
            </label>

            {createMode === "TASK" && (
              <label>
                Priority
                <select
                  value={draft.priority}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      priority: event.target.value as "LOW" | "MEDIUM" | "HIGH"
                    }))
                  }
                >
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                </select>
              </label>
            )}

            <label>
              Estimate
              <input
                type="number"
                min={0}
                step="0.01"
                value={draft.estimateAmount}
                onChange={(event) => setDraft((current) => ({ ...current, estimateAmount: Number(event.target.value) }))}
              />
            </label>

            <button
              className="btn"
              type="submit"
              disabled={saving || (createMode === "SECTION" && !canCreateSection) || (createMode === "TASK" && !canCreateTask)}
            >
              {saving ? "Saving..." : getCreateButtonLabel(createMode)}
            </button>
          </form>
        </aside>

        <div className="task-tree-column">
          {attachmentError && <p className="error-text panel">{attachmentError}</p>}

          {phases.length === 0 ? (
            <section className="panel">
              <h3>No phases yet</h3>
              <p className="muted">Start by adding your first construction phase, then break it into sections and work items.</p>
            </section>
          ) : (
            phases.map((phase) => renderPhase(phase))
          )}
        </div>
      </div>
    </section>
  );
}
