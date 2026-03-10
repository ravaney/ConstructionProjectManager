import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { ExpenseModel } from "../models/Expense.js";
import { InvoiceModel } from "../models/Invoice.js";

const router = Router();

const workerRoleSchema = z
  .enum(["PLUMBER", "ELECTRICIAN", "CONTRACTOR", "STEELWORKER", "CARPENTER", "MASON", "LABORER", "OTHER"])
  .or(z.literal("STEEL_MAN"))
  .transform((role) => (role === "STEEL_MAN" ? "STEELWORKER" : role));

const expensePayloadSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  amount: z.coerce.number().min(0),
  date: z.string().optional(),
  vendor: z.string().optional(),
  phase: z.string().optional(),
  unit: z.string().optional(),
  unitPrice: z.coerce.number().min(0).optional(),
  quantity: z.coerce.number().min(0).optional(),
  notes: z.string().optional(),
  source: z.string().optional(),
  workerRole: workerRoleSchema.optional(),
  workerProfileId: z.string().optional(),
  invoiceId: z.string().optional(),
  invoiceNumber: z.string().optional()
});

const expenseUpdateSchema = expensePayloadSchema.partial();

const querySchema = z.object({
  category: z.string().optional(),
  phase: z.string().optional(),
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  workerRole: workerRoleSchema.optional()
});

function isMaterialsCategory(category: string): boolean {
  return category.trim().toLowerCase().startsWith("materials");
}

function getMaterialNameFromCategory(category: string): string {
  const normalized = category.trim();
  if (!isMaterialsCategory(normalized)) {
    return "";
  }

  const slashIndex = normalized.indexOf("/");
  if (slashIndex < 0) {
    return "";
  }

  return normalized.slice(slashIndex + 1).trim();
}

function toMaterialKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function toMoney(value: number): number {
  return Number(value.toFixed(2));
}

function resolveAmount(quantity: number, unitPrice: number, amount: number): number {
  if (quantity > 0 && unitPrice > 0) {
    return toMoney(quantity * unitPrice);
  }

  return toMoney(amount);
}

router.get("/", async (req, res, next) => {
  try {
    const { category, phase, search, from, to, workerRole } = querySchema.parse(req.query);
    const filters: Record<string, unknown> = {};

    if (category) {
      filters.category = category;
    }

    if (phase) {
      filters.phase = phase;
    }

    if (workerRole) {
      filters.workerRole = workerRole === "STEELWORKER" ? { $in: ["STEELWORKER", "STEEL_MAN"] } : workerRole;
    }

    if (search) {
      filters.name = { $regex: search, $options: "i" };
    }

    if (from || to) {
      filters.date = {};
      if (from) {
        (filters.date as Record<string, unknown>).$gte = new Date(from);
      }
      if (to) {
        (filters.date as Record<string, unknown>).$lte = new Date(to);
      }
    }

    const expenses = await ExpenseModel.find(filters).sort({ date: -1, createdAt: -1 });
    res.json({
      expenses: expenses.map((expense) => {
        const document = expense.toObject();
        return {
          ...document,
          workerRole: document.workerRole === "STEEL_MAN" ? "STEELWORKER" : document.workerRole
        };
      })
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/tally-details", async (req, res, next) => {
  try {
    const expense = await ExpenseModel.findById(req.params.id);
    if (!expense) {
      res.status(404).json({ message: "Expense not found" });
      return;
    }

    if (!isMaterialsCategory(expense.category)) {
      res.status(400).json({ message: "Tally details are only available for material expenses" });
      return;
    }

    const expenseMaterialName = getMaterialNameFromCategory(expense.category) || expense.name;
    const expenseMaterialKey = toMaterialKey(expenseMaterialName);
    const expenseUnitKey = (expense.unit ?? "").trim().toLowerCase();

    const invoices = await InvoiceModel.find({ "items.paid": true }).sort({ paidAt: -1, updatedAt: -1 });
    const lines: Array<{
      invoiceId: string;
      invoiceNumber: string;
      vendor: string;
      paidAt: Date;
      quantity: number;
      unit: string;
      unitPrice: number;
      amount: number;
      category: string;
      description: string;
    }> = [];

    for (const invoice of invoices) {
      for (const item of invoice.items) {
        if (!item.paid || item.recordOnly) {
          continue;
        }

        const itemCategory = item.category ?? "";
        const shouldTrackToTally = Boolean(item.trackToTally) || isMaterialsCategory(itemCategory);
        if (!shouldTrackToTally) {
          continue;
        }

        const itemMaterialName = item.materialLabel?.trim() || getMaterialNameFromCategory(itemCategory) || item.description || "";
        if (toMaterialKey(itemMaterialName) !== expenseMaterialKey) {
          continue;
        }

        const itemUnit = (item.unit ?? "").trim();
        const itemUnitKey = itemUnit.toLowerCase();
        const unitMatches = !expenseUnitKey || !itemUnitKey || expenseUnitKey === itemUnitKey;
        if (!unitMatches) {
          continue;
        }

        const quantity = Number(item.quantity ?? 0);
        const unitPrice = Number(item.unitPrice ?? 0);
        const amount = resolveAmount(quantity, unitPrice, Number(item.amount ?? 0));
        const paidAt = item.paidAt ?? invoice.paidAt ?? invoice.updatedAt ?? invoice.createdAt;

        lines.push({
          invoiceId: String(invoice._id),
          invoiceNumber: invoice.invoiceNumber,
          vendor: invoice.vendor,
          paidAt,
          quantity: Number(quantity.toFixed(3)),
          unit: itemUnit,
          unitPrice: toMoney(unitPrice),
          amount,
          category: itemCategory,
          description: item.description
        });
      }
    }

    lines.sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime());

    const detailQuantity = Number(lines.reduce((sum, line) => sum + line.quantity, 0).toFixed(3));
    const detailAmount = toMoney(lines.reduce((sum, line) => sum + line.amount, 0));
    const unmatchedQuantity = Number((expense.quantity - detailQuantity).toFixed(3));
    const unmatchedAmount = toMoney(expense.amount - detailAmount);

    res.json({
      material: expenseMaterialName,
      expense: {
        _id: String(expense._id),
        name: expense.name,
        category: expense.category,
        unit: expense.unit,
        quantity: expense.quantity,
        amount: expense.amount
      },
      lines: lines.map((line) => ({
        ...line,
        paidAt: line.paidAt.toISOString()
      })),
      totals: {
        quantity: detailQuantity,
        amount: detailAmount,
        lineCount: lines.length
      },
      unmatched: {
        quantity: unmatchedQuantity,
        amount: unmatchedAmount
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = expensePayloadSchema.parse(req.body);
    const expense = await ExpenseModel.create({
      ...payload,
      date: payload.date ? new Date(payload.date) : new Date(),
      vendor: payload.vendor ?? "",
      phase: payload.phase ?? "Phase 1",
      unit: payload.unit ?? "",
      unitPrice: payload.unitPrice ?? 0,
      quantity: payload.quantity ?? 0,
      notes: payload.notes ?? "",
      source: payload.source ?? "manual",
      workerRole: payload.workerRole ?? "OTHER",
      invoiceNumber: payload.invoiceNumber ?? "",
      createdBy: req.user?.id
    });

    res.status(201).json({ expense });
  } catch (error) {
    next(error);
  }
});

router.post("/bulk", requireRole("OWNER"), async (req, res, next) => {
  try {
    const bulkSchema = z.object({
      expenses: z.array(expensePayloadSchema).min(1)
    });

    const payload = bulkSchema.parse(req.body);

    const docs = payload.expenses.map((expense) => ({
      ...expense,
      date: expense.date ? new Date(expense.date) : new Date(),
      vendor: expense.vendor ?? "",
      phase: expense.phase ?? "Phase 1",
      unit: expense.unit ?? "",
      unitPrice: expense.unitPrice ?? 0,
      quantity: expense.quantity ?? 0,
      notes: expense.notes ?? "",
      source: expense.source ?? "csv-import",
      workerRole: expense.workerRole ?? "OTHER",
      invoiceNumber: expense.invoiceNumber ?? "",
      createdBy: req.user?.id
    }));

    const inserted = await ExpenseModel.insertMany(docs);
    res.status(201).json({ insertedCount: inserted.length });
  } catch (error) {
    next(error);
  }
});

router.put("/:id", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = expenseUpdateSchema.parse(req.body);
    const updatePayload: Record<string, unknown> = { ...payload };

    if (payload.date) {
      updatePayload.date = new Date(payload.date);
    }

    const expense = await ExpenseModel.findByIdAndUpdate(req.params.id, updatePayload, {
      new: true
    });

    if (!expense) {
      res.status(404).json({ message: "Expense not found" });
      return;
    }

    res.json({ expense });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireRole("OWNER"), async (req, res, next) => {
  try {
    const deleted = await ExpenseModel.findByIdAndDelete(req.params.id);

    if (!deleted) {
      res.status(404).json({ message: "Expense not found" });
      return;
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
