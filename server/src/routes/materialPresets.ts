import { Router } from "express";
import { z } from "zod";
import { ExpenseModel } from "../models/Expense.js";
import { MaterialPresetModel } from "../models/MaterialPreset.js";

const router = Router();

const materialPresetHistoryEntrySchema = z.object({
  unitPrice: z.coerce.number().min(0),
  changedAt: z.string().min(1),
  previousUnitPrice: z.coerce.number().min(0).optional()
});

const materialPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().optional(),
  unitPrice: z.coerce.number().min(0).default(0),
  priceHistory: z.array(materialPresetHistoryEntrySchema).default([])
});

const createMaterialPresetSchema = z.object({
  name: z.string().trim().min(1),
  unit: z.string().optional(),
  unitPrice: z.coerce.number().min(0).default(0)
});

const updateMaterialPresetSchema = z.object({
  name: z.string().trim().min(1).optional(),
  unit: z.string().optional(),
  unitPrice: z.coerce.number().min(0).optional()
});

const migrateMaterialPresetsSchema = z.object({
  presets: z.array(materialPresetSchema).default([]),
  removedPresetIds: z.array(z.string().min(1)).default([])
});

const defaultMaterialPresets = [
  { key: "cement", name: "Cement", unit: "Bag", unitPrice: 0 },
  { key: "steel", name: "Steel", unit: "Ton", unitPrice: 0 },
  { key: "sand", name: "Sand", unit: "Load", unitPrice: 0 },
  { key: "gravel", name: "Gravel", unit: "Load", unitPrice: 0 },
  { key: "blocks", name: "Blocks", unit: "Block", unitPrice: 0 }
] as const;

function toMoney(value: number): number {
  return Number(Number(value ?? 0).toFixed(2));
}

function toPresetKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function normalizeUnitValue(unit: string): string {
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

function normalizeMaterialName(name: string): string {
  const raw = (name ?? "").trim();
  if (!raw) {
    return "";
  }

  if (raw.toLowerCase() === "binding wire") {
    return "Binding Wire";
  }

  return raw
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function isMaterialsCategory(category?: string): boolean {
  return (category ?? "").trim().toLowerCase().startsWith("materials");
}

function getMaterialNameFromCategory(category?: string): string {
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

function resolveMaterialName(name: string, category: string): string {
  const categoryName = getMaterialNameFromCategory(category);
  return normalizeMaterialName(categoryName || name.trim());
}

function toIsoDate(value?: string | Date | null): string {
  if (!value) {
    return new Date().toISOString();
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

function serializePreset(preset: any) {
  return {
    id: preset.key,
    name: preset.name,
    unit: preset.unit ?? "",
    unitPrice: toMoney(Number(preset.unitPrice ?? 0)),
    priceHistory: Array.isArray(preset.priceHistory)
      ? preset.priceHistory
          .map((entry: any) => ({
            unitPrice: toMoney(Number(entry?.unitPrice ?? 0)),
            changedAt: toIsoDate(entry?.changedAt),
            previousUnitPrice:
              entry && typeof entry === "object" && entry.previousUnitPrice !== undefined
                ? toMoney(Number(entry.previousUnitPrice))
                : undefined
          }))
          .filter((entry: { changedAt: string }) => entry.changedAt.length > 0)
      : []
  };
}

async function ensureDefaultMaterialPresets() {
  const existing = await MaterialPresetModel.find().select({ key: 1, removed: 1 }).lean();
  const byKey = new Map(existing.map((preset) => [preset.key, preset]));
  const missingDefaults = defaultMaterialPresets.filter((preset) => !byKey.has(preset.key));

  if (missingDefaults.length === 0) {
    return;
  }

  await MaterialPresetModel.insertMany(
    missingDefaults.map((preset) => ({
      key: preset.key,
      name: preset.name,
      unit: preset.unit,
      unitPrice: preset.unitPrice,
      priceHistory: [],
      removed: false
    }))
  );
}

async function syncMaterialPresetsFromExpenses() {
  await ensureDefaultMaterialPresets();

  const [expenses, presets] = await Promise.all([
    ExpenseModel.find().sort({ createdAt: 1 }).lean(),
    MaterialPresetModel.find().sort({ createdAt: 1 })
  ]);

  const presetByKey = new Map(presets.map((preset) => [preset.key, preset]));
  let changed = false;

  for (const expense of expenses) {
    if (!isMaterialsCategory(expense.category)) {
      continue;
    }

    const materialName = resolveMaterialName(expense.name ?? "", expense.category ?? "");
    if (!materialName) {
      continue;
    }

    const key = toPresetKey(materialName);
    const unit = normalizeUnitValue(expense.unit ?? "");
    const unitPrice = toMoney(Number(expense.unitPrice ?? 0));
    const createdAt = toIsoDate(expense.createdAt ?? expense.date);
    const existing = presetByKey.get(key);

    if (!existing) {
      const created = await MaterialPresetModel.create({
        key,
        name: materialName,
        unit,
        unitPrice,
        priceHistory:
          unitPrice > 0
            ? [
                {
                  unitPrice,
                  changedAt: new Date(createdAt)
                }
              ]
            : [],
        removed: false
      });
      presetByKey.set(key, created);
      changed = true;
      continue;
    }

    if (existing.removed) {
      continue;
    }

    let shouldSave = false;
    if (!existing.unit && unit) {
      existing.unit = unit;
      shouldSave = true;
    }

    if ((Number(existing.unitPrice ?? 0) <= 0 || !Array.isArray(existing.priceHistory) || existing.priceHistory.length === 0) && unitPrice > 0) {
      existing.unitPrice = unitPrice;
      existing.priceHistory = [
        ...(existing.priceHistory ?? []),
        {
          unitPrice,
          changedAt: new Date(createdAt)
        }
      ] as any;
      shouldSave = true;
    }

    if (shouldSave) {
      await existing.save();
      changed = true;
    }
  }

  if (!changed) {
    return presets.filter((preset) => !preset.removed);
  }

  return MaterialPresetModel.find({ removed: false }).sort({ name: 1 });
}

router.get("/", async (_req, res, next) => {
  try {
    const presets = await syncMaterialPresetsFromExpenses();
    res.json({ presets: presets.map(serializePreset) });
  } catch (error) {
    next(error);
  }
});

router.post("/migrate", async (req, res, next) => {
  try {
    const payload = migrateMaterialPresetsSchema.parse(req.body);

    for (const removedId of payload.removedPresetIds) {
      const key = toPresetKey(removedId);
      const existing = await MaterialPresetModel.findOne({ key });
      if (existing) {
        existing.removed = true;
        await existing.save();
      } else {
        await MaterialPresetModel.create({
          key,
          name: normalizeMaterialName(removedId.replace(/-/g, " ")),
          unit: "",
          unitPrice: 0,
          priceHistory: [],
          removed: true
        });
      }
    }

    for (const preset of payload.presets) {
      const key = toPresetKey(preset.id || preset.name);
      const name = normalizeMaterialName(preset.name);
      const unit = normalizeUnitValue(preset.unit ?? "");
      const unitPrice = toMoney(Number(preset.unitPrice ?? 0));
      const priceHistory = preset.priceHistory
        .map((entry) => ({
          unitPrice: toMoney(Number(entry.unitPrice ?? 0)),
          changedAt: new Date(toIsoDate(entry.changedAt)),
          previousUnitPrice:
            entry.previousUnitPrice !== undefined ? toMoney(Number(entry.previousUnitPrice)) : undefined
        }))
        .sort((left, right) => left.changedAt.getTime() - right.changedAt.getTime());

      const existing = await MaterialPresetModel.findOne({ key });
      if (existing) {
        existing.name = name;
        existing.unit = unit;
        existing.unitPrice = unitPrice;
        existing.priceHistory = priceHistory as any;
        existing.removed = false;
        await existing.save();
      } else {
        await MaterialPresetModel.create({
          key,
          name,
          unit,
          unitPrice,
          priceHistory,
          removed: false
        });
      }
    }

    const presets = await syncMaterialPresetsFromExpenses();
    res.json({ presets: presets.map(serializePreset) });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const payload = createMaterialPresetSchema.parse(req.body);
    const key = toPresetKey(payload.name);
    const existing = await MaterialPresetModel.findOne({ key });

    if (existing && !existing.removed) {
      res.status(409).json({ message: "That material preset already exists." });
      return;
    }

    const unitPrice = toMoney(Number(payload.unitPrice ?? 0));
    const nextHistory =
      unitPrice > 0
        ? [
            {
              unitPrice,
              changedAt: new Date()
            }
          ]
        : [];

    if (existing && existing.removed) {
      existing.name = normalizeMaterialName(payload.name);
      existing.unit = normalizeUnitValue(payload.unit ?? "");
      existing.unitPrice = unitPrice;
      existing.priceHistory = nextHistory as any;
      existing.removed = false;
      await existing.save();
      res.status(201).json({ preset: serializePreset(existing) });
      return;
    }

    const preset = await MaterialPresetModel.create({
      key,
      name: normalizeMaterialName(payload.name),
      unit: normalizeUnitValue(payload.unit ?? ""),
      unitPrice,
      priceHistory: nextHistory,
      removed: false,
      createdBy: req.user?.id
    });

    res.status(201).json({ preset: serializePreset(preset) });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const payload = updateMaterialPresetSchema.parse(req.body);
    const key = toPresetKey(req.params.id);
    const preset = await MaterialPresetModel.findOne({ key, removed: false });

    if (!preset) {
      res.status(404).json({ message: "Material preset not found" });
      return;
    }

    if (payload.name !== undefined) {
      preset.name = normalizeMaterialName(payload.name);
    }

    if (payload.unit !== undefined) {
      preset.unit = normalizeUnitValue(payload.unit);
    }

    if (payload.unitPrice !== undefined) {
      const nextUnitPrice = toMoney(Number(payload.unitPrice));
      const currentUnitPrice = toMoney(Number(preset.unitPrice ?? 0));
      if (nextUnitPrice !== currentUnitPrice) {
        preset.priceHistory = [
          ...(preset.priceHistory ?? []),
          {
            unitPrice: nextUnitPrice,
            previousUnitPrice: currentUnitPrice,
            changedAt: new Date()
          }
        ] as any;
        preset.unitPrice = nextUnitPrice;
      }
    }

    await preset.save();
    res.json({ preset: serializePreset(preset) });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const key = toPresetKey(req.params.id);
    const preset = await MaterialPresetModel.findOne({ key });
    if (!preset) {
      res.status(404).json({ message: "Material preset not found" });
      return;
    }

    preset.removed = true;
    await preset.save();
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
