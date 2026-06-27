import { useEffect, useState } from "react";
import type { AppUser, UserRole } from "../types/models";
import { api } from "../utils/api";

type TeamManagementProps = {
  currentUser: AppUser;
};

function ActionIcon({ kind }: { kind: "add" | "refresh" | "close" | "confirm" }) {
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

export function TeamManagement({ currentUser }: TeamManagementProps) {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "CONTRACTOR" as UserRole });

  async function refreshUsers() {
    try {
      setError("");
      const response = await api.getUsers();
      setUsers(response.users);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load team");
    }
  }

  useEffect(() => {
    if (currentUser.role === "OWNER") {
      refreshUsers().catch(() => {
        // Handled above.
      });
    }
  }, [currentUser.role]);

  async function handleCreateUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      await api.createUser(form);
      closeCreateModal();
      await refreshUsers();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to add user");
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setForm({ name: "", email: "", password: "", role: "CONTRACTOR" });
  }

  function openCreateModal() {
    resetForm();
    setShowCreateModal(true);
  }

  function closeCreateModal() {
    setShowCreateModal(false);
    resetForm();
  }

  if (currentUser.role !== "OWNER") {
    return (
      <section className="panel">
        <h3>Team Access</h3>
        <p className="muted">Only owner accounts can manage users.</p>
      </section>
    );
  }

  return (
    <section className="stack-lg">
      <div className="panel stack-sm team-workers-panel">
        <div className="row-between wrap">
          <h3>Team Members</h3>
          <div className="row-between wrap" style={{ gap: "0.45rem" }}>
            <button
              className="project-management-icon-action"
              type="button"
              title="Add Team Member"
              aria-label="Add Team Member"
              onClick={openCreateModal}
            >
              <ActionIcon kind="add" />
            </button>
            <button className="icon-btn view" type="button" title="Refresh" aria-label="Refresh" onClick={() => refreshUsers()}>
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
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>{user.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-backdrop" onClick={closeCreateModal}>
          <form className="panel task-create-modal form-grid" onSubmit={handleCreateUser} onClick={(event) => event.stopPropagation()}>
            <div className="row-between wrap">
              <h3>Add Team Member</h3>
              <button className="icon-btn delete" type="button" title="Close" aria-label="Close" onClick={closeCreateModal}>
                <ActionIcon kind="close" />
              </button>
            </div>
            <label>
              Name
              <input
                required
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              />
            </label>
            <label>
              Email
              <input
                required
                type="email"
                value={form.email}
                onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              />
            </label>
            <label>
              Password
              <input
                required
                type="password"
                value={form.password}
                onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
              />
            </label>
            <label>
              Role
              <select
                value={form.role}
                onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value as UserRole }))}
              >
                <option value="CONTRACTOR">Contractor</option>
                <option value="OWNER">Owner</option>
              </select>
            </label>
            <div className="task-create-modal-actions">
              <button className="icon-btn delete" type="button" title="Cancel" aria-label="Cancel" onClick={closeCreateModal}>
                <ActionIcon kind="close" />
              </button>
              <button className="icon-btn edit" type="submit" title={saving ? "Saving..." : "Add User"} aria-label={saving ? "Saving..." : "Add User"} disabled={saving}>
                <ActionIcon kind="confirm" />
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
