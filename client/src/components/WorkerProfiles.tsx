import { useEffect, useState } from "react";
import type { WorkerProfile, WorkerProfileInput, WorkerRole } from "../types/models";
import { api } from "../utils/api";

const workerRoles: WorkerRole[] = [
  "PLUMBER",
  "ELECTRICIAN",
  "CONTRACTOR",
  "STEELWORKER",
  "CARPENTER",
  "MASON",
  "LABORER",
  "OTHER"
];

function formatWorkerRole(role: string): string {
  const normalized = role === "STEEL_MAN" ? "STEELWORKER" : role;
  if (normalized === "STEELWORKER") {
    return "Steelworker";
  }

  return normalized
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

type WorkerProfilesProps = {
  canDelete: boolean;
};

function ActionIcon({ kind }: { kind: "add" | "refresh" | "edit" | "delete" | "close" | "confirm" }) {
  const iconProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  if (kind === "add") {
    return (
      <svg {...iconProps}>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </svg>
    );
  }

  if (kind === "refresh") {
    return (
      <svg {...iconProps}>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
    );
  }

  if (kind === "edit") {
    return (
      <svg {...iconProps}>
        <path d="M12 20h9" />
        <path d="m16.5 3.5 4 4L7 21H3v-4Z" />
      </svg>
    );
  }

  if (kind === "delete") {
    return (
      <svg {...iconProps}>
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="m19 6-1 14H6L5 6" />
      </svg>
    );
  }

  if (kind === "close") {
    return (
      <svg {...iconProps}>
        <path d="m18 6-12 12" />
        <path d="m6 6 12 12" />
      </svg>
    );
  }

  return (
    <svg {...iconProps}>
      <path d="m5 12 4 4 10-10" />
    </svg>
  );
}

export function WorkerProfiles({ canDelete }: WorkerProfilesProps) {
  const [workers, setWorkers] = useState<WorkerProfile[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingWorkerId, setDeletingWorkerId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [pendingDeleteWorker, setPendingDeleteWorker] = useState<WorkerProfile | null>(null);
  const [editingWorkerId, setEditingWorkerId] = useState<string | null>(null);
  const [form, setForm] = useState<WorkerProfileInput>({
    name: "",
    role: "CONTRACTOR",
    phone: "",
    email: "",
    company: "",
    notes: "",
    isActive: true
  });

  async function refresh() {
    try {
      setError("");
      const response = await api.getWorkers();
      setWorkers(response.workers);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load worker profiles");
    }
  }

  useEffect(() => {
    refresh().catch(() => {
      // Handled in refresh.
    });
  }, []);

  function resetForm() {
    setForm({
      name: "",
      role: "CONTRACTOR",
      phone: "",
      email: "",
      company: "",
      notes: "",
      isActive: true
    });
  }

  function openCreateModal() {
    setEditingWorkerId(null);
    resetForm();
    setShowCreateModal(true);
  }

  function openEditModal(worker: WorkerProfile) {
    setEditingWorkerId(worker._id);
    setForm({
      name: worker.name ?? "",
      role: worker.role ?? "CONTRACTOR",
      phone: worker.phone ?? "",
      email: worker.email ?? "",
      company: worker.company ?? "",
      notes: worker.notes ?? "",
      isActive: worker.isActive ?? true
    });
    setShowCreateModal(true);
  }

  function closeModal() {
    setShowCreateModal(false);
    setEditingWorkerId(null);
    resetForm();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      if (editingWorkerId) {
        await api.updateWorker(editingWorkerId, form);
      } else {
        await api.createWorker(form);
      }
      closeModal();
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : editingWorkerId ? "Failed to update worker profile" : "Failed to create worker profile");
    } finally {
      setSaving(false);
    }
  }

  function openDeleteModal(worker: WorkerProfile) {
    setPendingDeleteWorker(worker);
  }

  function closeDeleteModal() {
    setPendingDeleteWorker(null);
  }

  async function confirmDeleteWorker(id: string) {
    setDeletingWorkerId(id);
    try {
      await api.deleteWorker(id);
      closeDeleteModal();
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to delete worker profile");
    } finally {
      setDeletingWorkerId(null);
    }
  }

  return (
    <section className="stack-lg">
      <div className="panel stack-sm team-workers-panel">
        <div className="row-between wrap">
          <h3>Worker Profiles</h3>
          <div className="row-between wrap" style={{ gap: "0.45rem" }}>
            <button
              className="project-management-icon-action"
              type="button"
              title="Add Worker"
              aria-label="Add Worker"
              onClick={openCreateModal}
            >
              <ActionIcon kind="add" />
            </button>
            <button className="icon-btn view" type="button" title="Refresh" aria-label="Refresh" onClick={() => refresh()}>
              <ActionIcon kind="refresh" />
            </button>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="table-wrap team-workers-table-wrap">
          <table className="team-workers-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Company</th>
                <th>Phone</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((worker) => (
                <tr key={worker._id}>
                  <td>{worker.name}</td>
                  <td>{formatWorkerRole(worker.role)}</td>
                  <td>{worker.company || "-"}</td>
                  <td>{worker.phone || "-"}</td>
                  <td>
                    <div className="team-workers-row-actions">
                      <button className="icon-btn edit" type="button" title="Edit Worker" aria-label="Edit Worker" onClick={() => openEditModal(worker)}>
                        <ActionIcon kind="edit" />
                      </button>
                      {canDelete && (
                        <button className="icon-btn delete" type="button" title="Delete Worker" aria-label="Delete Worker" onClick={() => openDeleteModal(worker)}>
                          <ActionIcon kind="delete" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-backdrop" onClick={closeModal}>
          <form className="panel task-create-modal form-grid" onSubmit={handleSubmit} onClick={(event) => event.stopPropagation()}>
            <div className="row-between wrap">
              <h3>{editingWorkerId ? "Edit Worker Profile" : "Add Worker Profile"}</h3>
              <button className="icon-btn delete" type="button" title="Close" aria-label="Close" onClick={closeModal}>
                <ActionIcon kind="close" />
              </button>
            </div>
            <label>
              Name
              <input
                required
                value={form.name ?? ""}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              />
            </label>
            <label>
              Role
              <select
                value={form.role}
                onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value as WorkerRole }))}
              >
                {workerRoles.map((role) => (
                  <option key={role} value={role}>
                    {formatWorkerRole(role)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Company
              <input
                value={form.company ?? ""}
                onChange={(event) => setForm((prev) => ({ ...prev, company: event.target.value }))}
              />
            </label>
            <label>
              Phone
              <input
                value={form.phone ?? ""}
                onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={form.email ?? ""}
                onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              />
            </label>
            <label className="task-create-wide">
              Notes
              <input
                value={form.notes ?? ""}
                onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
              />
            </label>
            <div className="task-create-modal-actions">
              <button className="icon-btn delete" type="button" title="Cancel" aria-label="Cancel" onClick={closeModal}>
                <ActionIcon kind="close" />
              </button>
              <button className="icon-btn edit" type="submit" title={saving ? "Saving..." : editingWorkerId ? "Save Changes" : "Add Worker"} aria-label={saving ? "Saving..." : editingWorkerId ? "Save Changes" : "Add Worker"} disabled={saving}>
                <ActionIcon kind="confirm" />
              </button>
            </div>
          </form>
        </div>
      )}

      {pendingDeleteWorker && (
        <div className="modal-backdrop" onClick={closeDeleteModal}>
          <div className="panel task-create-modal stack-sm" onClick={(event) => event.stopPropagation()}>
            <div className="row-between wrap">
              <h3>Confirm Delete</h3>
              <button className="icon-btn delete" type="button" title="Close" aria-label="Close" onClick={closeDeleteModal}>
                <ActionIcon kind="close" />
              </button>
            </div>
            <p className="muted">
              Delete worker profile: <strong>{pendingDeleteWorker.name}</strong>?
            </p>
            <div className="task-create-modal-actions">
              <button className="icon-btn delete" type="button" title="Cancel" aria-label="Cancel" onClick={closeDeleteModal}>
                <ActionIcon kind="close" />
              </button>
              <button
                className="icon-btn delete"
                type="button"
                title={deletingWorkerId === pendingDeleteWorker._id ? "Deleting..." : "Confirm Delete"}
                aria-label={deletingWorkerId === pendingDeleteWorker._id ? "Deleting..." : "Confirm Delete"}
                onClick={() => confirmDeleteWorker(pendingDeleteWorker._id)}
                disabled={deletingWorkerId === pendingDeleteWorker._id}
              >
                <ActionIcon kind="delete" />
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
