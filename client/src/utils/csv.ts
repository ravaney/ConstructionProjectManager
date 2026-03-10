import Papa from "papaparse";
import type { ExpenseInput } from "../types/models";

function clean(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

function parseCurrency(value: string): number {
  if (!value) {
    return 0;
  }

  const normalized = value.replace(/[^0-9.-]/g, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNumber(value: string): number {
  const normalized = value.replace(/[^0-9.-]/g, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSummaryRow(name: string, category: string): boolean {
  const lowered = `${name} ${category}`.toLowerCase();
  return ["total materials", "construction related costs", "funds used", "project funds", "funds remaining", "land cost", "labour cost", "total"].some((phrase) =>
    lowered === phrase || lowered.startsWith(`${phrase} `)
  );
}

export async function parsePhaseSheet(file: File): Promise<ExpenseInput[]> {
  const parsed = await new Promise<Papa.ParseResult<string[]>>((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: false,
      complete: (result) => resolve(result),
      error: (error) => reject(error)
    });
  });

  const rows = parsed.data;
  const headerIndex = rows.findIndex((row) => clean(row[0]).toLowerCase() === "item" && clean(row[1]).toLowerCase() === "category" && clean(row[2]).toLowerCase() === "amount");

  if (headerIndex < 0) {
    throw new Error("Could not find Item/Category/Amount headers in this CSV file.");
  }

  const candidateRows = rows.slice(headerIndex + 1);
  const expenses: ExpenseInput[] = [];

  for (const row of candidateRows) {
    const name = clean(row[0]);
    const category = clean(row[1]);
    const amount = parseCurrency(clean(row[2]));

    if (!name || !category || isSummaryRow(name, category)) {
      continue;
    }

    expenses.push({
      name,
      category,
      amount,
      phase: "Phase 1",
      quantity: parseNumber(clean(row[5])),
      unitPrice: parseCurrency(clean(row[6])),
      unit: clean(row[7]),
      notes: clean(row[12]),
      source: "csv-import"
    });
  }

  if (expenses.length === 0) {
    throw new Error("No expense records were detected after the header row.");
  }

  return expenses;
}