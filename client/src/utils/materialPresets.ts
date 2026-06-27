import type { Expense, MaterialPreset } from "../types/models";

export const materialPresetStorageKey = "dream_home_material_presets_v1";
export const materialPresetDeletedStorageKey = "dream_home_material_presets_deleted_v1";

const materialNameAliases: Record<string, string> = {
  "binding wire": "Binding Wire"
};

export function normalizeUnitValue(unit: string): string {
  const raw = (unit ?? "").trim();
  if (!raw) {
    return "";
  }

  const lowered = raw.toLowerCase();
  if (lowered === "piece" || lowered === "pieces" || lowered === "block" || lowered === "blocks") {
    return "Block";
  }

  return raw
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function normalizeMaterialName(name: string): string {
  const raw = (name ?? "").trim();
  if (!raw) {
    return "";
  }

  const alias = materialNameAliases[raw.toLowerCase()];
  if (alias) {
    return alias;
  }

  return raw
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export const defaultMaterialPresets: MaterialPreset[] = [
  { id: "cement", name: "Cement", unit: "Bag", unitPrice: 0, priceHistory: [] },
  { id: "steel", name: "Steel", unit: "Ton", unitPrice: 0, priceHistory: [] },
  { id: "sand", name: "Sand", unit: "Load", unitPrice: 0, priceHistory: [] },
  { id: "gravel", name: "Gravel", unit: "Load", unitPrice: 0, priceHistory: [] },
  { id: "blocks", name: "Blocks", unit: "Block", unitPrice: 0, priceHistory: [] }
];

export function toPresetId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function isMaterialsCategory(category?: string): boolean {
  return (category ?? "").trim().toLowerCase().startsWith("materials");
}

export function getMaterialNameFromCategory(category?: string): string {
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

export function resolveMaterialName(name: string, category: string): string {
  const categoryName = getMaterialNameFromCategory(category);
  return normalizeMaterialName(categoryName || name.trim());
}

export function parseStoredMaterialPresets(raw: string | null): MaterialPreset[] {
  if (!raw) {
    return defaultMaterialPresets;
  }

  try {
    const parsed = JSON.parse(raw) as MaterialPreset[];
    if (!Array.isArray(parsed)) {
      return defaultMaterialPresets;
    }

    const sanitized = parsed
      .map((item) => ({
        id: toPresetId(String(item?.id || item?.name || "")),
        name: normalizeMaterialName(String(item?.name ?? "").trim()),
        unit: normalizeUnitValue(String(item?.unit ?? "")),
        unitPrice: Number(item?.unitPrice ?? 0),
        priceHistory: Array.isArray((item as MaterialPreset).priceHistory)
          ? (item as MaterialPreset).priceHistory
              .map((entry) => ({
                unitPrice: Number(entry?.unitPrice ?? 0),
                changedAt: String(entry?.changedAt ?? ""),
                previousUnitPrice:
                  entry && typeof entry === "object" && "previousUnitPrice" in entry && Number.isFinite(Number(entry.previousUnitPrice))
                    ? Number(entry.previousUnitPrice)
                    : undefined
              }))
              .filter((entry) => Number.isFinite(entry.unitPrice) && entry.changedAt.length > 0)
          : []
      }))
      .filter((item) => item.id && item.name);

    return sanitized;
  } catch {
    return defaultMaterialPresets;
  }
}

export function parseStoredRemovedPresetIds(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((item) => toPresetId(String(item))).filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

export function readLegacyMaterialPresetMigrationPayload() {
  if (typeof window === "undefined") {
    return { presets: [] as MaterialPreset[], removedPresetIds: [] as string[], hasLegacyData: false };
  }

  const presetRaw = window.localStorage.getItem(materialPresetStorageKey);
  const removedRaw = window.localStorage.getItem(materialPresetDeletedStorageKey);

  return {
    presets: presetRaw ? parseStoredMaterialPresets(presetRaw) : [],
    removedPresetIds: removedRaw ? parseStoredRemovedPresetIds(removedRaw) : [],
    hasLegacyData: presetRaw !== null || removedRaw !== null
  };
}

export function clearLegacyMaterialPresetStorage() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(materialPresetStorageKey);
  window.localStorage.removeItem(materialPresetDeletedStorageKey);
}

export function mergePresetsWithExpenses(current: MaterialPreset[], expenses: Expense[], removedPresetIds: string[] = []): MaterialPreset[] {
  const presetMap = new Map<string, MaterialPreset>();
  const removedSet = new Set(removedPresetIds.map((id) => toPresetId(id)));
  for (const preset of current) {
    presetMap.set(toPresetId(preset.name), preset);
  }

  let changed = false;

  for (const expense of expenses) {
    if (!isMaterialsCategory(expense.category)) {
      continue;
    }

    const materialName = resolveMaterialName(expense.name, expense.category);
    if (!materialName) {
      continue;
    }

    const id = toPresetId(materialName);
    if (removedSet.has(id)) {
      continue;
    }

    const existing = presetMap.get(id);

    if (!existing) {
      changed = true;
        presetMap.set(id, {
          id,
          name: materialName,
          unit: normalizeUnitValue(expense.unit ?? ""),
          unitPrice: Number(expense.unitPrice ?? 0),
        priceHistory:
          Number(expense.unitPrice ?? 0) > 0
            ? [
                {
                  unitPrice: Number(expense.unitPrice ?? 0),
                  changedAt: new Date().toISOString()
                }
              ]
            : []
      });
      continue;
    }

    let next = existing;
    if (!next.unit && expense.unit) {
      changed = true;
      next = { ...next, unit: normalizeUnitValue(expense.unit) };
    }

    if (next.unitPrice <= 0 && expense.unitPrice > 0) {
      changed = true;
      next = {
        ...next,
        unitPrice: Number(expense.unitPrice),
        priceHistory: [
          ...next.priceHistory,
          {
            unitPrice: Number(expense.unitPrice),
            changedAt: new Date().toISOString()
          }
        ]
      };
    }

    if (next !== existing) {
      presetMap.set(id, next);
    }
  }

  if (!changed) {
    return current;
  }

  return Array.from(presetMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
