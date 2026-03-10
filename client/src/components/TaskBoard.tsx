import { useEffect, useMemo, useState } from "react";
import type { Attachment, Task, TaskInput, TaskStatus } from "../types/models";
import { api, resolveAssetUrl } from "../utils/api";
import { formatCurrency, formatDate } from "../utils/format";

type TaskBoardProps = {
  tasks: Task[];
  canDeleteTask: boolean;
  onCreateTask: (payload: TaskInput) => Promise<void>;
  onUpdateTask: (id: string, payload: Partial<TaskInput>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
};

const statuses: TaskStatus[] = ["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE"];

const defaultForm: TaskInput = {
  title: "",
  description: "",
  phase: "Phase 1",
  status: "PLANNED",
  owner: "",
  dueDate: "",
  priority: "MEDIUM",
  budgetImpact: 0
};

export function TaskBoard({ tasks, canDeleteTask, onCreateTask, onUpdateTask, onDeleteTask }: TaskBoardProps) {
  const [form, setForm] = useState<TaskInput>(defaultForm);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<TaskInput>>({});
  const [attachmentMap, setAttachmentMap] = useState<Record<string, Attachment[]>>({});
  const [attachmentError, setAttachmentError] = useState("");

  const grouped = useMemo(() => {
    return statuses.reduce<Record<TaskStatus, Task[]>>(
      (acc, status) => {
        acc[status] = tasks.filter((task) => task.status === status);
        return acc;
      },
      { PLANNED: [], IN_PROGRESS: [], BLOCKED: [], DONE: [] }
    );
  }, [tasks]);

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
      setAttachmentError(requestError instanceof Error ? requestError.message : "Could not load attachments");
    }
  }

  useEffect(() => {
    loadAttachments().catch(() => {
      // Handled in function.
    });
  }, [tasks.length]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);

    try {
      await onCreateTask(form);
      setForm(defaultForm);
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
      budgetImpact: task.budgetImpact,
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

  return (
    <section className="stack-lg">
      <form className="panel form-grid" onSubmit={handleSubmit}>
        <h3>Add Task</h3>

        <label>
          Task
          <input
            required
            value={form.title ?? ""}
            onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
          />
        </label>

        <label>
          Owner
          <input
            value={form.owner ?? ""}
            onChange={(event) => setForm((current) => ({ ...current, owner: event.target.value }))}
          />
        </label>

        <label>
          Priority
          <select
            value={form.priority ?? "MEDIUM"}
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
        </label>

        <label>
          Due Date
          <input
            type="date"
            value={form.dueDate ?? ""}
            onChange={(event) => setForm((current) => ({ ...current, dueDate: event.target.value }))}
          />
        </label>

        <label>
          Budget Impact
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.budgetImpact ?? 0}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                budgetImpact: Number(event.target.value)
              }))
            }
          />
        </label>

        <label>
          Notes
          <input
            value={form.description ?? ""}
            onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
          />
        </label>

        <button className="btn" type="submit" disabled={saving}>
          {saving ? "Saving..." : "Add Task"}
        </button>
      </form>

      {attachmentError && <p className="error-text panel">{attachmentError}</p>}

      <div className="board-grid">
        {statuses.map((status) => (
          <article className="panel" key={status}>
            <h3>{status.replace("_", " ")}</h3>
            <div className="stack-sm">
              {grouped[status].length === 0 && <p className="muted">No tasks yet.</p>}

              {grouped[status].map((task) => {
                const isEditing = editingId === task._id;
                const attachments = attachmentMap[task._id] ?? [];

                return (
                  <div className="task-card" key={task._id}>
                    {isEditing ? (
                      <>
                        <label>
                          Title
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
                          Budget Impact
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={editForm.budgetImpact ?? 0}
                            onChange={(event) =>
                              setEditForm((current) => ({
                                ...current,
                                budgetImpact: Number(event.target.value)
                              }))
                            }
                          />
                        </label>
                        <label>
                          Description
                          <input
                            value={editForm.description ?? ""}
                            onChange={(event) =>
                              setEditForm((current) => ({
                                ...current,
                                description: event.target.value
                              }))
                            }
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <div className="row-between wrap">
                          <strong>{task.title}</strong>
                          <span className="pill">{task.priority}</span>
                        </div>
                        <p className="muted">Owner: {task.owner || "Unassigned"}</p>
                        <p className="muted">Due: {formatDate(task.dueDate)}</p>
                        <p className="muted">Budget Impact: {formatCurrency(task.budgetImpact)}</p>
                        <p className="muted">{task.description || "No notes"}</p>
                      </>
                    )}

                    <select
                      value={isEditing ? editForm.status ?? task.status : task.status}
                      onChange={(event) => {
                        const nextStatus = event.target.value as TaskStatus;
                        if (isEditing) {
                          setEditForm((current) => ({ ...current, status: nextStatus }));
                        } else {
                          onUpdateTask(task._id, { status: nextStatus }).catch(() => {
                            // Surface via parent refresh errors.
                          });
                        }
                      }}
                    >
                      {statuses.map((nextStatus) => (
                        <option key={nextStatus} value={nextStatus}>
                          {nextStatus.replace("_", " ")}
                        </option>
                      ))}
                    </select>

                    <div className="attachment-stack">
                      {attachments.map((attachment) => (
                        <div className="attachment-row" key={attachment._id}>
                          <a href={resolveAssetUrl(attachment.url)} target="_blank" rel="noreferrer">
                            {attachment.fileName}
                          </a>
                          <button className="btn ghost" onClick={() => handleAttachmentDelete(attachment._id)}>
                            Remove
                          </button>
                        </div>
                      ))}
                      <label className="file-label">
                        <input
                          type="file"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              handleAttachmentUpload(task._id, file).catch(() => {
                                // Handled in function.
                              });
                            }
                            event.target.value = "";
                          }}
                        />
                      </label>
                    </div>

                    <div className="row-between wrap">
                      {isEditing ? (
                        <>
                          <button className="btn" onClick={() => saveEdit(task._id)}>
                            Save
                          </button>
                          <button
                            className="btn ghost"
                            onClick={() => {
                              setEditingId(null);
                              setEditForm({});
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="btn ghost" onClick={() => startEdit(task)}>
                          Edit
                        </button>
                      )}

                      {canDeleteTask && (
                        <button className="btn ghost" onClick={() => onDeleteTask(task._id)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}