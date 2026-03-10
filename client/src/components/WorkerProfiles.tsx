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

export function WorkerProfiles({ canDelete }: WorkerProfilesProps) {
  const [workers, setWorkers] = useState<WorkerProfile[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      await api.createWorker(form);
      setForm({
        name: "",
        role: "CONTRACTOR",
        phone: "",
        email: "",
        company: "",
        notes: "",
        isActive: true
      });
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to create worker profile");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteWorker(id);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to delete worker profile");
    }
  }

  return (
    <section className="stack-lg">
      <form className="panel form-grid" onSubmit={handleSubmit}>
        <h3>Add Worker Profile</h3>
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
        <label>
          Notes
          <input
            value={form.notes ?? ""}
            onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
          />
        </label>
        <button className="btn" type="submit" disabled={saving}>
          {saving ? "Saving..." : "Add Worker"}
        </button>
      </form>

      <div className="panel stack-sm">
        <div className="row-between wrap">
          <h3>Worker Profiles</h3>
          <button className="btn ghost" onClick={() => refresh()}>
            Refresh
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="table-wrap">
          <table>
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
                    {canDelete && (
                      <button className="btn ghost" onClick={() => handleDelete(worker._id)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
