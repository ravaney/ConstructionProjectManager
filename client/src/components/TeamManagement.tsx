import { useEffect, useState } from "react";
import type { AppUser, UserRole } from "../types/models";
import { api } from "../utils/api";

type TeamManagementProps = {
  currentUser: AppUser;
};

export function TeamManagement({ currentUser }: TeamManagementProps) {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
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
      setForm({ name: "", email: "", password: "", role: "CONTRACTOR" });
      await refreshUsers();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to add user");
    } finally {
      setSaving(false);
    }
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
      <form className="panel form-grid" onSubmit={handleCreateUser}>
        <h3>Add Team Member</h3>
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
        <button className="btn" type="submit" disabled={saving}>
          {saving ? "Saving..." : "Add User"}
        </button>
      </form>

      <div className="panel stack-sm">
        <div className="row-between wrap">
          <h3>Team Members</h3>
          <button className="btn ghost" onClick={() => refreshUsers()}>
            Refresh
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="table-wrap">
          <table>
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
    </section>
  );
}