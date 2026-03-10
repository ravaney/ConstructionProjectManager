import { useEffect, useMemo, useState } from "react";
import type { Expense, ExpenseInput, ExpenseTallyDetails, Task, WorkerProfile, WorkerRole } from "../types/models";
import { api } from "../utils/api";
import { formatCurrency, formatDate } from "../utils/format";
import { buildScopeLabel, getCurrentPhase, getCurrentSection, getPhaseNodes, getSectionsForPhase } from "../utils/workBreakdown";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  isMaterialsCategory,
  materialPresetStorageKey,
  mergePresetsWithExpenses,
  parseStoredMaterialPresets,
  resolveMaterialName,
  toPresetId,
  type MaterialPreset
} from "../utils/materialPresets";

type ExpenseSectionProps = {
  expenses: Expense[];
  tasks: Task[];
  canDeleteExpense: boolean;
  onAddExpense: (payload: ExpenseInput) => Promise<void>;
  onUpdateExpense: (id: string, payload: Partial<ExpenseInput>) => Promise<void>;
  onDeleteExpense: (id: string) => Promise<void>;
};

type ExpenseVisual = {
  type: "labor" | "land" | "lumber" | "aggregates" | "cement" | "steel" | "utilities" | "materials" | "other";
  label: string;
};

type OptionalExpenseColumns = {
  quantity: boolean;
  unit: boolean;
  unitCost: boolean;
};

const expenseColumnSettingsKey = "dream_home_expense_optional_columns_v1";

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

function normalizeWorkerRole(role?: string): WorkerRole {
  if (role === "STEEL_MAN") {
    return "STEELWORKER";
  }

  return (role ?? "OTHER") as WorkerRole;
}

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

const defaultForm: ExpenseInput = {
  name: "",
  category: "Materials",
  amount: 0,
  unit: "",
  unitPrice: 0,
  quantity: 0,
  date: new Date().toISOString().slice(0, 10),
  vendor: "",
  phase: "",
  phaseTaskId: "",
  section: "",
  sectionTaskId: "",
  notes: "",
  workerRole: "OTHER"
};

const expenseCategories = [
  "Materials",
  "Labour Cost",
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

const materialOptions = [
  "Cement",
  "Steel",
  "Lumber",
  "Sand",
  "Gravel",
  "Aggregate",
  "Tiles",
  "Electrical",
  "Plumbing",
  "Nails & Fasteners",
  "Paint & Coatings",
  "Roofing",
  "Drywall",
  "Insulation",
  "Flooring",
  "Doors & Windows",
  "Hardware",
  "Other"
] as const;
const unitOptions = ["bag", "ton", "load", "cubic yard", "cubic meter", "piece", "kg", "lb", "ft", "m", "sheet"] as const;

function buildMaterialsCategory(subcategory?: string): string {
  const normalized = (subcategory ?? "").trim();
  return normalized ? `Materials / ${normalized}` : "Materials";
}

function getMaterialSubcategory(category?: string): string {
  const normalized = (category ?? "").trim();
  if (!isMaterialsCategory(normalized)) {
    return "";
  }

  const slashIndex = normalized.indexOf("/");
  if (slashIndex < 0) {
    return "";
  }

  return normalized.slice(slashIndex + 1).trim();
}

function isVendorDrivenCategory(category?: string): boolean {
  const normalized = (category ?? "").trim().toLowerCase();
  return isMaterialsCategory(category) || normalized.includes("equipment rental");
}

function normalizeExpenseCategory(category?: string): string {
  const normalized = (category ?? "").trim();
  if (normalized === "Labor Cost") {
    return "Labour Cost";
  }

  if (normalized.startsWith("Labor Cost /")) {
    return normalized.replace("Labor Cost /", "Labour Cost /").trim();
  }

  return normalized;
}

function isLaborCategory(category?: string): boolean {
  const normalized = (category ?? "").trim().toLowerCase();
  return normalized.includes("labor") || normalized.includes("labour");
}

function formatExpenseCategoryDisplay(category: string): string {
  return normalizeExpenseCategory(category);
}

function ExpenseTypeIcon({ type }: { type: ExpenseVisual["type"] }) {
  const props = {
    className: "expense-type-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  switch (type) {
    case "labor":
      return (
        <svg {...props}>
          <path d="M4 13h16" />
          <path d="M6 13v4h12v-4" />
          <path d="M8 13a4 4 0 0 1 8 0" />
          <path d="M12 4v3" />
        </svg>
      );
    case "land":
      return (
        <svg {...props}>
          <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
          <path d="M9 4v14" />
          <path d="M15 6v14" />
        </svg>
      );
    case "lumber":
      return (
        <svg {...props}>
          <rect x="4" y="7" width="16" height="4" />
          <rect x="4" y="13" width="16" height="4" />
          <path d="M8 7v4" />
          <path d="M14 13v4" />
        </svg>
      );
    case "aggregates":
      return (
        <svg {...props}>
          <path d="M4 17h16" />
          <path d="M6 17l3-6 3 6" />
          <path d="M12 17l3-8 3 8" />
        </svg>
      );
    case "cement":
      return (
        <svg {...props}>
          <rect x="6" y="5" width="12" height="14" />
          <path d="M9 9h6" />
          <path d="M9 13h6" />
        </svg>
      );
    case "steel":
      return (
        <svg {...props}>
          <path d="M5 6h14v4H5z" />
          <path d="M5 14h14v4H5z" />
          <path d="M8 10v4" />
          <path d="M12 10v4" />
          <path d="M16 10v4" />
        </svg>
      );
    case "utilities":
      return (
        <svg {...props}>
          <path d="M12 3v8" />
          <path d="M9 9l3-6 3 6" />
          <path d="M7 13h10" />
          <path d="M10 13v8" />
          <path d="M14 13v8" />
        </svg>
      );
    case "materials":
      return (
        <svg {...props}>
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
      );
  }
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

function ViewIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function getExpenseVisual(category: string, name: string): ExpenseVisual {
  const normalizedCategory = category.toLowerCase();
  const normalizedName = name.toLowerCase();

  if (normalizedCategory.includes("labor") || normalizedCategory.includes("labour")) {
    return { type: "labor", label: "Labor" };
  }

  if (normalizedCategory.includes("land")) {
    return { type: "land", label: "Land" };
  }

  if (normalizedCategory.includes("utility") || normalizedCategory.includes("electric") || normalizedCategory.includes("plumb")) {
    return { type: "utilities", label: "Utilities" };
  }

  if (normalizedCategory.includes("material")) {
    if (normalizedName.includes("lumber") || normalizedName.includes("wood") || normalizedName.includes("2x4")) {
      return { type: "lumber", label: "Lumber" };
    }

    if (
      normalizedName.includes("sand") ||
      normalizedName.includes("gravel") ||
      normalizedName.includes("aggregate") ||
      normalizedName.includes("stone")
    ) {
      return { type: "aggregates", label: "Aggregates" };
    }

    if (
      normalizedName.includes("cement") ||
      normalizedName.includes("concrete") ||
      normalizedName.includes("mortar") ||
      normalizedName.includes("block")
    ) {
      return { type: "cement", label: "Cement/Concrete" };
    }

    if (normalizedName.includes("steel") || normalizedName.includes("rebar") || normalizedName.includes("wire") || normalizedName.includes("metal")) {
      return { type: "steel", label: "Steel/Metal" };
    }

    return { type: "materials", label: "General Materials" };
  }

  return { type: "other", label: "Other" };
}

export function ExpenseSection({
  expenses,
  tasks,
  canDeleteExpense,
  onAddExpense,
  onUpdateExpense,
  onDeleteExpense
}: ExpenseSectionProps) {
  const [form, setForm] = useState<ExpenseInput>(defaultForm);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [submitting, setSubmitting] = useState(false);
  const [showAddWidget, setShowAddWidget] = useState(false);
  const [showColumnSettings, setShowColumnSettings] = useState(false);
  const [materialSubcategory, setMaterialSubcategory] = useState("");
  const [optionalColumns, setOptionalColumns] = useState<OptionalExpenseColumns>({
    quantity: false,
    unit: false,
    unitCost: false
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<ExpenseInput> | null>(null);
  const [workers, setWorkers] = useState<WorkerProfile[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [pendingDeleteExpense, setPendingDeleteExpense] = useState<Expense | null>(null);
  const [deletingExpense, setDeletingExpense] = useState(false);
  const [detailExpense, setDetailExpense] = useState<Expense | null>(null);
  const [detailData, setDetailData] = useState<ExpenseTallyDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const phaseNodes = useMemo(() => getPhaseNodes(tasks), [tasks]);
  const currentPhase = useMemo(() => getCurrentPhase(tasks), [tasks]);
  const formSections = useMemo(() => getSectionsForPhase(tasks, form.phaseTaskId), [tasks, form.phaseTaskId]);
  const editSections = useMemo(() => getSectionsForPhase(tasks, editForm?.phaseTaskId), [tasks, editForm?.phaseTaskId]);

  const categories = useMemo(() => {
    return Array.from(new Set(expenses.map((expense) => normalizeExpenseCategory(expense.category)))).sort();
  }, [expenses]);

  const categoryOptions = useMemo(() => {
    return Array.from(new Set([...expenseCategories, ...categories])).sort();
  }, [categories]);

  const baseCategoryOptions = useMemo(() => {
    return Array.from(new Set(categoryOptions.map((value) => (isMaterialsCategory(value) ? "Materials" : normalizeExpenseCategory(value))))).sort();
  }, [categoryOptions]);

  const filteredExpenses = useMemo(() => {
    return expenses.filter((expense) => {
      const matchesSearch = expense.name.toLowerCase().includes(search.toLowerCase());
      const matchesCategory = category === "All" || normalizeExpenseCategory(expense.category) === category;
      return matchesSearch && matchesCategory;
    });
  }, [expenses, search, category]);

  const vendorOptions = useMemo(() => {
    const uniqueByLower = new Map<string, string>();
    const names = [...vendors, ...expenses.map((expense) => expense.vendor)];

    for (const rawName of names) {
      const name = rawName.trim();
      if (!name) {
        continue;
      }

      const key = name.toLowerCase();
      if (!uniqueByLower.has(key)) {
        uniqueByLower.set(key, name);
      }
    }

    return Array.from(uniqueByLower.values()).sort((a, b) => a.localeCompare(b));
  }, [vendors, expenses]);

  function computeAmount(quantity?: number, unitPrice?: number): number {
    const qty = Number(quantity ?? 0);
    const price = Number(unitPrice ?? 0);
    return qty > 0 && price >= 0 ? Number((qty * price).toFixed(2)) : 0;
  }

  function findPhaseIdByName(phaseName?: string): string {
    return phaseNodes.find((phase) => phase.title === (phaseName ?? "").trim())?._id ?? "";
  }

  function findSectionIdByName(phaseId?: string, sectionName?: string): string {
    return getSectionsForPhase(tasks, phaseId).find((section) => section.title === (sectionName ?? "").trim())?._id ?? "";
  }

  async function loadWorkers() {
    try {
      const response = await api.getWorkers();
      setWorkers(response.workers.filter((worker) => worker.isActive));
    } catch (_error) {
      // Keep widget functional even if workers fail to load.
      setWorkers([]);
    }
  }

  async function loadVendors() {
    try {
      const response = await api.getVendors();
      setVendors(response.vendors.map((vendor) => vendor.name).filter((name) => name.trim().length > 0));
    } catch (_error) {
      setVendors([]);
    }
  }

  useEffect(() => {
    loadWorkers().catch(() => {
      setWorkers([]);
    });
    loadVendors().catch(() => {
      setVendors([]);
    });
  }, []);

  useEffect(() => {
    if (!showAddWidget) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowAddWidget(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showAddWidget]);

  useEffect(() => {
    if (!showAddWidget) {
      setMaterialSubcategory("");
    }
  }, [showAddWidget]);

  useEffect(() => {
    if (!phaseNodes.length) {
      return;
    }

    setForm((current) => {
      if (current.phaseTaskId) {
        return current;
      }

      const nextPhase = currentPhase ?? phaseNodes[0];
      if (!nextPhase) {
        return current;
      }

      const nextSection = getCurrentSection(tasks, nextPhase._id) ?? getSectionsForPhase(tasks, nextPhase._id)[0];
      return {
        ...current,
        phase: nextPhase.title,
        phaseTaskId: nextPhase._id,
        section: nextSection?.title ?? "",
        sectionTaskId: nextSection?._id ?? ""
      };
    });
  }, [currentPhase, phaseNodes, tasks]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(expenseColumnSettingsKey);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as Partial<OptionalExpenseColumns>;
      setOptionalColumns((current) => ({
        quantity: typeof parsed.quantity === "boolean" ? parsed.quantity : current.quantity,
        unit: typeof parsed.unit === "boolean" ? parsed.unit : current.unit,
        unitCost: typeof parsed.unitCost === "boolean" ? parsed.unitCost : current.unitCost
      }));
    } catch {
      // Keep defaults when local storage is invalid.
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(expenseColumnSettingsKey, JSON.stringify(optionalColumns));
  }, [optionalColumns]);

  function applyScopeToForm(phaseId: string, sectionId?: string) {
    const phaseNode = phaseNodes.find((task) => task._id === phaseId);
    const sectionNode = getSectionsForPhase(tasks, phaseId).find((task) => task._id === sectionId);

    setForm((current) => ({
      ...current,
      phaseTaskId: phaseNode?._id ?? "",
      phase: phaseNode?.title ?? "",
      sectionTaskId: sectionNode?._id ?? "",
      section: sectionNode?.title ?? ""
    }));
  }

  function applyScopeToEditForm(phaseId: string, sectionId?: string) {
    const phaseNode = phaseNodes.find((task) => task._id === phaseId);
    const sectionNode = getSectionsForPhase(tasks, phaseId).find((task) => task._id === sectionId);

    setEditForm((current) => ({
      ...(current ?? {}),
      phaseTaskId: phaseNode?._id ?? "",
      phase: phaseNode?.title ?? "",
      sectionTaskId: sectionNode?._id ?? "",
      section: sectionNode?.title ?? ""
    }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);

    try {
      const categoryValue = isMaterialsCategory(form.category)
        ? buildMaterialsCategory(materialSubcategory || getMaterialSubcategory(form.category))
        : normalizeExpenseCategory(form.category);
      const calculatedAmount = computeAmount(form.quantity, form.unitPrice);
      const payload: ExpenseInput = {
        ...form,
        category: categoryValue,
        unit: form.unit?.trim() ?? "",
        quantity: Number(form.quantity ?? 0),
        unitPrice: Number(form.unitPrice ?? 0),
        amount: calculatedAmount > 0 ? calculatedAmount : Number(form.amount ?? 0)
      };

      await onAddExpense(payload);
      const nextPhase = currentPhase ?? phaseNodes[0];
      const nextSection = nextPhase ? getCurrentSection(tasks, nextPhase._id) ?? getSectionsForPhase(tasks, nextPhase._id)[0] : undefined;
      setForm({
        ...defaultForm,
        phase: nextPhase?.title ?? "",
        phaseTaskId: nextPhase?._id ?? "",
        section: nextSection?.title ?? "",
        sectionTaskId: nextSection?._id ?? ""
      });
      setMaterialSubcategory("");
      setShowAddWidget(false);
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(expense: Expense) {
    setEditingId(expense._id);
    setEditForm({
      name: expense.name,
      category: normalizeExpenseCategory(expense.category),
      amount: expense.amount,
      quantity: expense.quantity,
      unitPrice: expense.unitPrice,
      unit: expense.unit,
      date: expense.date.slice(0, 10),
      vendor: expense.vendor,
      phase: expense.phase,
      phaseTaskId: expense.phaseTaskId ?? findPhaseIdByName(expense.phase),
      section: expense.section ?? "",
      sectionTaskId:
        expense.sectionTaskId ??
        findSectionIdByName(expense.phaseTaskId ?? findPhaseIdByName(expense.phase), expense.section),
      notes: expense.notes,
      workerRole: normalizeWorkerRole(expense.workerRole),
      workerProfileId: expense.workerProfileId
    });
  }

  async function saveEdit() {
    if (!editingId || !editForm) {
      return;
    }

    await onUpdateExpense(editingId, editForm);
    setEditingId(null);
    setEditForm(null);
  }

  async function confirmDeleteExpense() {
    if (!pendingDeleteExpense) {
      return;
    }

    setDeletingExpense(true);
    try {
      await onDeleteExpense(pendingDeleteExpense._id);
      setPendingDeleteExpense(null);
    } finally {
      setDeletingExpense(false);
    }
  }

  async function openTallyDetails(expense: Expense) {
    setDetailExpense(expense);
    setDetailData(null);
    setDetailError("");
    setDetailLoading(true);

    try {
      const result = await api.getExpenseTallyDetails(expense._id);
      setDetailData(result);
    } catch (requestError) {
      setDetailError(requestError instanceof Error ? requestError.message : "Failed to load invoice details");
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <section className="stack-lg">
      <div className="panel stack-sm">
        <div className="expense-log-top">
        <div className="row-between wrap expense-toolbar">
          <div>
            <h3>Expense Log</h3>
            <p className="muted">{filteredExpenses.length} records</p>
          </div>
          <div className="expense-toolbar-actions">
            <button className="btn ghost" type="button" onClick={() => setShowColumnSettings((current) => !current)}>
              Column Settings
            </button>
            <button className="btn" type="button" onClick={() => setShowAddWidget(true)}>
              Add Expense Widget
            </button>
          </div>
        </div>

        {showColumnSettings && (
          <div className="expense-column-settings">
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={optionalColumns.quantity}
                onChange={(event) =>
                  setOptionalColumns((current) => ({
                    ...current,
                    quantity: event.target.checked
                  }))
                }
              />
              <span>Show Qty</span>
            </label>
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={optionalColumns.unit}
                onChange={(event) =>
                  setOptionalColumns((current) => ({
                    ...current,
                    unit: event.target.checked
                  }))
                }
              />
              <span>Show Unit</span>
            </label>
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={optionalColumns.unitCost}
                onChange={(event) =>
                  setOptionalColumns((current) => ({
                    ...current,
                    unitCost: event.target.checked
                  }))
                }
              />
              <span>Show Unit Cost</span>
            </label>
          </div>
        )}

        <div className="icon-legend">
          <span><ExpenseTypeIcon type="labor" /> Labor</span>
          <span><ExpenseTypeIcon type="lumber" /> Lumber</span>
          <span><ExpenseTypeIcon type="aggregates" /> Aggregates</span>
          <span><ExpenseTypeIcon type="cement" /> Cement</span>
          <span><ExpenseTypeIcon type="steel" /> Steel</span>
        </div>

        <div className="inline-form wrap expense-filter-row">
          <input
            placeholder="Search by item"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />

          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="All">All categories</option>
            {categoryOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        </div>

        <div className="table-wrap">
          <table className="expense-log-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                {optionalColumns.quantity && <th>Qty</th>}
                {optionalColumns.unit && <th>Unit</th>}
                {optionalColumns.unitCost && <th>Unit Cost</th>}
                <th>Worker/Vendor</th>
                <th>Amount</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredExpenses.map((expense) => {
                const isEditing = editingId === expense._id;
                const visual = getExpenseVisual(expense.category, expense.name);
                const workerName = workers.find((worker) => worker._id === expense.workerProfileId)?.name;
                const editingCategoryValue = editForm?.category ?? expense.category;
                const editingBaseCategory = isMaterialsCategory(editingCategoryValue) ? "Materials" : normalizeExpenseCategory(editingCategoryValue);
                const editingMaterialSubcategory = getMaterialSubcategory(editingCategoryValue);
                const isVendorExpense = isVendorDrivenCategory(expense.category);
                const isMaterialExpense = isMaterialsCategory(expense.category);
                const isEditingLaborExpense = isLaborCategory(editingCategoryValue);
                const effectiveVendor = ((isEditing ? editForm?.vendor : expense.vendor) ?? "").trim();

                return (
                  <tr key={expense._id}>
                    <td>
                      {isEditing ? (
                        <div className="stack-sm">
                          <input
                            value={editForm?.name ?? ""}
                            onChange={(event) =>
                              setEditForm((current) => ({
                                ...(current ?? {}),
                                name: event.target.value,
                                amount: current?.amount ?? expense.amount,
                                category: current?.category ?? expense.category
                              }))
                            }
                          />
                          <div className="scope-edit-grid">
                            <select
                              value={editForm?.phaseTaskId ?? ""}
                              onChange={(event) => applyScopeToEditForm(event.target.value)}
                            >
                              <option value="">Select phase</option>
                              {phaseNodes.map((phase) => (
                                <option key={phase._id} value={phase._id}>
                                  {phase.title}
                                </option>
                              ))}
                            </select>
                            <select
                              value={editForm?.sectionTaskId ?? ""}
                              onChange={(event) => applyScopeToEditForm(editForm?.phaseTaskId ?? "", event.target.value)}
                              disabled={!editForm?.phaseTaskId || editSections.length === 0}
                            >
                              <option value="">{editSections.length > 0 ? "No section" : "No sections"}</option>
                              {editSections.map((section) => (
                                <option key={section._id} value={section._id}>
                                  {section.title}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      ) : (
                        <div className="expense-title-cell">
                          <span className="expense-icon-wrap"><ExpenseTypeIcon type={visual.type} /></span>
                          <div className="expense-title-text">
                            <strong>{expense.name}</strong>
                            <span className="muted small-text">{buildScopeLabel(expense.phase, expense.section)}</span>
                            <span className="muted small-text">{visual.label}</span>
                          </div>
                        </div>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <div className="stack-sm">
                          <select
                            value={editingBaseCategory}
                            onChange={(event) =>
                              setEditForm((current) => {
                                const nextBase = event.target.value;
                                return {
                                  ...(current ?? {}),
                                  category:
                                    nextBase === "Materials"
                                      ? buildMaterialsCategory(getMaterialSubcategory(current?.category ?? expense.category))
                                      : nextBase,
                                  amount: current?.amount ?? expense.amount,
                                  name: current?.name ?? expense.name
                                };
                              })
                            }
                          >
                            {baseCategoryOptions.map((value) => (
                              <option key={value} value={value}>
                                {value}
                              </option>
                            ))}
                          </select>
                          {editingBaseCategory === "Materials" && (
                            <select
                              value={editingMaterialSubcategory}
                              onChange={(event) =>
                                setEditForm((current) => ({
                                  ...(current ?? {}),
                                  category: buildMaterialsCategory(event.target.value),
                                  amount: current?.amount ?? expense.amount,
                                  name: current?.name ?? expense.name
                                }))
                              }
                            >
                              <option value="">Select subcategory</option>
                              {materialOptions.map((value) => (
                                <option key={value} value={value}>
                                  {value}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      ) : (
                        <span className="expense-category-pill">
                          <ExpenseTypeIcon type={visual.type} />
                          <span>{formatExpenseCategoryDisplay(expense.category)}</span>
                        </span>
                      )}
                    </td>
                    {optionalColumns.quantity && (
                      <td>
                        {isEditing ? (
                          <input
                            type="number"
                            min={0}
                            step="0.001"
                            value={editForm?.quantity ?? 0}
                            onChange={(event) => {
                              const quantity = Number(event.target.value);
                              setEditForm((current) => ({
                                ...(current ?? {}),
                                quantity,
                                amount: computeAmount(quantity, current?.unitPrice ?? expense.unitPrice) || (current?.amount ?? expense.amount)
                              }));
                            }}
                          />
                        ) : (
                          expense.quantity > 0 ? expense.quantity.toLocaleString() : "-"
                        )}
                      </td>
                    )}
                    {optionalColumns.unit && (
                      <td>
                        {isEditing ? (
                          <select
                            value={editForm?.unit ?? ""}
                            onChange={(event) =>
                              setEditForm((current) => ({
                                ...(current ?? {}),
                                unit: event.target.value
                              }))
                            }
                          >
                            <option value="">None</option>
                            {Array.from(new Set([...(unitOptions as readonly string[]), editForm?.unit ?? ""])).map((unit) => (
                              <option key={unit || "none"} value={unit}>
                                {unit || "None"}
                              </option>
                            ))}
                          </select>
                        ) : (
                          expense.unit || "-"
                        )}
                      </td>
                    )}
                    {optionalColumns.unitCost && (
                      <td>
                        {isEditing ? (
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={editForm?.unitPrice ?? 0}
                            onChange={(event) => {
                              const unitPrice = Number(event.target.value);
                              setEditForm((current) => ({
                                ...(current ?? {}),
                                unitPrice,
                                amount: computeAmount(current?.quantity ?? expense.quantity, unitPrice) || (current?.amount ?? expense.amount)
                              }));
                            }}
                          />
                        ) : (
                          expense.unitPrice > 0 ? formatCurrency(expense.unitPrice) : "-"
                        )}
                      </td>
                    )}
                    <td>
                      {isEditing ? (
                        isVendorDrivenCategory(editingCategoryValue) ? (
                          <input
                            list="expense-vendor-options"
                            value={editForm?.vendor ?? ""}
                            placeholder="Vendor name"
                            onChange={(event) =>
                              setEditForm((current) => ({
                                ...(current ?? {}),
                                vendor: event.target.value
                              }))
                            }
                          />
                        ) : isEditingLaborExpense ? (
                          <div className="stack-sm">
                            <select
                              value={editForm?.workerRole ?? "OTHER"}
                              onChange={(event) =>
                                setEditForm((current) => ({
                                  ...(current ?? {}),
                                  workerRole: event.target.value as WorkerRole
                                }))
                              }
                            >
                              {workerRoles.map((role) => (
                                <option key={role} value={role}>
                                  {formatWorkerRole(role)}
                                </option>
                              ))}
                            </select>
                            <select
                              value={editForm?.workerProfileId ?? ""}
                              onChange={(event) => {
                                const profileId = event.target.value;
                                const selectedWorker = workers.find((worker) => worker._id === profileId);

                                setEditForm((current) => ({
                                  ...(current ?? {}),
                                  workerProfileId: profileId || undefined,
                                  workerRole: normalizeWorkerRole(selectedWorker?.role ?? current?.workerRole ?? expense.workerRole)
                                }));
                              }}
                            >
                              <option value="">None selected</option>
                              {workers.map((worker) => (
                                <option key={worker._id} value={worker._id}>
                                  {worker.name} ({formatWorkerRole(worker.role)})
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          <select
                            value={editForm?.workerRole ?? "OTHER"}
                            onChange={(event) =>
                              setEditForm((current) => ({
                                ...(current ?? {}),
                                workerRole: event.target.value as WorkerRole
                              }))
                            }
                          >
                            {workerRoles.map((role) => (
                              <option key={role} value={role}>
                                {formatWorkerRole(role)}
                              </option>
                            ))}
                          </select>
                        )
                      ) : isVendorExpense ? (
                        <span className="muted">{effectiveVendor || "-"}</span>
                      ) : (
                        <div className="expense-assignee">
                          <strong>{formatWorkerRole(expense.workerRole)}</strong>
                          <span className="muted small-text">{workerName || "-"}</span>
                        </div>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          value={editForm?.amount ?? 0}
                          onChange={(event) =>
                            setEditForm((current) => ({
                              ...(current ?? {}),
                              amount: Number(event.target.value),
                              name: current?.name ?? expense.name,
                              category: current?.category ?? expense.category
                            }))
                          }
                        />
                      ) : (
                        formatCurrency(expense.amount)
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <input
                          type="date"
                          value={editForm?.date ?? expense.date.slice(0, 10)}
                          onChange={(event) =>
                            setEditForm((current) => ({
                              ...(current ?? {}),
                              date: event.target.value,
                              amount: current?.amount ?? expense.amount,
                              name: current?.name ?? expense.name,
                              category: current?.category ?? expense.category
                            }))
                          }
                        />
                      ) : (
                        formatDate(expense.date)
                      )}
                    </td>
                    <td>
                      <div className="action-buttons">
                        {isEditing ? (
                          <>
                            <button className="btn" type="button" onClick={() => saveEdit()}>
                              Save
                            </button>
                            <button
                              className="btn ghost"
                              type="button"
                              onClick={() => {
                                setEditingId(null);
                                setEditForm(null);
                              }}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            {isMaterialExpense && (
                              <button
                                className="icon-btn view"
                                type="button"
                                title="View material invoice details"
                                aria-label={`View details for ${expense.name}`}
                                onClick={() => openTallyDetails(expense)}
                              >
                                <ViewIcon />
                              </button>
                            )}
                            <button
                              className="icon-btn edit"
                              type="button"
                              title="Edit expense"
                              aria-label={`Edit ${expense.name}`}
                              onClick={() => startEdit(expense)}
                            >
                              <EditIcon />
                            </button>
                            {canDeleteExpense && (
                              <button
                                className="icon-btn delete"
                                type="button"
                                title="Delete expense"
                                aria-label={`Delete ${expense.name}`}
                                onClick={() => setPendingDeleteExpense(expense)}
                              >
                                <DeleteIcon />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showAddWidget && (
        <div className="modal-backdrop" onClick={() => setShowAddWidget(false)}>
          <div className="expense-widget-panel panel" onClick={(event) => event.stopPropagation()}>
            <div className="expense-widget-header">
              <h3>Add Expense</h3>
              <button className="btn ghost" onClick={() => setShowAddWidget(false)}>
                Close
              </button>
            </div>

            <form className="expense-widget-grid" onSubmit={handleSubmit}>
              <label>
                Item
                <input
                  required
                  value={form.name ?? ""}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                />
              </label>

              <label>
                Category
                <select
                  required
                  value={isMaterialsCategory(form.category) ? "Materials" : (form.category ?? "")}
                  onChange={(event) => {
                    const nextCategory = event.target.value;
                    setForm((current) => ({
                      ...current,
                      category:
                        nextCategory === "Materials"
                          ? buildMaterialsCategory(materialSubcategory || getMaterialSubcategory(current.category))
                          : nextCategory
                    }));

                    if (nextCategory !== "Materials") {
                      setMaterialSubcategory("");
                    }
                  }}
                >
                  {baseCategoryOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              {isMaterialsCategory(form.category) && (
                <label>
                  Material Type
                  <select
                    value={materialSubcategory}
                    onChange={(event) => {
                      const value = event.target.value;
                      setMaterialSubcategory(value);
                      setForm((current) => ({
                        ...current,
                        category: buildMaterialsCategory(value),
                        name: current.name || value
                      }));
                    }}
                  >
                    <option value="">Select material type</option>
                    {materialOptions.map((material) => (
                      <option key={material} value={material}>
                        {material}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label>
                Unit Type
                <input
                  list="expense-unit-options"
                  value={form.unit ?? ""}
                  onChange={(event) => setForm((current) => ({ ...current, unit: event.target.value }))}
                />
                <datalist id="expense-unit-options">
                  {unitOptions.map((unit) => (
                    <option key={unit} value={unit} />
                  ))}
                </datalist>
              </label>

              <label>
                Quantity
                <input
                  type="number"
                  min={0}
                  step="0.001"
                  value={form.quantity ?? 0}
                  onChange={(event) => {
                    const quantity = Number(event.target.value);
                    setForm((current) => ({
                      ...current,
                      quantity,
                      amount: computeAmount(quantity, current.unitPrice) || current.amount
                    }));
                  }}
                />
              </label>

              <label>
                Unit Cost
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.unitPrice ?? 0}
                  onChange={(event) => {
                    const unitPrice = Number(event.target.value);
                    setForm((current) => ({
                      ...current,
                      unitPrice,
                      amount: computeAmount(current.quantity, unitPrice) || current.amount
                    }));
                  }}
                />
              </label>

              <label>
                Worker Role
                <select
                  value={form.workerRole ?? "OTHER"}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      workerRole: event.target.value as WorkerRole
                    }))
                  }
                >
                  {workerRoles.map((role) => (
                    <option key={role} value={role}>
                      {formatWorkerRole(role)}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Worker Profile
                <select
                  value={form.workerProfileId ?? ""}
                  onChange={(event) => {
                    const profileId = event.target.value;
                    const selectedWorker = workers.find((worker) => worker._id === profileId);

                    setForm((current) => ({
                      ...current,
                      workerProfileId: profileId || undefined,
                      workerRole: normalizeWorkerRole(selectedWorker?.role ?? current.workerRole)
                    }));
                  }}
                >
                  <option value="">None selected</option>
                  {workers.map((worker) => (
                    <option key={worker._id} value={worker._id}>
                      {worker.name} ({formatWorkerRole(worker.role)})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Amount
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  required
                  value={form.amount ?? 0}
                  onChange={(event) => setForm((current) => ({ ...current, amount: Number(event.target.value) }))}
                />
              </label>

              <label>
                Date
                <input
                  type="date"
                  value={form.date ?? ""}
                  onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))}
                />
              </label>

              <label>
                Vendor
                <input
                  list="expense-vendor-options"
                  value={form.vendor ?? ""}
                  onChange={(event) => setForm((current) => ({ ...current, vendor: event.target.value }))}
                />
              </label>

              <label>
                Phase
                <select value={form.phaseTaskId ?? ""} onChange={(event) => applyScopeToForm(event.target.value)}>
                  <option value="">{phaseNodes.length > 0 ? "Select phase" : "No phases yet"}</option>
                  {phaseNodes.map((phase) => (
                    <option key={phase._id} value={phase._id}>
                      {phase.title}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Section
                <select
                  value={form.sectionTaskId ?? ""}
                  onChange={(event) => applyScopeToForm(form.phaseTaskId ?? "", event.target.value)}
                  disabled={!form.phaseTaskId || formSections.length === 0}
                >
                  <option value="">{formSections.length > 0 ? "No section" : "No sections"}</option>
                  {formSections.map((section) => (
                    <option key={section._id} value={section._id}>
                      {section.title}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Notes
                <input
                  value={form.notes ?? ""}
                  onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                />
              </label>

              <button className="btn" type="submit" disabled={submitting}>
                {submitting ? "Saving..." : "Save Expense"}
              </button>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(pendingDeleteExpense)}
        title="Delete Expense?"
        message={
          pendingDeleteExpense
            ? `This will permanently remove "${pendingDeleteExpense.name}" from your expense log.`
            : ""
        }
        confirmLabel="Delete Expense"
        cancelLabel="Keep Expense"
        busy={deletingExpense}
        onCancel={() => {
          if (!deletingExpense) {
            setPendingDeleteExpense(null);
          }
        }}
        onConfirm={confirmDeleteExpense}
      />

      <datalist id="expense-vendor-options">
        {vendorOptions.map((vendorName) => (
          <option key={vendorName} value={vendorName} />
        ))}
      </datalist>

      {detailExpense && (
        <div className="modal-backdrop" onClick={() => setDetailExpense(null)}>
          <div className="expense-widget-panel panel" onClick={(event) => event.stopPropagation()}>
            <div className="expense-widget-header">
              <h3>Material Invoice Details</h3>
              <button className="btn ghost" type="button" onClick={() => setDetailExpense(null)}>
                Close
              </button>
            </div>

            <p className="muted">
              {detailData
                ? `${detailData.material}: ${detailData.expense.quantity.toLocaleString()} ${detailData.expense.unit || "units"} tracked`
                : `Loading details for ${detailExpense.name}`}
            </p>

            {detailLoading && <p className="muted">Loading invoice line details...</p>}
            {detailError && <p className="error-text">{detailError}</p>}

            {!detailLoading && !detailError && detailData && (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Paid Date</th>
                        <th>Vendor</th>
                        <th>Invoice</th>
                        <th>Description</th>
                        <th>Qty</th>
                        <th>Unit Price</th>
                        <th>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailData.lines.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="muted">
                            No paid invoice lines found for this tally yet.
                          </td>
                        </tr>
                      ) : (
                        detailData.lines.map((line, index) => (
                          <tr key={`${line.invoiceId}-${index}`}>
                            <td>{formatDate(line.paidAt)}</td>
                            <td>{line.vendor || "-"}</td>
                            <td>{line.invoiceNumber || "-"}</td>
                            <td>{line.description}</td>
                            <td>{line.quantity.toLocaleString()} {line.unit || ""}</td>
                            <td>{formatCurrency(line.unitPrice)}</td>
                            <td>{formatCurrency(line.amount)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="inline-form wrap">
                  <p className="muted">
                    Detailed invoice total: <strong>{formatCurrency(detailData.totals.amount)}</strong> ({detailData.totals.quantity.toLocaleString()}{" "}
                    {detailData.expense.unit || "units"})
                  </p>
                  {(Math.abs(detailData.unmatched.quantity) > 0.0005 || Math.abs(detailData.unmatched.amount) > 0.005) && (
                    <p className="muted">
                      Legacy/base amount not tied to listed invoice lines: {detailData.unmatched.quantity.toLocaleString()}{" "}
                      {detailData.expense.unit || "units"} / {formatCurrency(detailData.unmatched.amount)}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}





