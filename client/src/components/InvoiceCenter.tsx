import { useEffect, useMemo, useState } from "react";
import type { Expense, Invoice, InvoiceInput, InvoiceItem, Vendor } from "../types/models";
import { api } from "../utils/api";
import { formatCurrency, formatDate } from "../utils/format";
import {
  defaultMaterialPresets,
  isMaterialsCategory,
  materialPresetDeletedStorageKey,
  materialPresetStorageKey,
  mergePresetsWithExpenses,
  normalizeMaterialName,
  normalizeUnitValue,
  parseStoredRemovedPresetIds,
  parseStoredMaterialPresets,
  resolveMaterialName,
  toPresetId,
  type MaterialPreset
} from "../utils/materialPresets";

const invoiceCategoryOptions = [
  "Materials",
  "Labor Cost",
  "Subcontractor Services",
  "Equipment Rental",
  "Permits & Fees",
  "Inspection & Testing",
  "Design & Engineering",
  "Site Utilities",
  "Transportation & Logistics",
  "Safety & PPE",
  "Waste Disposal",
  "Insurance",
  "Land",
  "Other"
] as const;

const baseMaterialOptions = ["Cement", "Steel", "Lumber", "Sand", "Gravel", "Blocks", "Binding Wire"] as const;
const unitOptions = ["Bag", "Ton", "Load", "Cubic Yard", "Cubic Meter", "Block", "Kg", "Lb", "Ft", "M", "Sheet"] as const;

function parseWholeNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function buildMaterialsCategory(subcategory?: string): string {
  const normalized = (subcategory ?? "").trim();
  return normalized ? `Materials / ${normalized}` : "Materials";
}

function formatHistory(history: Array<{ unitPrice: number; changedAt: string }>): string {
  if (history.length === 0) {
    return "No price changes recorded yet.";
  }

  return history
    .slice(-5)
    .reverse()
    .map((entry) => `${new Date(entry.changedAt).toLocaleDateString()}: $${entry.unitPrice.toFixed(2)}`)
    .join("\n");
}

function VendorIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 21h18" />
      <path d="M5 21V7l7-4 7 4v14" />
      <path d="M9 10h6" />
      <path d="M9 14h6" />
    </svg>
  );
}

function MaterialIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  );
}

type InvoiceCenterProps = {
  expenses: Expense[];
  canMarkPaid: boolean;
  onInvoicePaid: () => Promise<void>;
};

function createEmptyItem(): InvoiceItem {
  return {
    description: "",
    category: "Materials",
    workerRole: "OTHER",
    quantity: 1,
    unit: "",
    unitPrice: 0,
    amount: 0,
    materialLabel: "",
    trackToTally: false,
    recordOnly: false
  };
}

function toInvoiceInput(invoice: Invoice): InvoiceInput {
  return {
    vendor: invoice.vendor,
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate.slice(0, 10),
    dueDate: invoice.dueDate.slice(0, 10),
    currency: invoice.currency,
    notes: invoice.notes,
    items: invoice.items.map((item) => ({
      description: item.description,
      category: item.category,
      workerRole: item.workerRole ?? "OTHER",
      quantity: item.quantity,
      unit: item.unit ?? "",
      unitPrice: item.unitPrice,
      amount: item.amount,
      materialLabel: item.materialLabel ?? "",
      trackToTally: Boolean(item.trackToTally),
      recordOnly: Boolean(item.recordOnly),
      paid: Boolean(item.paid),
      paidAt: item.paidAt
    }))
  };
}

export function InvoiceCenter({ expenses, canMarkPaid, onInvoicePaid }: InvoiceCenterProps) {
  const [statusFilter, setStatusFilter] = useState<"ALL" | "UNPAID" | "PARTIALLY_PAID" | "PAID">("ALL");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [activeInvoice, setActiveInvoice] = useState<Invoice | null>(null);
  const [invoiceDraft, setInvoiceDraft] = useState<InvoiceInput | null>(null);
  const [editingInvoice, setEditingInvoice] = useState(false);
  const [savingInvoiceEdit, setSavingInvoiceEdit] = useState(false);
  const [selectedPayIndexes, setSelectedPayIndexes] = useState<number[]>([]);
  const [showCreateInvoice, setShowCreateInvoice] = useState(false);
  const [showVendorManager, setShowVendorManager] = useState(false);
  const [showPresetManager, setShowPresetManager] = useState(false);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [newVendorName, setNewVendorName] = useState("");
  const [materialPresets, setMaterialPresets] = useState<MaterialPreset[]>(
    () => parseStoredMaterialPresets(localStorage.getItem(materialPresetStorageKey)) || defaultMaterialPresets
  );
  const [removedPresetIds, setRemovedPresetIds] = useState<string[]>(
    () => parseStoredRemovedPresetIds(localStorage.getItem(materialPresetDeletedStorageKey))
  );
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetUnit, setNewPresetUnit] = useState("");
  const [newPresetPrice, setNewPresetPrice] = useState(0);
  const [form, setForm] = useState<InvoiceInput>({
    vendor: "",
    invoiceNumber: "",
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date().toISOString().slice(0, 10),
    currency: "USD",
    notes: "",
    items: [createEmptyItem()]
  });

  const materialOptions = useMemo(() => {
    return Array.from(new Set([...baseMaterialOptions, ...materialPresets.map((preset) => preset.name)])).sort();
  }, [materialPresets]);

  async function refresh() {
    try {
      setError("");
      const response = await api.getInvoices(statusFilter);
      setInvoices(response.invoices);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load invoices");
    }
  }

  async function refreshVendors() {
    try {
      setError("");
      const response = await api.getVendors();
      setVendors(response.vendors);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load vendors");
    }
  }

  useEffect(() => {
    refresh().catch(() => {
      // Handled in refresh.
    });
  }, [statusFilter]);

  useEffect(() => {
    refreshVendors().catch(() => {
      // Handled in refreshVendors.
    });
  }, []);

  useEffect(() => {
    localStorage.setItem(materialPresetStorageKey, JSON.stringify(materialPresets));
  }, [materialPresets]);

  useEffect(() => {
    localStorage.setItem(materialPresetDeletedStorageKey, JSON.stringify(removedPresetIds));
  }, [removedPresetIds]);

  useEffect(() => {
    setMaterialPresets((current) => mergePresetsWithExpenses(current, expenses, removedPresetIds));
  }, [expenses, removedPresetIds]);

  useEffect(() => {
    setForm((current) => {
      if (vendors.length === 1) {
        const singleVendor = vendors[0]?.name ?? "";
        if (singleVendor && current.vendor !== singleVendor) {
          return { ...current, vendor: singleVendor };
        }
        return current;
      }

      if (current.vendor && !vendors.some((vendor) => vendor.name === current.vendor)) {
        return { ...current, vendor: "" };
      }

      return current;
    });
  }, [vendors]);

  function updatePreset(id: string, patch: Partial<Omit<MaterialPreset, "id">>) {
    setMaterialPresets((current) =>
      current.map((preset) =>
        preset.id === id
          ? (() => {
              const nextUnit = patch.unit !== undefined ? normalizeUnitValue(patch.unit) : preset.unit;
              const nextUnitPrice = patch.unitPrice !== undefined ? Number(patch.unitPrice) : preset.unitPrice;
              const shouldAddHistory = patch.unitPrice !== undefined && Number.isFinite(nextUnitPrice) && nextUnitPrice !== preset.unitPrice;

              return {
                ...preset,
                ...patch,
                unit: nextUnit,
                unitPrice: nextUnitPrice,
                priceHistory: shouldAddHistory
                  ? [
                      ...preset.priceHistory,
                      {
                        unitPrice: nextUnitPrice,
                        changedAt: new Date().toISOString()
                      }
                    ]
                  : preset.priceHistory
              };
            })()
          : preset
      )
    );
  }

  async function addVendor() {
    const name = newVendorName.trim();
    if (!name) {
      return;
    }

    if (vendors.some((vendor) => vendor.name.toLowerCase() === name.toLowerCase())) {
      setError("That vendor already exists.");
      return;
    }

    try {
      setError("");
      const response = await api.createVendor({ name });
      setVendors((current) => [...current, response.vendor].sort((a, b) => a.name.localeCompare(b.name)));
      setNewVendorName("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to add vendor");
    }
  }

  async function removeVendor(id: string) {
    try {
      setError("");
      await api.deleteVendor(id);
      setVendors((current) => current.filter((vendor) => vendor._id !== id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to remove vendor");
    }
  }

  function addPreset() {
    const name = normalizeMaterialName(newPresetName);
    if (!name) {
      return;
    }

    const id = toPresetId(name);
    if (materialPresets.some((preset) => preset.id === id)) {
      setError("That material preset already exists.");
      return;
    }

    setError("");
    setRemovedPresetIds((current) => current.filter((removedId) => removedId !== id));
    setMaterialPresets((current) => [
      ...current,
      {
        id,
        name,
        unit: normalizeUnitValue(newPresetUnit),
        unitPrice: Number(newPresetPrice || 0),
        priceHistory:
          Number(newPresetPrice || 0) > 0
            ? [
                {
                  unitPrice: Number(newPresetPrice || 0),
                  changedAt: new Date().toISOString()
                }
              ]
            : []
      }
    ]);
    setNewPresetName("");
    setNewPresetUnit("");
    setNewPresetPrice(0);
  }

  function removePreset(id: string) {
    setMaterialPresets((current) => current.filter((preset) => preset.id !== id));
    setRemovedPresetIds((current) => (current.includes(id) ? current : [...current, id]));
  }

  function updateItem(index: number, patch: Partial<InvoiceItem>) {
    setForm((current) => {
      const items = [...current.items];
      const next = { ...items[index], ...patch };

      if (patch.materialLabel !== undefined) {
        const normalized = (patch.materialLabel ?? "").trim();
        if (normalized) {
          next.category = buildMaterialsCategory(normalized);
          next.trackToTally = true;
          if (!next.description.trim()) {
            next.description = normalized;
          }

          const matchingPreset = materialPresets.find((preset) => preset.name.toLowerCase() === normalized.toLowerCase());
          if (matchingPreset) {
            next.unit = normalizeUnitValue(matchingPreset.unit);
            next.unitPrice = matchingPreset.unitPrice;
            if (!Number.isFinite(next.quantity) || next.quantity <= 0) {
              next.quantity = 1;
            }
            next.amount = Number((next.quantity * next.unitPrice).toFixed(2));
          }
        } else if (isMaterialsCategory(next.category)) {
          next.category = "Materials";
        }
      }

      if (patch.recordOnly !== undefined && patch.recordOnly) {
        next.trackToTally = false;
      }

      if (next.recordOnly) {
        next.trackToTally = false;
      }

      if (patch.quantity !== undefined || patch.unitPrice !== undefined) {
        next.amount = Number((next.quantity * next.unitPrice).toFixed(2));
      }

      items[index] = next;
      return { ...current, items };
    });
  }

  function addItem() {
    setForm((current) => ({ ...current, items: [...current.items, createEmptyItem()] }));
  }

  function removeItem(index: number) {
    setForm((current) => ({
      ...current,
      items: current.items.filter((_item, itemIndex) => itemIndex !== index)
    }));
  }

  const invoiceTotal = useMemo(() => {
    return form.items.reduce((sum, item) => sum + (item.recordOnly ? 0 : item.amount), 0);
  }, [form.items]);

  const invoiceDraftTotal = useMemo(() => {
    if (!invoiceDraft) {
      return 0;
    }

    return invoiceDraft.items.reduce((sum, item) => sum + (item.recordOnly ? 0 : item.amount), 0);
  }, [invoiceDraft]);

  async function handleCreateInvoice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setActionMessage("");

    try {
      await api.createInvoice({
        ...form,
        items: form.items.filter((item) => item.description.trim().length > 0)
      });

      setForm({
        vendor: vendors.length === 1 ? vendors[0].name : "",
        invoiceNumber: "",
        issueDate: new Date().toISOString().slice(0, 10),
        dueDate: new Date().toISOString().slice(0, 10),
        currency: "USD",
        notes: "",
        items: [createEmptyItem()]
      });

      await refresh();
      setShowCreateInvoice(false);
      setActionMessage("Invoice created.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to create invoice");
    } finally {
      setSaving(false);
    }
  }

  function openInvoice(invoice: Invoice) {
    setActiveInvoice(invoice);
    setInvoiceDraft(toInvoiceInput(invoice));
    setEditingInvoice(false);
    setSelectedPayIndexes([]);
  }

  function updateInvoiceDraftItem(index: number, patch: Partial<InvoiceItem>) {
    setInvoiceDraft((current) => {
      if (!current) {
        return current;
      }

      const items = [...current.items];
      const next = { ...items[index], ...patch };

      if (patch.materialLabel !== undefined) {
        const normalized = (patch.materialLabel ?? "").trim();
        if (normalized) {
          next.category = buildMaterialsCategory(normalized);
          next.trackToTally = true;
          if (!next.description.trim()) {
            next.description = normalized;
          }

          const matchingPreset = materialPresets.find((preset) => preset.name.toLowerCase() === normalized.toLowerCase());
          if (matchingPreset) {
            next.unit = normalizeUnitValue(matchingPreset.unit);
            next.unitPrice = matchingPreset.unitPrice;
            if (!Number.isFinite(next.quantity) || next.quantity <= 0) {
              next.quantity = 1;
            }
            next.amount = Number((next.quantity * next.unitPrice).toFixed(2));
          }
        } else if (isMaterialsCategory(next.category)) {
          next.category = "Materials";
        }
      }

      if (patch.recordOnly !== undefined && patch.recordOnly) {
        next.trackToTally = false;
      }

      if (patch.quantity !== undefined || patch.unitPrice !== undefined) {
        next.amount = Number((next.quantity * next.unitPrice).toFixed(2));
      }

      items[index] = next;
      return { ...current, items };
    });
  }

  async function saveInvoiceEdit() {
    if (!activeInvoice || !invoiceDraft) {
      return;
    }

    setSavingInvoiceEdit(true);
    setError("");

    try {
      const result = await api.updateInvoice(activeInvoice._id, {
        ...invoiceDraft,
        items: invoiceDraft.items.filter((item) => item.description.trim().length > 0)
      });

      await refresh();
      setActiveInvoice(result.invoice);
      setInvoiceDraft(toInvoiceInput(result.invoice));
      setEditingInvoice(false);
      setActionMessage("Invoice updated.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to update invoice");
    } finally {
      setSavingInvoiceEdit(false);
    }
  }

  async function markPaid(invoiceId: string, itemIndexes?: number[]) {
    try {
      const result = await api.markInvoicePaid(invoiceId, { phase: "Phase 1", itemIndexes });
      await refresh();
      await onInvoicePaid();
      setActionMessage(
        `Marked paid. ${result.createdExpenses} new expense row(s), ${result.mergedTallies ?? 0} material tally update(s), ${result.ignoredItems ?? 0} not-paid line(s) ignored.`
      );
      setActiveInvoice(result.invoice);
      setInvoiceDraft(toInvoiceInput(result.invoice));
      setEditingInvoice(false);
      setSelectedPayIndexes([]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to mark invoice paid");
    }
  }

  return (
    <section className="invoice-page">
      {actionMessage && <p className="success-text">{actionMessage}</p>}

      {showCreateInvoice && (
        <div className="modal-backdrop" onClick={() => setShowCreateInvoice(false)}>
          <form className="expense-widget-panel invoice-create-modal panel stack-sm" onSubmit={handleCreateInvoice} onClick={(event) => event.stopPropagation()}>
            <div className="expense-widget-header">
              <h3>Create Invoice</h3>
              <div className="inline-form wrap">
                <strong>{formatCurrency(invoiceTotal)}</strong>
                <button className="btn ghost" type="button" onClick={() => setShowCreateInvoice(false)}>
                  Close
                </button>
              </div>
            </div>

            <div className="invoice-toolbar">
              <button className="tool-btn" type="button" onClick={() => setShowVendorManager(true)}>
                <VendorIcon />
                <span>Add Vendor</span>
              </button>
              <button className="tool-btn" type="button" onClick={() => setShowPresetManager(true)}>
                <MaterialIcon />
                <span>Add Material</span>
              </button>
            </div>

            <div className="form-grid">
              <label>
                Vendor
                <select
                  required
                  value={form.vendor}
                  onChange={(event) => setForm((prev) => ({ ...prev, vendor: event.target.value }))}
                >
                  <option value="">{vendors.length > 0 ? "Select vendor" : "No vendors yet"}</option>
                  {vendors.map((vendor) => (
                    <option key={vendor._id} value={vendor.name}>
                      {vendor.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Invoice Number
                <input
                  required
                  value={form.invoiceNumber}
                  onChange={(event) => setForm((prev) => ({ ...prev, invoiceNumber: event.target.value }))}
                />
              </label>
              <label>
                Issue Date
                <input
                  type="date"
                  value={form.issueDate}
                  onChange={(event) => setForm((prev) => ({ ...prev, issueDate: event.target.value }))}
                />
              </label>
              <label>
                Due Date
                <input
                  type="date"
                  required
                  value={form.dueDate}
                  onChange={(event) => setForm((prev) => ({ ...prev, dueDate: event.target.value }))}
                />
              </label>
              <label>
                Currency
                <input
                  maxLength={3}
                  value={form.currency}
                  onChange={(event) => setForm((prev) => ({ ...prev, currency: event.target.value.toUpperCase() }))}
                />
              </label>
              <label>
                Notes
                <input
                  value={form.notes}
                  onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
                />
              </label>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Category</th>
                    <th>Material</th>
                    <th>Unit</th>
                    <th>Qty</th>
                    <th>Unit Price</th>
                    <th>Amount</th>
                    <th>
                      Tally
                      <span
                        className="info-icon"
                        title="When enabled, this line is merged into an existing material tally when invoice is marked paid instead of creating a separate expense row."
                        aria-label="Tally info"
                      >
                        i
                      </span>
                    </th>
                    <th>
                      Not Paid
                      <span
                        className="info-icon"
                        title="If checked, this line is excluded from invoice total and ignored on Mark Paid (no expense row, no tally update)."
                        aria-label="Not paid info"
                      >
                        i
                      </span>
                    </th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {form.items.map((item, index) => {
                    const rowMaterialName = resolveMaterialName(item.description, item.category).toLowerCase();
                    const matchedPreset = materialPresets.find((preset) => preset.name.toLowerCase() === rowMaterialName);
                    const isPresetMaterial = Boolean(matchedPreset) && isMaterialsCategory(item.category);
                    const isRecordOnly = Boolean(item.recordOnly);

                    return (
                      <tr key={`invoice-item-${index}`}>
                        <td>
                          <input
                            required
                            value={item.description}
                            onChange={(event) => updateItem(index, { description: event.target.value })}
                          />
                        </td>
                        <td>
                          <select
                            value={isMaterialsCategory(item.category) ? "Materials" : item.category}
                            onChange={(event) => {
                              const nextCategory = event.target.value;
                              if (nextCategory === "Materials") {
                                const material = item.materialLabel?.trim() ?? "";
                                updateItem(index, {
                                  category: buildMaterialsCategory(material),
                                  trackToTally: true
                                });
                                return;
                              }

                              updateItem(index, {
                                category: nextCategory,
                                trackToTally: false
                              });
                            }}
                          >
                            {invoiceCategoryOptions.map((categoryOption) => (
                              <option key={categoryOption} value={categoryOption}>
                                {categoryOption}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          {isMaterialsCategory(item.category) ? (
                            <select
                              value={item.materialLabel ?? ""}
                              onChange={(event) =>
                                updateItem(index, {
                                  materialLabel: event.target.value,
                                  category: buildMaterialsCategory(event.target.value),
                                  trackToTally: true
                                })
                              }
                            >
                              <option value="">Select material type</option>
                              {materialOptions.map((material) => (
                                <option key={material} value={material}>
                                  {material}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                        <td>
                          <input
                            list="invoice-unit-options"
                            value={item.unit ?? ""}
                            onChange={(event) => updateItem(index, { unit: event.target.value })}
                            placeholder="Bag / Ton / Load"
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            step="1"
                            value={item.quantity}
                            onChange={(event) => updateItem(index, { quantity: parseWholeNumber(event.target.value) })}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={item.unitPrice}
                            disabled={isPresetMaterial}
                            title={isPresetMaterial ? "Price comes from the selected material preset. Edit it in the Material Presets toolbar tool." : undefined}
                            onChange={(event) => updateItem(index, { unitPrice: Number(event.target.value) })}
                          />
                        </td>
                        <td>{formatCurrency(item.amount)}</td>
                        <td>
                          <input
                            type="checkbox"
                            checked={Boolean(item.trackToTally)}
                            disabled={!isMaterialsCategory(item.category) || isRecordOnly}
                            onChange={(event) => updateItem(index, { trackToTally: event.target.checked })}
                            title="Merge into existing material tally when paid"
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={isRecordOnly}
                            onChange={(event) => updateItem(index, { recordOnly: event.target.checked })}
                            title="Record this line only; skip tally/expense on mark paid"
                          />
                        </td>
                        <td>
                          <button className="btn ghost" type="button" onClick={() => removeItem(index)} disabled={form.items.length === 1}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="inline-form wrap">
              <button className="btn ghost" type="button" onClick={addItem}>
                Add Item
              </button>
              <button className="btn" type="submit" disabled={saving}>
                {saving ? "Saving..." : "Create Invoice"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showVendorManager && (
        <div className="modal-backdrop" onClick={() => setShowVendorManager(false)}>
          <div className="expense-widget-panel panel" onClick={(event) => event.stopPropagation()}>
            <div className="expense-widget-header">
              <h3>Vendors</h3>
              <button className="btn ghost" type="button" onClick={() => setShowVendorManager(false)}>
                Close
              </button>
            </div>

            <p className="muted">Add vendors once, then choose from dropdown in invoice creation.</p>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Vendor Name</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="muted">
                        No vendors added yet.
                      </td>
                    </tr>
                  ) : (
                    vendors.map((vendor) => (
                      <tr key={vendor._id}>
                        <td>{vendor.name}</td>
                        <td>
                          <button className="btn ghost" type="button" onClick={() => removeVendor(vendor._id)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="inline-form wrap">
              <input
                placeholder="Vendor name"
                value={newVendorName}
                onChange={(event) => setNewVendorName(event.target.value)}
              />
              <button className="btn" type="button" onClick={addVendor}>
                Add Vendor
              </button>
            </div>
          </div>
        </div>
      )}

      {showPresetManager && (
        <div className="modal-backdrop" onClick={() => setShowPresetManager(false)}>
          <div className="expense-widget-panel panel" onClick={(event) => event.stopPropagation()}>
            <div className="expense-widget-header">
              <h3>Material Presets</h3>
              <button className="btn ghost" type="button" onClick={() => setShowPresetManager(false)}>
                Close
              </button>
            </div>

            <p className="muted">Use this to add materials and maintain current unit prices for invoice and expense consistency.</p>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Material</th>
                    <th>Unit</th>
                    <th>Unit Price</th>
                    <th>History</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {materialPresets.map((preset) => (
                    <tr key={preset.id}>
                      <td>{preset.name}</td>
                      <td>
                        <input
                          list="invoice-unit-options"
                          value={preset.unit}
                          onChange={(event) => updatePreset(preset.id, { unit: normalizeUnitValue(event.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={preset.unitPrice}
                          onChange={(event) => updatePreset(preset.id, { unitPrice: Number(event.target.value) })}
                        />
                      </td>
                      <td>
                        <span className="info-icon" title={formatHistory(preset.priceHistory)} aria-label={`Price history for ${preset.name}`}>
                          i
                        </span>
                      </td>
                      <td>
                        <button className="btn ghost" type="button" onClick={() => removePreset(preset.id)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="preset-form-grid">
              <label>
                Material Name
                <input value={newPresetName} onChange={(event) => setNewPresetName(event.target.value)} />
              </label>
              <label>
                Unit
                <input
                  list="invoice-unit-options"
                  value={newPresetUnit}
                  onChange={(event) => setNewPresetUnit(normalizeUnitValue(event.target.value))}
                />
              </label>
              <label>
                Unit Price
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={newPresetPrice}
                  onChange={(event) => setNewPresetPrice(Number(event.target.value))}
                />
              </label>
              <div className="preset-form-action">
                <button className="btn" type="button" onClick={addPreset}>
                  Add Preset
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="panel invoice-list-panel">
        <div className="invoice-list-head">
          <div className="invoice-list-meta">
            <h3>Invoices</h3>
            <p className="muted">
              {invoices.length} {invoices.length === 1 ? "invoice" : "invoices"}
            </p>
          </div>
          <div className="inline-form wrap invoice-list-actions">
            <button className="btn" type="button" onClick={() => setShowCreateInvoice(true)}>
              Create Invoice
            </button>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "ALL" | "UNPAID" | "PARTIALLY_PAID" | "PAID")}>
              <option value="ALL">All invoices</option>
              <option value="UNPAID">Only unpaid invoices</option>
              <option value="PARTIALLY_PAID">Partially paid invoices</option>
              <option value="PAID">Only paid invoices</option>
            </select>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="table-wrap invoice-table-wrap">
          <table className="invoice-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Vendor</th>
                <th>Status</th>
                <th>Due</th>
                <th>Total</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td className="invoice-empty" colSpan={6}>
                    No invoices yet. Click Create Invoice to add your first one.
                  </td>
                </tr>
              ) : (
                invoices.map((invoice) => (
                  <tr key={invoice._id}>
                    <td>
                      <button className="btn ghost" type="button" onClick={() => openInvoice(invoice)}>
                        {invoice.invoiceNumber}
                      </button>
                    </td>
                    <td>{invoice.vendor}</td>
                    <td>{invoice.status}</td>
                    <td>{formatDate(invoice.dueDate)}</td>
                    <td>{formatCurrency(invoice.totalAmount)}</td>
                    <td>
                      <div className="invoice-row-actions">
                        <button className="btn ghost" type="button" onClick={() => openInvoice(invoice)}>
                          View
                        </button>
                        {invoice.status !== "PAID" && canMarkPaid ? (
                          <button className="btn" type="button" onClick={() => markPaid(invoice._id)}>
                            Mark Remaining Paid
                          </button>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <datalist id="invoice-unit-options">
        {unitOptions.map((unit) => (
          <option key={unit} value={unit} />
        ))}
      </datalist>

      {activeInvoice && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setActiveInvoice(null);
            setEditingInvoice(false);
            setSelectedPayIndexes([]);
          }}
        >
          <div className="expense-widget-panel invoice-detail-modal panel" onClick={(event) => event.stopPropagation()}>
            <div className="expense-widget-header">
              <h3>Invoice {activeInvoice.invoiceNumber}</h3>
              <div className="inline-form wrap">
                {!editingInvoice && activeInvoice.status === "UNPAID" && (
                  <button className="btn ghost" type="button" onClick={() => setEditingInvoice(true)}>
                    Edit Invoice
                  </button>
                )}
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    setActiveInvoice(null);
                    setEditingInvoice(false);
                    setSelectedPayIndexes([]);
                  }}
                >
                  Close
                </button>
              </div>
            </div>

            {editingInvoice && invoiceDraft ? (
              <div className="form-grid">
                <label>
                  Vendor
                  <input value={invoiceDraft.vendor} onChange={(event) => setInvoiceDraft((current) => current ? { ...current, vendor: event.target.value } : current)} />
                </label>
                <label>
                  Invoice Number
                  <input value={invoiceDraft.invoiceNumber} onChange={(event) => setInvoiceDraft((current) => current ? { ...current, invoiceNumber: event.target.value } : current)} />
                </label>
                <label>
                  Issue Date
                  <input type="date" value={invoiceDraft.issueDate?.slice(0, 10) ?? ""} onChange={(event) => setInvoiceDraft((current) => current ? { ...current, issueDate: event.target.value } : current)} />
                </label>
                <label>
                  Due Date
                  <input type="date" value={invoiceDraft.dueDate} onChange={(event) => setInvoiceDraft((current) => current ? { ...current, dueDate: event.target.value } : current)} />
                </label>
                <label>
                  Currency
                  <input value={invoiceDraft.currency ?? "USD"} maxLength={3} onChange={(event) => setInvoiceDraft((current) => current ? { ...current, currency: event.target.value.toUpperCase() } : current)} />
                </label>
                <label>
                  Notes
                  <input value={invoiceDraft.notes ?? ""} onChange={(event) => setInvoiceDraft((current) => current ? { ...current, notes: event.target.value } : current)} />
                </label>
              </div>
            ) : (
              <p className="muted">
                Vendor: {activeInvoice.vendor} | Status: {activeInvoice.status} | Due: {formatDate(activeInvoice.dueDate)} | Total: {formatCurrency(activeInvoice.totalAmount)}
              </p>
            )}

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {!editingInvoice && <th>Pay</th>}
                    <th>Description</th>
                    <th>Category</th>
                    <th>Material</th>
                    {!editingInvoice && <th>Unit</th>}
                    <th>Qty</th>
                    <th>Unit Price</th>
                    <th>Amount</th>
                    <th>Not Paid</th>
                    {!editingInvoice && <th>Status</th>}
                    {editingInvoice && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {(editingInvoice && invoiceDraft ? invoiceDraft.items : activeInvoice.items).map((item, index) => {
                    const currentCategory = item.category;
                    const isMaterialCategory = isMaterialsCategory(currentCategory);
                    const isLinePaid = Boolean(item.paid);
                    const isLineNotPaid = Boolean(item.recordOnly);
                    const isSelectable = !isLinePaid && !isLineNotPaid;

                    return (
                      <tr key={`detail-item-${index}`}>
                        {!editingInvoice && (
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedPayIndexes.includes(index)}
                              disabled={!isSelectable}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setSelectedPayIndexes((current) =>
                                  checked ? Array.from(new Set([...current, index])) : current.filter((value) => value !== index)
                                );
                              }}
                            />
                          </td>
                        )}

                        <td>
                          {editingInvoice ? (
                            <input value={item.description} onChange={(event) => updateInvoiceDraftItem(index, { description: event.target.value })} />
                          ) : (
                            item.description
                          )}
                        </td>

                        <td>
                          {editingInvoice ? (
                            <select
                              value={isMaterialsCategory(item.category) ? "Materials" : item.category}
                              onChange={(event) => {
                                const nextCategory = event.target.value;
                                if (nextCategory === "Materials") {
                                  updateInvoiceDraftItem(index, {
                                    category: buildMaterialsCategory(item.materialLabel ?? ""),
                                    trackToTally: true
                                  });
                                  return;
                                }

                                updateInvoiceDraftItem(index, { category: nextCategory, trackToTally: false });
                              }}
                            >
                              {invoiceCategoryOptions.map((categoryOption) => (
                                <option key={categoryOption} value={categoryOption}>{categoryOption}</option>
                              ))}
                            </select>
                          ) : (
                            item.category
                          )}
                        </td>

                        <td>
                          {isMaterialCategory ? (
                            editingInvoice ? (
                              <select
                                value={item.materialLabel ?? ""}
                                onChange={(event) =>
                                  updateInvoiceDraftItem(index, {
                                    materialLabel: event.target.value,
                                    category: buildMaterialsCategory(event.target.value),
                                    trackToTally: true
                                  })
                                }
                              >
                                <option value="">Select material type</option>
                                {materialOptions.map((material) => (
                                  <option key={material} value={material}>{material}</option>
                                ))}
                              </select>
                            ) : (
                              item.materialLabel || "-"
                            )
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>

                        {!editingInvoice && <td>{item.unit || "-"}</td>}

                        <td>
                          {editingInvoice ? (
                            <input type="number" min={0} step="1" value={item.quantity} onChange={(event) => updateInvoiceDraftItem(index, { quantity: parseWholeNumber(event.target.value) })} />
                          ) : (
                            item.quantity.toLocaleString()
                          )}
                        </td>

                        <td>{formatCurrency(item.unitPrice)}</td>

                        <td>{formatCurrency(item.amount)}</td>

                        <td>
                          {editingInvoice ? (
                            <input
                              type="checkbox"
                              checked={isLineNotPaid}
                              onChange={(event) => updateInvoiceDraftItem(index, { recordOnly: event.target.checked })}
                            />
                          ) : isLineNotPaid ? (
                            "Yes"
                          ) : (
                            "No"
                          )}
                        </td>

                        {!editingInvoice && (
                          <td>{isLineNotPaid ? "Not Paid" : isLinePaid ? "Paid" : "Unpaid"}</td>
                        )}

                        {editingInvoice && (
                          <td>
                            <button
                              className="btn ghost"
                              type="button"
                              onClick={() => setInvoiceDraft((current) => current ? { ...current, items: current.items.filter((_item, itemIndex) => itemIndex !== index) } : current)}
                              disabled={(invoiceDraft?.items.length ?? 0) <= 1}
                            >
                              Remove
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {editingInvoice && invoiceDraft ? (
              <div className="inline-form wrap">
                <button className="btn ghost" type="button" onClick={() => setInvoiceDraft((current) => current ? { ...current, items: [...current.items, createEmptyItem()] } : current)}>
                  Add Item
                </button>
                <strong>{formatCurrency(invoiceDraftTotal)}</strong>
                <button className="btn" type="button" onClick={() => saveInvoiceEdit()} disabled={savingInvoiceEdit}>
                  {savingInvoiceEdit ? "Saving..." : "Save Invoice"}
                </button>
                <button className="btn ghost" type="button" onClick={() => { setEditingInvoice(false); setInvoiceDraft(toInvoiceInput(activeInvoice)); }}>
                  Cancel
                </button>
              </div>
            ) : (
              canMarkPaid && activeInvoice.status !== "PAID" && (
                <div className="inline-form wrap">
                  <button
                    className="btn"
                    type="button"
                    disabled={selectedPayIndexes.length === 0}
                    onClick={() => markPaid(activeInvoice._id, selectedPayIndexes)}
                  >
                    Mark Selected Paid
                  </button>
                  <button className="btn ghost" type="button" onClick={() => markPaid(activeInvoice._id)}>
                    Mark All Remaining
                  </button>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </section>
  );
}













