import { useEffect, useMemo, useRef, useState } from "react";
import type { Expense, Invoice, InvoiceInput, InvoiceItem, JmdRateQuote, MaterialPreset, Task, Vendor } from "../types/models";
import { api } from "../utils/api";
import { formatCalendarDate, formatCurrency, formatDate, parseCalendarDate } from "../utils/format";
import {
  buildScopeLabel,
  getCurrentPhase,
  getCurrentSection,
  getPhaseNodes,
  getSectionsForPhase,
  getSubsectionsForSection
} from "../utils/workBreakdown";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  clearLegacyMaterialPresetStorage,
  isMaterialsCategory,
  normalizeMaterialName,
  normalizeUnitValue,
  readLegacyMaterialPresetMigrationPayload,
  resolveMaterialName,
  toPresetId
} from "../utils/materialPresets";

const invoiceCategoryOptions = [
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

const baseMaterialOptions = ["Cement", "Steel", "Lumber", "Sand", "Gravel", "Blocks", "Binding Wire"] as const;
const unitOptions = ["Bag", "Ton", "Load", "Cubic Yard", "Cubic Meter", "Block", "Kg", "Lb", "Ft", "M", "Sheet"] as const;
const invoiceStatusLabels = {
  UNPAID: "Unpaid",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid"
} as const;

type InvoiceStatusFilter = "ALL" | "UNPAID" | "PARTIALLY_PAID" | "PAID";
const invoiceStatusFilters: InvoiceStatusFilter[] = ["ALL", "UNPAID", "PARTIALLY_PAID", "PAID"];
const invoiceListCache: Partial<Record<InvoiceStatusFilter, Invoice[]>> = {};

function toMoney(value: number): number {
  return Number((Number(value ?? 0) || 0).toFixed(2));
}

function cacheInvoiceList(filter: InvoiceStatusFilter, items: Invoice[]) {
  invoiceListCache[filter] = items;
}

function readCachedInvoiceList(filter: InvoiceStatusFilter): Invoice[] | null {
  const cached = invoiceListCache[filter];
  return Array.isArray(cached) ? cached : null;
}

function clearInvoiceListCache() {
  invoiceStatusFilters.forEach((filter) => {
    delete invoiceListCache[filter];
  });
}

function parseWholeNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function buildMaterialsCategory(subcategory?: string): string {
  const normalized = (subcategory ?? "").trim();
  return normalized ? `Materials / ${normalized}` : "Materials";
}

function normalizeInvoiceCategory(category?: string): string {
  const normalized = (category ?? "").trim();
  if (normalized === "Labor Cost") {
    return "Labour Cost";
  }

  if (normalized.startsWith("Labor Cost /")) {
    return normalized.replace("Labor Cost /", "Labour Cost /").trim();
  }

  return normalized;
}

function collapsePresetHistory(
  history: Array<{ unitPrice: number; changedAt: string; previousUnitPrice?: number }>
) {
  if (history.length === 0) {
    return [];
  }

  const sorted = [...history].sort((left, right) => new Date(left.changedAt).getTime() - new Date(right.changedAt).getTime());
  const collapsed: Array<{ unitPrice: number; changedAt: string; previousUnitPrice?: number }> = [];
  const typingWindowMs = 90_000;

  for (const entry of sorted) {
    const previous = collapsed[collapsed.length - 1];
    if (!previous) {
      collapsed.push(entry);
      continue;
    }

    const previousTime = new Date(previous.changedAt).getTime();
    const currentTime = new Date(entry.changedAt).getTime();
    const isSameEditingBurst =
      Number.isFinite(previousTime) &&
      Number.isFinite(currentTime) &&
      currentTime - previousTime >= 0 &&
      currentTime - previousTime <= typingWindowMs;

    if (isSameEditingBurst) {
      collapsed[collapsed.length - 1] = {
        unitPrice: entry.unitPrice,
        changedAt: entry.changedAt,
        previousUnitPrice: previous.previousUnitPrice
      };
      continue;
    }

    collapsed.push(entry);
  }

  return collapsed;
}

function formatHistory(history: Array<{ unitPrice: number; changedAt: string; previousUnitPrice?: number }>): string {
  if (history.length === 0) {
    return "No price changes recorded yet.";
  }

  return collapsePresetHistory(history)
    .slice(-5)
    .reverse()
    .map((entry) =>
      entry.previousUnitPrice !== undefined && Number.isFinite(entry.previousUnitPrice)
        ? `${new Date(entry.changedAt).toLocaleDateString()}: $${entry.previousUnitPrice.toFixed(2)} -> $${entry.unitPrice.toFixed(2)}`
        : `${new Date(entry.changedAt).toLocaleDateString()}: $${entry.unitPrice.toFixed(2)}`
    )
    .join("\n");
}

function getInvoicePaidAmount(invoice: Invoice): number {
  if (typeof invoice.paidAmount === "number") {
    return invoice.paidAmount;
  }

  return invoice.items.reduce((sum, item) => sum + (item.paid ? item.amount : 0), 0);
}

function getInvoiceOutstandingAmount(invoice: Invoice): number {
  return Math.max(0, Number((invoice.totalAmount - getInvoicePaidAmount(invoice)).toFixed(2)));
}

function getDaysUntil(dateValue: string): number | null {
  const dueDate = parseCalendarDate(dateValue);
  if (!dueDate) {
    return null;
  }

  const today = new Date();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((dueDate.getTime() - todayDay.getTime()) / 86_400_000);
}

function getInvoiceDueTone(invoice: Invoice): "paid" | "overdue" | "soon" | "scheduled" {
  if (invoice.status === "PAID") {
    return "paid";
  }

  const daysUntilDue = getDaysUntil(invoice.dueDate);
  if (daysUntilDue === null) {
    return "scheduled";
  }

  if (daysUntilDue < 0) {
    return "overdue";
  }

  if (daysUntilDue <= 7) {
    return "soon";
  }

  return "scheduled";
}

function getInvoiceDueSummary(invoice: Invoice): string {
  if (invoice.status === "PAID") {
    return invoice.paidAt ? `Paid ${formatDate(invoice.paidAt)}` : "Settled";
  }

  const daysUntilDue = getDaysUntil(invoice.dueDate);
  if (daysUntilDue === null) {
    return "Schedule unavailable";
  }

  if (daysUntilDue < 0) {
    return `${Math.abs(daysUntilDue)} day${Math.abs(daysUntilDue) === 1 ? "" : "s"} overdue`;
  }

  if (daysUntilDue === 0) {
    return "Due today";
  }

  if (daysUntilDue <= 7) {
    return `Due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}`;
  }

  return "On schedule";
}

function normalizeInvoiceEntryCurrency(currency?: string): string {
  const normalized = (currency ?? "USD").trim().toUpperCase();
  return normalized.length === 3 ? normalized : "USD";
}

function isJmdEntryCurrency(currency?: string): boolean {
  return normalizeInvoiceEntryCurrency(currency) === "JMD";
}

function convertStoredUsdToEntryValue(value: number, entryCurrency?: string, usdToEntryRate?: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (isJmdEntryCurrency(entryCurrency)) {
    const rate = Number(usdToEntryRate ?? 0);
    return rate > 0 ? toMoney(value * rate) : toMoney(value);
  }

  return toMoney(value);
}

function convertEntryValueToStoredUsd(value: number, entryCurrency: string | undefined, quote: JmdRateQuote | null): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  if (isJmdEntryCurrency(entryCurrency)) {
    const rate = Number(quote?.rate ?? 0);
    return rate > 0 ? toMoney(value / rate) : 0;
  }

  return toMoney(value);
}

function formatInvoiceEntryCurrency(value: number, currency?: string): string {
  return formatCurrency(value, normalizeInvoiceEntryCurrency(currency));
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

function ViewIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3h4l1 2h4v2H5V5h4l1-2z" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

type InvoiceCenterProps = {
  expenses: Expense[];
  tasks: Task[];
  globalPhaseTaskId?: string;
  globalPhaseName?: string;
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
  const entryCurrency = normalizeInvoiceEntryCurrency(invoice.entryCurrency ?? invoice.currency);
  const usdToEntryRate = Number(invoice.usdToEntryRate ?? 1);

  return {
    vendor: invoice.vendor,
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate.slice(0, 10),
    dueDate: invoice.dueDate.slice(0, 10),
    phase: invoice.phase,
    phaseTaskId: invoice.phaseTaskId,
    section: invoice.section ?? "",
    sectionTaskId: invoice.sectionTaskId,
    subsection: invoice.subsection ?? "",
    subsectionTaskId: invoice.subsectionTaskId,
    currency: entryCurrency,
    notes: invoice.notes,
    items: invoice.items.map((item) => ({
      description: item.description,
      category: normalizeInvoiceCategory(item.category),
      workerRole: item.workerRole ?? "OTHER",
      quantity: item.quantity,
      unit: item.unit ?? "",
      unitPrice: convertStoredUsdToEntryValue(item.unitPrice, entryCurrency, usdToEntryRate),
      amount: convertStoredUsdToEntryValue(item.amount, entryCurrency, usdToEntryRate),
      materialLabel: item.materialLabel ?? "",
      trackToTally: Boolean(item.trackToTally),
      recordOnly: Boolean(item.recordOnly),
      paid: Boolean(item.paid),
      paidAt: item.paidAt
    }))
  };
}

export function InvoiceCenter({
  expenses,
  tasks,
  globalPhaseTaskId,
  globalPhaseName,
  canMarkPaid,
  onInvoicePaid
}: InvoiceCenterProps) {
  const phaseNodes = useMemo(() => getPhaseNodes(tasks), [tasks]);
  const currentPhase = useMemo(() => getCurrentPhase(tasks), [tasks]);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatusFilter>("ALL");
  const [invoices, setInvoices] = useState<Invoice[]>(() => readCachedInvoiceList("ALL") ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [activeInvoice, setActiveInvoice] = useState<Invoice | null>(null);
  const [invoiceDraft, setInvoiceDraft] = useState<InvoiceInput | null>(null);
  const [editingInvoice, setEditingInvoice] = useState(false);
  const [savingInvoiceEdit, setSavingInvoiceEdit] = useState(false);
  const [payingInvoice, setPayingInvoice] = useState(false);
  const [deletingInvoice, setDeletingInvoice] = useState(false);
  const [selectedPayIndexes, setSelectedPayIndexes] = useState<number[]>([]);
  const [confirmPayInvoice, setConfirmPayInvoice] = useState(false);
  const [deleteInvoiceTarget, setDeleteInvoiceTarget] = useState<Invoice | null>(null);
  const [showCreateInvoice, setShowCreateInvoice] = useState(false);
  const [showVendorManager, setShowVendorManager] = useState(false);
  const [showPresetManager, setShowPresetManager] = useState(false);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [newVendorName, setNewVendorName] = useState("");
  const [materialPresets, setMaterialPresets] = useState<MaterialPreset[]>([]);
  const [presetPriceDrafts, setPresetPriceDrafts] = useState<Record<string, string>>({});
  const [presetUnitDrafts, setPresetUnitDrafts] = useState<Record<string, string>>({});
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetUnit, setNewPresetUnit] = useState("");
  const [newPresetPrice, setNewPresetPrice] = useState(0);
  const [nextInvoiceNumberPreview, setNextInvoiceNumberPreview] = useState("");
  const [loadingNextInvoiceNumber, setLoadingNextInvoiceNumber] = useState(false);
  const [formFxQuote, setFormFxQuote] = useState<JmdRateQuote | null>(null);
  const [loadingFormFxQuote, setLoadingFormFxQuote] = useState(false);
  const [formFxError, setFormFxError] = useState("");
  const [draftFxQuote, setDraftFxQuote] = useState<JmdRateQuote | null>(null);
  const [loadingDraftFxQuote, setLoadingDraftFxQuote] = useState(false);
  const [draftFxError, setDraftFxError] = useState("");
  const invoiceRefreshRequestRef = useRef(0);
  const materialPresetMigrationDoneRef = useRef(false);
  const [form, setForm] = useState<InvoiceInput>({
    vendor: "",
    invoiceNumber: "",
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date().toISOString().slice(0, 10),
    phase: "",
    phaseTaskId: "",
    section: "",
    sectionTaskId: "",
    subsection: "",
    subsectionTaskId: "",
    currency: "USD",
    notes: "",
    items: [createEmptyItem()]
  });
  const draftSections = useMemo(() => getSectionsForPhase(tasks, invoiceDraft?.phaseTaskId), [tasks, invoiceDraft?.phaseTaskId]);
  const draftSubsections = useMemo(() => getSubsectionsForSection(tasks, invoiceDraft?.sectionTaskId), [tasks, invoiceDraft?.sectionTaskId]);

  const materialOptions = useMemo(() => {
    return Array.from(new Set([...baseMaterialOptions, ...materialPresets.map((preset) => preset.name)])).sort();
  }, [materialPresets]);

  const formEntryCurrency = normalizeInvoiceEntryCurrency(form.currency);
  const draftEntryCurrency = normalizeInvoiceEntryCurrency(invoiceDraft?.currency);
  const formShowsJmdEntry = isJmdEntryCurrency(form.currency);
  const draftShowsJmdEntry = isJmdEntryCurrency(invoiceDraft?.currency);

  async function refresh(filter: InvoiceStatusFilter = statusFilter) {
    const requestId = invoiceRefreshRequestRef.current + 1;
    invoiceRefreshRequestRef.current = requestId;

    try {
      setError("");
      const response = await api.getInvoices(filter);
      cacheInvoiceList(filter, response.invoices);
      if (invoiceRefreshRequestRef.current === requestId && filter === statusFilter) {
        setInvoices(response.invoices);
      }
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

  async function refreshMaterialPresets() {
    try {
      setError("");

      if (!materialPresetMigrationDoneRef.current) {
        const legacy = readLegacyMaterialPresetMigrationPayload();
        materialPresetMigrationDoneRef.current = true;

        if (legacy.hasLegacyData) {
          const migrated = await api.migrateMaterialPresets({
            presets: legacy.presets,
            removedPresetIds: legacy.removedPresetIds
          });
          setMaterialPresets(migrated.presets);
          clearLegacyMaterialPresetStorage();
          return;
        }
      }

      const response = await api.getMaterialPresets();
      setMaterialPresets(response.presets);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load material presets");
    }
  }

  useEffect(() => {
    const cached = readCachedInvoiceList(statusFilter);
    if (cached) {
      setInvoices(cached);
    }

    refresh(statusFilter).catch(() => {
      // Handled in refresh.
    });
  }, [statusFilter]);

  useEffect(() => {
    refreshVendors().catch(() => {
      // Handled in refreshVendors.
    });
    refreshMaterialPresets().catch(() => {
      // Handled in refreshMaterialPresets.
    });
  }, []);

  useEffect(() => {
    if (!showPresetManager) {
      return;
    }

    setPresetUnitDrafts(
      Object.fromEntries(
        materialPresets.map((preset) => [preset.id, preset.unit ?? ""])
      )
    );
    setPresetPriceDrafts(
      Object.fromEntries(
        materialPresets.map((preset) => [preset.id, String(Number.isFinite(preset.unitPrice) ? preset.unitPrice : 0)])
      )
    );
  }, [showPresetManager]);

  useEffect(() => {
    if (!showCreateInvoice) {
      return;
    }

    let cancelled = false;
    setLoadingNextInvoiceNumber(true);

    api
      .getNextInvoiceNumber()
      .then((response) => {
        if (!cancelled) {
          setNextInvoiceNumberPreview(response.invoiceNumber);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNextInvoiceNumberPreview("");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingNextInvoiceNumber(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [showCreateInvoice]);

  useEffect(() => {
    if (!showCreateInvoice || !formShowsJmdEntry) {
      setFormFxQuote(null);
      setFormFxError("");
      setLoadingFormFxQuote(false);
      return;
    }

    let cancelled = false;
    setLoadingFormFxQuote(true);
    setFormFxError("");

    api
      .getProjectFxRate("USD", form.issueDate)
      .then((response) => {
        if (!cancelled) {
          setFormFxQuote(response.quote);
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setFormFxQuote(null);
          setFormFxError(requestError instanceof Error ? requestError.message : "Could not load JMD exchange rate");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingFormFxQuote(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [form.issueDate, formShowsJmdEntry, showCreateInvoice]);

  useEffect(() => {
    if (!editingInvoice || !invoiceDraft || !draftShowsJmdEntry) {
      setDraftFxQuote(null);
      setDraftFxError("");
      setLoadingDraftFxQuote(false);
      return;
    }

    let cancelled = false;
    setLoadingDraftFxQuote(true);
    setDraftFxError("");

    api
      .getProjectFxRate("USD", invoiceDraft.issueDate)
      .then((response) => {
        if (!cancelled) {
          setDraftFxQuote(response.quote);
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setDraftFxQuote(null);
          setDraftFxError(requestError instanceof Error ? requestError.message : "Could not load JMD exchange rate");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDraftFxQuote(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [draftShowsJmdEntry, editingInvoice, invoiceDraft]);

  useEffect(() => {
    refreshMaterialPresets().catch(() => {
      // Handled in refreshMaterialPresets.
    });
  }, [expenses]);

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

  useEffect(() => {
    if (!phaseNodes.length) {
      return;
    }

    setForm((current) => {
      if (current.phaseTaskId && (!globalPhaseTaskId || current.phaseTaskId === globalPhaseTaskId)) {
        return current;
      }

      const nextPhase = phaseNodes.find((phase) => phase._id === globalPhaseTaskId) ?? currentPhase ?? phaseNodes[0];
      if (!nextPhase) {
        return current;
      }

      const nextSection = getCurrentSection(tasks, nextPhase._id) ?? getSectionsForPhase(tasks, nextPhase._id)[0];
      const nextSubsection = getSubsectionsForSection(tasks, nextSection?._id)[0];
      return {
        ...current,
        phase: globalPhaseName || nextPhase.title,
        phaseTaskId: nextPhase._id,
        section: nextSection?.title ?? "",
        sectionTaskId: nextSection?._id ?? "",
        subsection: nextSubsection?.title ?? "",
        subsectionTaskId: nextSubsection?._id ?? ""
      };
    });
  }, [currentPhase, globalPhaseName, globalPhaseTaskId, phaseNodes, tasks]);

  function findPhaseIdByName(phaseName?: string): string {
    return phaseNodes.find((phase) => phase.title === (phaseName ?? "").trim())?._id ?? "";
  }

  function findSectionIdByName(phaseId?: string, sectionName?: string): string {
    return getSectionsForPhase(tasks, phaseId).find((section) => section.title === (sectionName ?? "").trim())?._id ?? "";
  }

  function findSubsectionIdByName(sectionId?: string, subsectionName?: string): string {
    return getSubsectionsForSection(tasks, sectionId).find((task) => task.title === (subsectionName ?? "").trim())?._id ?? "";
  }

  function applyScopeToDraft(phaseId: string, sectionId?: string, subsectionId?: string) {
    const phaseNode = phaseNodes.find((phase) => phase._id === phaseId);
    const sectionNode = getSectionsForPhase(tasks, phaseId).find((section) => section._id === sectionId);
    const subsectionNode = getSubsectionsForSection(tasks, sectionNode?._id).find((task) => task._id === subsectionId);

    setInvoiceDraft((current) =>
      current
        ? {
            ...current,
            phase: globalPhaseName || phaseNode?.title || "",
            phaseTaskId: phaseNode?._id ?? "",
            section: sectionNode?.title ?? "",
            sectionTaskId: sectionNode?._id ?? "",
            subsection: subsectionNode?.title ?? "",
            subsectionTaskId: subsectionNode?._id ?? ""
          }
        : current
    );
  }

  async function updatePreset(id: string, patch: { unit?: string; unitPrice?: number }) {
    try {
      setError("");
      const response = await api.updateMaterialPreset(id, patch);
      setMaterialPresets((current) =>
        current.map((preset) => (preset.id === id ? response.preset : preset))
      );
      setPresetUnitDrafts((current) => ({
        ...current,
        [id]: response.preset.unit ?? ""
      }));
      setPresetPriceDrafts((current) => ({
        ...current,
        [id]: String(response.preset.unitPrice)
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to update material preset");
    }
  }

  async function syncPresetPricesFromInvoice(sourceItems: InvoiceItem[], savedInvoice: Invoice) {
    try {
      const filteredSourceItems = sourceItems.filter((item) => item.description.trim().length > 0);
      const updates = new Map<string, number>();

      filteredSourceItems.forEach((item, index) => {
        if (!isMaterialsCategory(item.category)) {
          return;
        }

        const materialName = normalizeMaterialName(item.materialLabel || resolveMaterialName(item.description, item.category));
        if (!materialName) {
          return;
        }

        const matchedPreset = materialPresets.find((preset) => preset.name.toLowerCase() === materialName.toLowerCase());
        const savedItem = savedInvoice.items[index];
        if (!matchedPreset || !savedItem || !Number.isFinite(savedItem.unitPrice)) {
          return;
        }

        updates.set(matchedPreset.id, Number(savedItem.unitPrice));
      });

      if (updates.size === 0) {
        return;
      }

      await Promise.all(
        Array.from(updates.entries()).map(([presetId, unitPrice]) => api.updateMaterialPreset(presetId, { unitPrice }))
      );
      await refreshMaterialPresets();
    } catch (requestError) {
      setError(requestError instanceof Error ? `Invoice saved, but material presets could not sync: ${requestError.message}` : "Invoice saved, but material presets could not sync");
    }
  }

  async function commitPresetUnit(id: string) {
    const preset = materialPresets.find((entry) => entry.id === id);
    if (!preset) {
      return;
    }

    const rawValue = presetUnitDrafts[id] ?? preset.unit ?? "";
    const nextUnit = normalizeUnitValue(rawValue);
    if (nextUnit === (preset.unit ?? "")) {
      return;
    }

    await updatePreset(id, { unit: nextUnit });
  }

  async function commitPresetPrice(id: string) {
    const preset = materialPresets.find((entry) => entry.id === id);
    if (!preset) {
      return;
    }

    const rawValue = presetPriceDrafts[id] ?? String(preset.unitPrice ?? 0);
    const trimmedValue = rawValue.trim();
    const parsedValue = trimmedValue.length === 0 ? 0 : Number(trimmedValue);
    const nextUnitPrice = Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : preset.unitPrice;

    if (nextUnitPrice === preset.unitPrice) {
      setPresetPriceDrafts((current) => ({
        ...current,
        [id]: String(nextUnitPrice)
      }));
      return;
    }

    await updatePreset(id, { unitPrice: nextUnitPrice });
    setPresetPriceDrafts((current) => ({
      ...current,
      [id]: String(nextUnitPrice)
    }));
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

  async function addPreset() {
    const name = normalizeMaterialName(newPresetName);
    if (!name) {
      return;
    }

    const id = toPresetId(name);
    if (materialPresets.some((preset) => preset.id === id)) {
      setError("That material preset already exists.");
      return;
    }

    try {
      setError("");
      const response = await api.createMaterialPreset({
        name,
        unit: normalizeUnitValue(newPresetUnit),
        unitPrice: Number(newPresetPrice || 0)
      });
      setMaterialPresets((current) => [...current, response.preset].sort((a, b) => a.name.localeCompare(b.name)));
      setNewPresetName("");
      setNewPresetUnit("");
      setNewPresetPrice(0);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to add material preset");
    }
  }

  async function removePreset(id: string) {
    try {
      setError("");
      await api.deleteMaterialPreset(id);
      setMaterialPresets((current) => current.filter((preset) => preset.id !== id));
      setPresetUnitDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setPresetPriceDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to remove material preset");
    }
  }

  function updateItem(index: number, patch: Partial<InvoiceItem>) {
    setForm((current) => {
      const items = [...current.items];
      const next = { ...items[index], ...patch };
      const entryCurrency = normalizeInvoiceEntryCurrency(current.currency);

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
            next.unitPrice = convertStoredUsdToEntryValue(
              matchingPreset.unitPrice,
              entryCurrency,
              formFxQuote?.rate
            );
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

  const invoiceSummary = useMemo(() => {
    const totalInvoiced = invoices.reduce((sum, invoice) => sum + invoice.totalAmount, 0);
    const outstandingBalance = invoices.reduce((sum, invoice) => sum + getInvoiceOutstandingAmount(invoice), 0);
    const unpaidCount = invoices.filter((invoice) => invoice.status === "UNPAID").length;
    const partialCount = invoices.filter((invoice) => invoice.status === "PARTIALLY_PAID").length;
    const paidCount = invoices.filter((invoice) => invoice.status === "PAID").length;
    const overdueCount = invoices.filter((invoice) => getInvoiceDueTone(invoice) === "overdue").length;
    const dueSoonCount = invoices.filter((invoice) => getInvoiceDueTone(invoice) === "soon").length;

    return {
      totalInvoiced,
      outstandingBalance,
      unpaidCount,
      partialCount,
      paidCount,
      overdueCount,
      dueSoonCount
    };
  }, [invoices]);

  async function handleCreateInvoice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setActionMessage("");

    try {
      const submittedItems = form.items.filter((item) => item.description.trim().length > 0);
      const result = await api.createInvoice({
        ...form,
        items: submittedItems
      });
      if (isJmdEntryCurrency(form.currency)) {
        await syncPresetPricesFromInvoice(submittedItems, result.invoice);
      }

      const nextPhase = phaseNodes.find((phase) => phase._id === globalPhaseTaskId) ?? currentPhase ?? phaseNodes[0];
      const nextSection = nextPhase ? getCurrentSection(tasks, nextPhase._id) ?? getSectionsForPhase(tasks, nextPhase._id)[0] : undefined;
      const nextSubsection = getSubsectionsForSection(tasks, nextSection?._id)[0];
      setForm({
        vendor: vendors.length === 1 ? vendors[0].name : "",
        invoiceNumber: "",
        issueDate: new Date().toISOString().slice(0, 10),
        dueDate: new Date().toISOString().slice(0, 10),
        phase: globalPhaseName || nextPhase?.title || "",
        phaseTaskId: nextPhase?._id ?? "",
        section: nextSection?.title ?? "",
        sectionTaskId: nextSection?._id ?? "",
        subsection: nextSubsection?.title ?? "",
        subsectionTaskId: nextSubsection?._id ?? "",
        currency: "USD",
        notes: "",
        items: [createEmptyItem()]
      });

      clearInvoiceListCache();
      await refresh();
      setShowCreateInvoice(false);
      setActionMessage(`Invoice ${result.invoice.invoiceNumber} created.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to create invoice");
    } finally {
      setSaving(false);
    }
  }

  function openInvoice(invoice: Invoice) {
    setActiveInvoice(invoice);
    const phaseTaskId = globalPhaseTaskId ?? invoice.phaseTaskId ?? findPhaseIdByName(invoice.phase);
    const sectionTaskId = invoice.sectionTaskId ?? findSectionIdByName(phaseTaskId, invoice.section);
    const subsectionTaskId = invoice.subsectionTaskId ?? findSubsectionIdByName(sectionTaskId, invoice.subsection);
    setInvoiceDraft({
      ...toInvoiceInput(invoice),
      phase: globalPhaseName || invoice.phase,
      phaseTaskId,
      sectionTaskId,
      subsectionTaskId
    });
    setEditingInvoice(false);
    setSelectedPayIndexes([]);
    setConfirmPayInvoice(false);
  }

  function updateInvoiceDraftItem(index: number, patch: Partial<InvoiceItem>) {
    setInvoiceDraft((current) => {
      if (!current) {
        return current;
      }

      const items = [...current.items];
      const next = { ...items[index], ...patch };
      const entryCurrency = normalizeInvoiceEntryCurrency(current.currency);

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
            next.unitPrice = convertStoredUsdToEntryValue(
              matchingPreset.unitPrice,
              entryCurrency,
              draftFxQuote?.rate
            );
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
      const submittedItems = invoiceDraft.items.filter((item) => item.description.trim().length > 0);
      const result = await api.updateInvoice(activeInvoice._id, {
        ...invoiceDraft,
        items: submittedItems
      });
      if (isJmdEntryCurrency(invoiceDraft.currency)) {
        await syncPresetPricesFromInvoice(submittedItems, result.invoice);
      }

      clearInvoiceListCache();
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
      setPayingInvoice(true);
      const scopeSource = activeInvoice ?? invoices.find((invoice) => invoice._id === invoiceId);
      const result = await api.markInvoicePaid(invoiceId, {
        phase: globalPhaseName || scopeSource?.phase,
        phaseTaskId: globalPhaseTaskId || scopeSource?.phaseTaskId,
        section: scopeSource?.section,
        sectionTaskId: scopeSource?.sectionTaskId,
        subsection: scopeSource?.subsection,
        subsectionTaskId: scopeSource?.subsectionTaskId,
        itemIndexes
      });
      clearInvoiceListCache();
      await refresh();
      await onInvoicePaid();
      setActionMessage(
        `Marked paid. ${result.createdExpenses} new expense row(s), ${result.mergedTallies ?? 0} material tally update(s), ${result.ignoredItems ?? 0} journal-only line(s) marked paid without affecting totals.`
      );
      setActiveInvoice(result.invoice);
      setInvoiceDraft(toInvoiceInput(result.invoice));
      setEditingInvoice(false);
      setSelectedPayIndexes([]);
      setConfirmPayInvoice(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to mark invoice paid");
    } finally {
      setPayingInvoice(false);
    }
  }

  async function confirmDeleteInvoice() {
    if (!deleteInvoiceTarget) {
      return;
    }

    setDeletingInvoice(true);
    setError("");

    try {
      const removedInvoiceNumber = deleteInvoiceTarget.invoiceNumber;
      const removedInvoiceId = deleteInvoiceTarget._id;
      await api.deleteInvoice(removedInvoiceId);
      clearInvoiceListCache();
      await refresh();
      await onInvoicePaid();

      if (activeInvoice?._id === removedInvoiceId) {
        setActiveInvoice(null);
        setInvoiceDraft(null);
        setEditingInvoice(false);
        setSelectedPayIndexes([]);
        setConfirmPayInvoice(false);
      }

      setDeleteInvoiceTarget(null);
      setActionMessage(`Deleted invoice ${removedInvoiceNumber}.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to delete invoice");
    } finally {
      setDeletingInvoice(false);
    }
  }

  return (
    <section className="stack-lg">
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
                  value={loadingNextInvoiceNumber ? "Generating..." : nextInvoiceNumberPreview || "Auto-generated on save"}
                  readOnly
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
                <select
                  value={form.currency}
                  onChange={(event) => setForm((prev) => ({ ...prev, currency: normalizeInvoiceEntryCurrency(event.target.value) }))}
                >
                  <option value="USD">USD</option>
                  <option value="JMD">JMD</option>
                </select>
                {formShowsJmdEntry && (
                  <span className={`invoice-fx-note${formFxError ? " error" : ""}`}>
                    {loadingFormFxQuote
                      ? "Loading JMD rate for the issue date..."
                      : formFxQuote
                        ? `Enter JMD below. Saved in USD at 1 USD = ${formatCurrency(formFxQuote.rate, "JMD")} on ${formatCalendarDate(formFxQuote.rateDate)}.`
                        : formFxError || "Could not load the JMD rate for this date."}
                  </span>
                )}
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
                    <th>{formShowsJmdEntry ? "Unit Price (JMD)" : "Unit Price"}</th>
                    <th>{formShowsJmdEntry ? "Amount (JMD)" : "Amount"}</th>
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
                    const convertedUnitPrice = convertEntryValueToStoredUsd(item.unitPrice, form.currency, formFxQuote);
                    const convertedAmount = convertEntryValueToStoredUsd(item.amount, form.currency, formFxQuote);

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
                            value={isMaterialsCategory(item.category) ? "Materials" : normalizeInvoiceCategory(item.category)}
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
                          <div className="invoice-money-input">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              value={item.unitPrice}
                              disabled={isPresetMaterial && !formShowsJmdEntry}
                              title={
                                isPresetMaterial
                                  ? formShowsJmdEntry
                                    ? "Enter the JMD material price. The matching preset will be updated in USD when you save the invoice."
                                    : "Price comes from the selected material preset. Edit it in the Material Presets toolbar tool."
                                  : undefined
                              }
                              onChange={(event) => updateItem(index, { unitPrice: Number(event.target.value) })}
                            />
                            {formShowsJmdEntry && convertedUnitPrice > 0 && (
                              <span className="invoice-currency-preview">{formatCurrency(convertedUnitPrice, "USD")}</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="invoice-money-stack">
                            <strong>{formatInvoiceEntryCurrency(item.amount, formEntryCurrency)}</strong>
                            {formShowsJmdEntry && convertedAmount > 0 && (
                              <span className="invoice-currency-preview">{formatCurrency(convertedAmount, "USD")}</span>
                            )}
                          </div>
                        </td>
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
              <div className="invoice-total-stack">
                <strong>{formatInvoiceEntryCurrency(invoiceTotal, formEntryCurrency)}</strong>
                {formShowsJmdEntry && formFxQuote && (
                  <span className="invoice-currency-preview">
                    {formatCurrency(convertEntryValueToStoredUsd(invoiceTotal, form.currency, formFxQuote), "USD")}
                  </span>
                )}
              </div>
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
                          value={presetUnitDrafts[preset.id] ?? preset.unit}
                          onChange={(event) =>
                            setPresetUnitDrafts((current) => ({
                              ...current,
                              [preset.id]: event.target.value
                            }))
                          }
                          onBlur={() => {
                            void commitPresetUnit(preset.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void commitPresetUnit(preset.id);
                              event.currentTarget.blur();
                            }
                          }}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={presetPriceDrafts[preset.id] ?? String(preset.unitPrice)}
                          onChange={(event) =>
                            setPresetPriceDrafts((current) => ({
                              ...current,
                              [preset.id]: event.target.value
                            }))
                          }
                          onBlur={() => {
                            void commitPresetPrice(preset.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void commitPresetPrice(preset.id);
                              event.currentTarget.blur();
                            }
                          }}
                        />
                      </td>
                      <td>
                        <span className="info-icon" title={formatHistory(preset.priceHistory)} aria-label={`Price history for ${preset.name}`}>
                          i
                        </span>
                      </td>
                      <td>
                        <button className="btn ghost" type="button" onClick={() => void removePreset(preset.id)}>
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
                <button className="btn" type="button" onClick={() => void addPreset()}>
                  Add Preset
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <header className="invoice-hero panel">
        <div className="invoice-hero-copy">
          <h1>Invoice Center</h1>
          <p className="muted">
            Track due balances, spot overdue vendors early, and open invoices for payment actions from one place.
          </p>
          <div className="invoice-hero-actions">
            <button className="btn" type="button" onClick={() => setShowCreateInvoice(true)}>
              Add Invoice
            </button>
          </div>
        </div>

        <div className="invoice-hero-stats">
          <article className="invoice-stat-card">
            <span className="invoice-stat-label">Invoices in view</span>
            <strong>{invoices.length}</strong>
            <span className="invoice-stat-meta">
              {invoiceSummary.paidCount} paid, {invoiceSummary.unpaidCount + invoiceSummary.partialCount} still active
            </span>
          </article>
          <article className="invoice-stat-card invoice-stat-card-accent">
            <span className="invoice-stat-label">Outstanding balance</span>
            <strong>{formatCurrency(invoiceSummary.outstandingBalance)}</strong>
            <span className="invoice-stat-meta">Across {invoiceSummary.unpaidCount + invoiceSummary.partialCount} open invoices</span>
          </article>
          <article className="invoice-stat-card">
            <span className="invoice-stat-label">Attention needed</span>
            <strong>{invoiceSummary.overdueCount + invoiceSummary.dueSoonCount}</strong>
            <span className="invoice-stat-meta">
              {invoiceSummary.overdueCount} overdue, {invoiceSummary.dueSoonCount} due within 7 days
            </span>
          </article>
          <article className="invoice-stat-card">
            <span className="invoice-stat-label">Invoice value</span>
            <strong>{formatCurrency(invoiceSummary.totalInvoiced)}</strong>
            <span className="invoice-stat-meta">Current filtered pipeline</span>
          </article>
        </div>
      </header>

      <div className="panel stack-sm invoice-table-panel">
        <div className="invoice-table-header row-between wrap">
          <div className="invoice-section-copy">
            <h3>Invoice register</h3>
            <p className="muted small-text">Open any invoice for line-level details, editing, and selective payment handling.</p>
          </div>
          <div className="invoice-toolbar">
            <label className="invoice-filter-control">
              <span>View</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "ALL" | "UNPAID" | "PARTIALLY_PAID" | "PAID")}>
                <option value="ALL">All invoices</option>
                <option value="UNPAID">Only unpaid invoices</option>
                <option value="PARTIALLY_PAID">Partially paid invoices</option>
                <option value="PAID">Only paid invoices</option>
              </select>
            </label>
            <button className="tool-btn" type="button" onClick={() => setShowVendorManager(true)}>
              <VendorIcon />
              <span>Manage Vendors</span>
            </button>
            <button className="tool-btn" type="button" onClick={() => setShowPresetManager(true)}>
              <MaterialIcon />
              <span>Material Presets</span>
            </button>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="table-wrap invoice-list-wrap">
          <table className="invoice-list-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Vendor</th>
                <th>Status</th>
                <th>Due</th>
                <th>Amount</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td className="muted invoice-empty-cell" colSpan={6}>
                    No invoices match this view yet. Create one to start tracking vendor billing.
                  </td>
                </tr>
              ) : (
                invoices.map((invoice) => {
                  const dueTone = getInvoiceDueTone(invoice);

                  return (
                    <tr key={invoice._id} className={`invoice-row invoice-row-${dueTone}`}>
                      <td>{invoice.invoiceNumber}</td>
                      <td>{invoice.vendor}</td>
                      <td>
                        <span className={`status-badge status-${invoice.status.toLowerCase()}`}>{invoiceStatusLabels[invoice.status]}</span>
                      </td>
                      <td>
                        <span className={`invoice-due-pill invoice-due-pill-${dueTone}`}>{formatCalendarDate(invoice.dueDate)}</span>
                      </td>
                      <td>{formatCurrency(invoice.totalAmount)}</td>
                      <td>
                        <div className="invoice-actions">
                          <button className="tool-btn invoice-view-btn" type="button" onClick={() => openInvoice(invoice)} title="Open invoice" aria-label={`Open invoice ${invoice.invoiceNumber}`}>
                            <ViewIcon />
                            <span>View Invoice</span>
                          </button>
                          {canMarkPaid && invoice.status === "UNPAID" && (
                            <button
                              className="tool-btn invoice-delete-btn"
                              type="button"
                              onClick={() => setDeleteInvoiceTarget(invoice)}
                              title="Delete invoice"
                              aria-label={`Delete invoice ${invoice.invoiceNumber}`}
                              disabled={deletingInvoice}
                            >
                              <DeleteIcon />
                              <span>Delete</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
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
            setConfirmPayInvoice(false);
            setDeleteInvoiceTarget(null);
          }}
        >
          <div className="expense-widget-panel invoice-detail-modal panel" onClick={(event) => event.stopPropagation()}>
            <div className="expense-widget-header">
              <h3>Invoice {activeInvoice.invoiceNumber}</h3>
              <div className="inline-form wrap">
                {!editingInvoice && activeInvoice.status !== "PAID" && (
                  <button className="btn ghost" type="button" onClick={() => setEditingInvoice(true)}>
                    Edit Invoice
                  </button>
                )}
                {!editingInvoice && canMarkPaid && activeInvoice.status === "UNPAID" && (
                  <button
                    className="btn ghost invoice-delete-inline-btn"
                    type="button"
                    onClick={() => setDeleteInvoiceTarget(activeInvoice)}
                    disabled={deletingInvoice}
                  >
                    Delete Invoice
                  </button>
                )}
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    setActiveInvoice(null);
                    setEditingInvoice(false);
                    setSelectedPayIndexes([]);
                    setConfirmPayInvoice(false);
                    setDeleteInvoiceTarget(null);
                  }}
                >
                  Close
                </button>
              </div>
            </div>

            {editingInvoice && invoiceDraft ? (
              <div className="form-grid">
                <div className="readonly-field">
                  <span className="readonly-field-label">Vendor</span>
                  <strong>{invoiceDraft.vendor}</strong>
                </div>
                <div className="readonly-field">
                  <span className="readonly-field-label">Invoice Number</span>
                  <strong>{invoiceDraft.invoiceNumber}</strong>
                </div>
                <div className="readonly-field">
                  <span className="readonly-field-label">Issue Date</span>
                  <strong>{formatDate(invoiceDraft.issueDate)}</strong>
                </div>
                <div className="readonly-field">
                  <span className="readonly-field-label">Due Date</span>
                  <strong>{formatCalendarDate(invoiceDraft.dueDate)}</strong>
                </div>
                <div className="readonly-field">
                  <span className="readonly-field-label">Currency</span>
                  <strong>{draftEntryCurrency}</strong>
                  {draftShowsJmdEntry && (
                    <span className={`invoice-fx-note${draftFxError ? " error" : ""}`}>
                      {loadingDraftFxQuote
                        ? "Loading JMD rate for this invoice..."
                        : draftFxQuote
                          ? `Stored in USD at 1 USD = ${formatCurrency(draftFxQuote.rate, "JMD")} on ${formatCalendarDate(draftFxQuote.rateDate)}.`
                          : draftFxError || "Could not load the JMD rate for this invoice."}
                    </span>
                  )}
                </div>
                <label>
                  Phase
                  <input value={globalPhaseName || invoiceDraft.phase || ""} disabled />
                </label>
                <label>
                  Section
                  <select
                    value={invoiceDraft.sectionTaskId ?? ""}
                    onChange={(event) => applyScopeToDraft(invoiceDraft.phaseTaskId ?? globalPhaseTaskId ?? "", event.target.value)}
                    disabled={!invoiceDraft.phaseTaskId || draftSections.length === 0}
                  >
                    <option value="">{draftSections.length > 0 ? "No section" : "No sections"}</option>
                    {draftSections.map((section) => (
                      <option key={section._id} value={section._id}>
                        {section.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Subsection
                  <select
                    value={invoiceDraft.subsectionTaskId ?? ""}
                    onChange={(event) =>
                      applyScopeToDraft(
                        invoiceDraft.phaseTaskId ?? globalPhaseTaskId ?? "",
                        invoiceDraft.sectionTaskId ?? "",
                        event.target.value
                      )
                    }
                    disabled={!invoiceDraft.sectionTaskId || draftSubsections.length === 0}
                  >
                    <option value="">{draftSubsections.length > 0 ? "No subsection" : "No subsections"}</option>
                    {draftSubsections.map((subsection) => (
                      <option key={subsection._id} value={subsection._id}>
                        {subsection.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Notes
                  <input value={invoiceDraft.notes ?? ""} onChange={(event) => setInvoiceDraft((current) => current ? { ...current, notes: event.target.value } : current)} />
                </label>
              </div>
            ) : (
              <p className="muted">
                Vendor: {activeInvoice.vendor} | Scope: {buildScopeLabel(activeInvoice.phase, activeInvoice.section, activeInvoice.subsection)} | Status: {activeInvoice.status} | Due: {formatCalendarDate(activeInvoice.dueDate)} | Total: {formatCurrency(activeInvoice.totalAmount)}
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
                    <th>{editingInvoice && draftShowsJmdEntry ? "Unit Price (JMD)" : "Unit Price"}</th>
                    <th>{editingInvoice && draftShowsJmdEntry ? "Total (JMD)" : editingInvoice ? "Total" : "Amount"}</th>
                    {editingInvoice && <th>Journal Only</th>}
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
                    const isSelectable = !isLinePaid;
                    const rowMaterialName = resolveMaterialName(item.description, item.category).toLowerCase();
                    const matchedPreset = materialPresets.find((preset) => preset.name.toLowerCase() === rowMaterialName);
                    const isPresetMaterial = Boolean(matchedPreset) && isMaterialCategory;
                    const isLockedPaidRow = editingInvoice && isLinePaid;
                    const convertedUnitPrice = convertEntryValueToStoredUsd(item.unitPrice, invoiceDraft?.currency, draftFxQuote);
                    const convertedAmount = convertEntryValueToStoredUsd(item.amount, invoiceDraft?.currency, draftFxQuote);

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
                            <input disabled={isLockedPaidRow} value={item.description} onChange={(event) => updateInvoiceDraftItem(index, { description: event.target.value })} />
                          ) : (
                            item.description
                          )}
                        </td>

                        <td>
                          {editingInvoice ? (
                            <select
                              disabled={isLockedPaidRow}
                              value={isMaterialsCategory(item.category) ? "Materials" : normalizeInvoiceCategory(item.category)}
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
                            normalizeInvoiceCategory(item.category)
                          )}
                        </td>

                        <td>
                          {isMaterialCategory ? (
                            editingInvoice ? (
                              <select
                                disabled={isLockedPaidRow}
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
                            <input disabled={isLockedPaidRow} type="number" min={0} step="1" value={item.quantity} onChange={(event) => updateInvoiceDraftItem(index, { quantity: parseWholeNumber(event.target.value) })} />
                          ) : (
                            item.quantity.toLocaleString()
                          )}
                        </td>

                        <td>
                          {editingInvoice ? (
                            <div className="invoice-money-input">
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={item.unitPrice}
                                disabled={(isPresetMaterial && !draftShowsJmdEntry) || isLockedPaidRow}
                                title={
                                  isLockedPaidRow
                                    ? "Paid rows are locked."
                                    : isPresetMaterial
                                      ? draftShowsJmdEntry
                                        ? "Enter the JMD material price. The matching preset will be updated in USD when you save the invoice."
                                        : "Price comes from the selected material preset."
                                      : undefined
                                }
                                onChange={(event) => updateInvoiceDraftItem(index, { unitPrice: Number(event.target.value) })}
                              />
                              {draftShowsJmdEntry && convertedUnitPrice > 0 && (
                                <span className="invoice-currency-preview">{formatCurrency(convertedUnitPrice, "USD")}</span>
                              )}
                            </div>
                          ) : (
                            formatCurrency(item.unitPrice)
                          )}
                        </td>

                        <td>
                          {editingInvoice ? (
                            <div className="invoice-money-input">
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={item.amount}
                                disabled={(isPresetMaterial && !draftShowsJmdEntry) || isLockedPaidRow}
                                title={
                                  isLockedPaidRow
                                    ? "Paid rows are locked."
                                    : isPresetMaterial && !draftShowsJmdEntry
                                      ? "Amount is locked to the selected material preset pricing."
                                      : undefined
                                }
                                onChange={(event) => {
                                  const nextAmount = Number(event.target.value);
                                  updateInvoiceDraftItem(index, {
                                    amount: nextAmount,
                                    unitPrice: item.quantity > 0 ? Number((nextAmount / item.quantity).toFixed(2)) : item.unitPrice
                                  });
                                }}
                              />
                              {draftShowsJmdEntry && convertedAmount > 0 && (
                                <span className="invoice-currency-preview">{formatCurrency(convertedAmount, "USD")}</span>
                              )}
                            </div>
                          ) : (
                            formatCurrency(item.amount)
                          )}
                        </td>

                        {editingInvoice && (
                          <td>
                            <input
                              type="checkbox"
                              checked={Boolean(item.recordOnly)}
                              disabled={isLockedPaidRow}
                              title={isLockedPaidRow ? "Paid rows are locked." : "Keep this line on the invoice but skip expense/tally creation when paid."}
                              onChange={(event) => updateInvoiceDraftItem(index, { recordOnly: event.target.checked })}
                            />
                          </td>
                        )}

                        {!editingInvoice && <td>{isLinePaid ? "Paid" : isLineNotPaid ? "Journal Only" : "Unpaid"}</td>}

                        {editingInvoice && (
                          <td>
                            <button
                              className="btn ghost"
                              type="button"
                              onClick={() => setInvoiceDraft((current) => current ? { ...current, items: current.items.filter((_item, itemIndex) => itemIndex !== index) } : current)}
                              disabled={(invoiceDraft?.items.length ?? 0) <= 1 || isLockedPaidRow || activeInvoice.status === "PARTIALLY_PAID"}
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
              <div className="invoice-modal-footer">
                <div className="invoice-modal-footer-meta">
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={activeInvoice.status === "PARTIALLY_PAID"}
                    onClick={() => setInvoiceDraft((current) => current ? { ...current, items: [...current.items, createEmptyItem()] } : current)}
                  >
                    Add Item
                  </button>
                  <div className="invoice-total-stack">
                    <strong>{formatInvoiceEntryCurrency(invoiceDraftTotal, draftEntryCurrency)}</strong>
                    {draftShowsJmdEntry && draftFxQuote && (
                      <span className="invoice-currency-preview">
                        {formatCurrency(convertEntryValueToStoredUsd(invoiceDraftTotal, invoiceDraft.currency, draftFxQuote), "USD")}
                      </span>
                    )}
                  </div>
                </div>
                <div className="invoice-modal-footer-actions">
                  <button className="btn ghost" type="button" onClick={() => { setEditingInvoice(false); setInvoiceDraft(toInvoiceInput(activeInvoice)); }}>
                    Cancel
                  </button>
                  <button className="btn" type="button" onClick={() => saveInvoiceEdit()} disabled={savingInvoiceEdit}>
                    {savingInvoiceEdit ? "Saving..." : "Save Invoice"}
                  </button>
                </div>
              </div>
            ) : (
              canMarkPaid && activeInvoice.status !== "PAID" && (
                <div className="invoice-modal-footer">
                  <div className="invoice-modal-footer-actions">
                    {selectedPayIndexes.length > 0 ? (
                      <button className="btn" type="button" onClick={() => markPaid(activeInvoice._id, selectedPayIndexes)}>
                        Mark Selected Paid
                      </button>
                    ) : (
                      <button className="btn success" type="button" onClick={() => setConfirmPayInvoice(true)}>
                        Pay Invoice
                      </button>
                    )}
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmPayInvoice && Boolean(activeInvoice)}
        title="Pay Invoice?"
        message={
          activeInvoice
            ? `This will mark all remaining unpaid items on invoice ${activeInvoice.invoiceNumber} as paid.`
            : ""
        }
        confirmLabel="Pay Invoice"
        cancelLabel="Cancel"
        busyLabel="Paying..."
        busy={payingInvoice}
        onCancel={() => {
          if (!payingInvoice) {
            setConfirmPayInvoice(false);
          }
        }}
        onConfirm={async () => {
          if (!activeInvoice) {
            return;
          }

          await markPaid(activeInvoice._id);
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteInvoiceTarget)}
        title="Delete Invoice?"
        message={
          deleteInvoiceTarget
            ? `Delete invoice ${deleteInvoiceTarget.invoiceNumber}? This action cannot be undone.`
            : ""
        }
        confirmLabel="Delete Invoice"
        cancelLabel="Cancel"
        busyLabel="Deleting..."
        busy={deletingInvoice}
        onCancel={() => {
          if (!deletingInvoice) {
            setDeleteInvoiceTarget(null);
          }
        }}
        onConfirm={confirmDeleteInvoice}
      />
    </section>
  );
}













