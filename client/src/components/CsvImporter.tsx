import { useState } from "react";
import type { ExpenseInput } from "../types/models";
import { parsePhaseSheet } from "../utils/csv";
import { formatCurrency } from "../utils/format";

type CsvImporterProps = {
  canImport: boolean;
  onImport: (expenses: ExpenseInput[]) => Promise<number>;
};

export function CsvImporter({ canImport, onImport }: CsvImporterProps) {
  const [rows, setRows] = useState<ExpenseInput[]>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState("");

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setError("");
    setResult("");

    try {
      const parsed = await parsePhaseSheet(file);
      setRows(parsed);
      setFileName(file.name);
    } catch (importError) {
      setRows([]);
      setFileName(file.name);
      setError(importError instanceof Error ? importError.message : "Unable to parse file");
    }
  }

  async function handleImport() {
    if (!canImport) {
      return;
    }

    setImporting(true);
    setError("");

    try {
      const inserted = await onImport(rows);
      setResult(`Imported ${inserted} records into your tracker.`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="stack-lg">
      <div className="panel stack-sm">
        <h3>Import Your Existing Spreadsheet</h3>
        <p className="muted">
          Upload your CSV worksheet. The importer auto-detects the Item, Category, and Amount section and skips summary rows.
        </p>

        {!canImport && <p className="muted">Only owner accounts can run bulk CSV import.</p>}

        <input type="file" accept=".csv" onChange={handleFile} disabled={!canImport} />
        {fileName && <p className="muted">Loaded: {fileName}</p>}
        {error && <p className="error-text">{error}</p>}
        {result && <p className="success-text">{result}</p>}

        <button className="btn" onClick={handleImport} disabled={rows.length === 0 || importing || !canImport}>
          {importing ? "Importing..." : "Import to Database"}
        </button>
      </div>

      {rows.length > 0 && (
        <div className="panel stack-sm">
          <div className="row-between wrap">
            <h3>Preview ({rows.length} rows)</h3>
            <p className="muted">Showing first 10 records</p>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>Amount</th>
                  <th>Unit</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 10).map((expense, index) => (
                  <tr key={`${expense.name}-${index}`}>
                    <td>{expense.name}</td>
                    <td>{expense.category}</td>
                    <td>{formatCurrency(expense.amount)}</td>
                    <td>{expense.unit || "-"}</td>
                    <td>{expense.quantity || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}