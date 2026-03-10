import { useEffect, useState } from "react";
import type { ReportAlert } from "../types/models";
import { api } from "../utils/api";

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function ReportsPanel() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [alerts, setAlerts] = useState<ReportAlert[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function refreshAlerts() {
    try {
      setError("");
      const response = await api.getAlerts();
      setAlerts(response.alerts);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load alerts");
    }
  }

  useEffect(() => {
    refreshAlerts().catch(() => {
      // Handled above.
    });
  }, []);

  async function handleDownloadCsv() {
    setLoading(true);
    setError("");
    try {
      const blob = await api.downloadMonthlyCsv(month);
      downloadBlob(blob, `construction-report-${month}.csv`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "CSV download failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleDownloadPdf() {
    setLoading(true);
    setError("");
    try {
      const blob = await api.downloadMonthlyPdf(month);
      downloadBlob(blob, `construction-report-${month}.pdf`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "PDF download failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="stack-lg">
      <div className="panel stack-sm">
        <h3>Monthly Reports</h3>
        <p className="muted">Download monthly CSV or PDF summaries for sharing and record-keeping.</p>
        <div className="inline-form wrap">
          <label>
            Month
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          </label>
          <button className="btn" onClick={handleDownloadCsv} disabled={loading}>
            Download CSV
          </button>
          <button className="btn" onClick={handleDownloadPdf} disabled={loading}>
            Download PDF
          </button>
        </div>
      </div>

      <div className="panel stack-sm">
        <div className="row-between wrap">
          <h3>Budget Alerts</h3>
          <button className="btn ghost" onClick={() => refreshAlerts()}>
            Refresh Alerts
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        {alerts.length === 0 ? (
          <p className="muted">No active alerts.</p>
        ) : (
          alerts.map((alert, index) => (
            <div className={`alert-card ${alert.severity.toLowerCase()}`} key={`${alert.severity}-${index}`}>
              <strong>{alert.severity}</strong>
              <p>{alert.message}</p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}