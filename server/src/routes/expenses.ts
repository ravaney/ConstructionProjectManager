import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { ExpenseModel } from "../models/Expense.js";
import { InvoiceModel } from "../models/Invoice.js";
import { buildChangedFields, buildExpenseSnapshot, recordHistoryEvent } from "../services/history.js";
import { resolveTaskScope, syncTaskHierarchyState } from "../utils/taskHierarchy.js";

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
  phaseTaskId: z.string().optional(),
  section: z.string().optional(),
  sectionTaskId: z.string().optional(),
  subsection: z.string().optional(),
  subsectionTaskId: z.string().optional(),
  unit: z.string().optional(),
  unitPrice: z.coerce.number().min(0).optional(),
  quantity: z.coerce.number().min(0).optional(),
  notes: z.string().optional(),
  source: z.string().optional(),
  workerRole: workerRoleSchema.optional(),
  workerProfileId: z.string().optional(),
  invoiceId: z.string().optional(),
  invoiceNumber: z.string().optional(),
  allowPotentialDuplicate: z.boolean().optional()
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

function toIdString(value: unknown): string {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null && "toString" in value) {
    return value.toString();
  }

  return "";
}

function resolveAmount(quantity: number, unitPrice: number, amount: number): number {
  if (quantity > 0 && unitPrice > 0) {
    return toMoney(quantity * unitPrice);
  }

  return toMoney(amount);
}

function normalizeDuplicateText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toDateKey(value: string | Date | undefined): string {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

function buildExpenseHistoryScope(expense: {
  phase?: string;
  phaseTaskId?: unknown;
  section?: string;
  sectionTaskId?: unknown;
  subsection?: string;
  subsectionTaskId?: unknown;
}) {
  return {
    phase: expense.phase ?? "",
    phaseTaskId: toIdString(expense.phaseTaskId),
    section: expense.section ?? "",
    sectionTaskId: toIdString(expense.sectionTaskId),
    subsection: expense.subsection ?? "",
    subsectionTaskId: toIdString(expense.subsectionTaskId)
  };
}

function shouldCheckPotentialDuplicates(source?: string): boolean {
  const normalized = normalizeDuplicateText(source);
  return normalized === "" || normalized === "manual" || normalized === "csv-import";
}

async function findPotentialDuplicateExpenses(
  input: {
    name?: string;
    amount?: number;
    date?: string | Date;
    vendor?: string;
    phase?: string;
    phaseTaskId?: string;
    section?: string;
    sectionTaskId?: string;
    invoiceNumber?: string;
  },
  excludeId?: string
) {
  const normalizedName = normalizeDuplicateText(input.name);
  const normalizedVendor = normalizeDuplicateText(input.vendor);
  const normalizedInvoiceNumber = normalizeDuplicateText(input.invoiceNumber);
  const normalizedPhase = input.phaseTaskId || normalizeDuplicateText(input.phase);
  const normalizedSection = input.sectionTaskId || normalizeDuplicateText(input.section);
  const amount = Number(input.amount ?? 0);
  const dateKey = toDateKey(input.date);

  if (!normalizedName && !normalizedInvoiceNumber) {
    return [];
  }

  const query: Record<string, unknown> = {};
  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const candidates = await ExpenseModel.find(query).sort({ date: -1, createdAt: -1 }).limit(80);

  return candidates
    .map((candidate) => {
      let score = 0;
      const matches: string[] = [];

      if (normalizedInvoiceNumber && normalizeDuplicateText(candidate.invoiceNumber) === normalizedInvoiceNumber) {
        score += 6;
        matches.push("same invoice number");
      }

      if (normalizedName && normalizeDuplicateText(candidate.name) === normalizedName) {
        score += 4;
        matches.push("same item");
      }

      if (Math.abs(Number(candidate.amount ?? 0) - amount) < 0.01) {
        score += 3;
        matches.push("same amount");
      }

      if (dateKey && toDateKey(candidate.date) === dateKey) {
        score += 2;
        matches.push("same date");
      }

      if (normalizedVendor && normalizeDuplicateText(candidate.vendor) === normalizedVendor) {
        score += 2;
        matches.push("same vendor");
      }

      const candidatePhase = toIdString(candidate.phaseTaskId) || normalizeDuplicateText(candidate.phase);
      if (normalizedPhase && candidatePhase === normalizedPhase) {
        score += 1;
        matches.push("same phase");
      }

      const candidateSection = toIdString(candidate.sectionTaskId) || normalizeDuplicateText(candidate.section);
      if (normalizedSection && candidateSection === normalizedSection) {
        score += 1;
        matches.push("same section");
      }

      const exactMatch =
        matches.includes("same item") &&
        matches.includes("same amount") &&
        matches.includes("same date") &&
        (matches.includes("same vendor") || matches.includes("same invoice number"));

      return {
        candidate,
        exactMatch,
        score,
        matches
      };
    })
    .filter((entry) => entry.exactMatch || entry.score >= 7)
    .sort((left, right) => Number(right.exactMatch) - Number(left.exactMatch) || right.score - left.score)
    .slice(0, 5)
    .map((entry) => ({
      expenseId: String(entry.candidate._id),
      name: entry.candidate.name,
      amount: Number(entry.candidate.amount ?? 0),
      date: entry.candidate.date?.toISOString?.() ?? new Date(entry.candidate.date).toISOString(),
      vendor: entry.candidate.vendor ?? "",
      phase: entry.candidate.phase ?? "",
      section: entry.candidate.section ?? "",
      score: entry.score,
      exactMatch: entry.exactMatch,
      reasons: entry.matches
    }));
}

router.get("/", async (req, res, next) => {
  try {
    await syncTaskHierarchyState();
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

    const expenses = await ExpenseModel.find(filters).sort({ createdAt: -1, _id: -1 });
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

        if (!item.paid || item.recordOnly) {
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
    const operationId = randomUUID();
    const { allowPotentialDuplicate, ...payload } = expensePayloadSchema.parse(req.body);
    const scope = await resolveTaskScope(payload);
    const normalizedAmount = resolveAmount(Number(payload.quantity ?? 0), Number(payload.unitPrice ?? 0), Number(payload.amount ?? 0));
    if (!allowPotentialDuplicate && shouldCheckPotentialDuplicates(payload.source)) {
      const duplicates = await findPotentialDuplicateExpenses({
        ...payload,
        amount: normalizedAmount,
        date: payload.date,
        phase: scope.phase,
        phaseTaskId: scope.phaseTaskId,
        section: scope.section,
        sectionTaskId: scope.sectionTaskId
      });
      if (duplicates.length > 0) {
        res.status(409).json({
          message: "Potential duplicate expenses found",
          duplicates
        });
        return;
      }
    }

    const expense = await ExpenseModel.create({
      ...payload,
      date: payload.date ? new Date(payload.date) : new Date(),
      vendor: payload.vendor ?? "",
      phase: scope.phase,
      phaseTaskId: scope.phaseTaskId,
      section: scope.section,
      sectionTaskId: scope.sectionTaskId,
      subsection: scope.subsection,
      subsectionTaskId: scope.subsectionTaskId,
      unit: payload.unit ?? "",
      unitPrice: payload.unitPrice ?? 0,
      quantity: payload.quantity ?? 0,
      notes: payload.notes ?? "",
      source: payload.source ?? "manual",
      workerRole: payload.workerRole ?? "OTHER",
      invoiceNumber: payload.invoiceNumber ?? "",
      createdBy: req.user?.id
    });
    const afterSnapshot = buildExpenseSnapshot(expense);
    await recordHistoryEvent({
      operationId,
      entityType: "EXPENSE",
      entityId: String(expense._id),
      entityLabel: expense.name,
      action: "CREATE",
      summary: `Expense ${expense.name} created`,
      actor: req.user,
      scope: buildExpenseHistoryScope(expense),
      after: afterSnapshot,
      moneyImpact: {
        label: "Expense Amount",
        before: 0,
        after: Number(afterSnapshot.amount ?? 0)
      }
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

    const docs = [];
    for (const expense of payload.expenses) {
      const scope = await resolveTaskScope(expense);
      docs.push({
        ...expense,
        date: expense.date ? new Date(expense.date) : new Date(),
        vendor: expense.vendor ?? "",
        phase: scope.phase,
        phaseTaskId: scope.phaseTaskId,
        section: scope.section,
        sectionTaskId: scope.sectionTaskId,
        subsection: scope.subsection,
        subsectionTaskId: scope.subsectionTaskId,
        unit: expense.unit ?? "",
        unitPrice: expense.unitPrice ?? 0,
        quantity: expense.quantity ?? 0,
        notes: expense.notes ?? "",
        source: expense.source ?? "csv-import",
        workerRole: expense.workerRole ?? "OTHER",
        invoiceNumber: expense.invoiceNumber ?? "",
        createdBy: req.user?.id
      });
    }

    const inserted = await ExpenseModel.insertMany(docs);
    res.status(201).json({ insertedCount: inserted.length });
  } catch (error) {
    next(error);
  }
});

router.put("/:id", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const operationId = randomUUID();
    const payload = expenseUpdateSchema.parse(req.body);
    const updatePayload: Record<string, unknown> = { ...payload };
    const existingExpense = await ExpenseModel.findById(req.params.id);

    if (!existingExpense) {
      res.status(404).json({ message: "Expense not found" });
      return;
    }

    if (existingExpense.source === "task-complete") {
      res.status(409).json({
        message: "Task-linked expenses are read-only here. Edit the linked task to update this expense."
      });
      return;
    }

    const beforeSnapshot = buildExpenseSnapshot(existingExpense);
    const allowPotentialDuplicate = Boolean(updatePayload.allowPotentialDuplicate);
    delete updatePayload.allowPotentialDuplicate;

    const scope = await resolveTaskScope({
      phaseTaskId: payload.phaseTaskId ?? toIdString(existingExpense.phaseTaskId),
      sectionTaskId: payload.sectionTaskId ?? toIdString(existingExpense.sectionTaskId),
      subsectionTaskId: payload.subsectionTaskId ?? toIdString(existingExpense.subsectionTaskId),
      phase: payload.phase ?? existingExpense.phase,
      section: payload.section ?? existingExpense.section,
      subsection: payload.subsection ?? existingExpense.subsection
    });

    if (payload.date) {
      updatePayload.date = new Date(payload.date);
    }

    updatePayload.phase = scope.phase;
    updatePayload.phaseTaskId = scope.phaseTaskId;
    updatePayload.section = scope.section;
    updatePayload.sectionTaskId = scope.sectionTaskId;
    updatePayload.subsection = scope.subsection;
    updatePayload.subsectionTaskId = scope.subsectionTaskId;

    const nextAmount = resolveAmount(
      Number(updatePayload.quantity ?? existingExpense.quantity ?? 0),
      Number(updatePayload.unitPrice ?? existingExpense.unitPrice ?? 0),
      Number(updatePayload.amount ?? existingExpense.amount ?? 0)
    );
    if (!allowPotentialDuplicate && shouldCheckPotentialDuplicates(String(updatePayload.source ?? existingExpense.source ?? ""))) {
      const duplicates = await findPotentialDuplicateExpenses(
        {
          name: String(updatePayload.name ?? existingExpense.name ?? ""),
          amount: nextAmount,
          date: (updatePayload.date as Date | undefined) ?? existingExpense.date,
          vendor: String(updatePayload.vendor ?? existingExpense.vendor ?? ""),
          phase: scope.phase,
          phaseTaskId: scope.phaseTaskId,
          section: scope.section,
          sectionTaskId: scope.sectionTaskId,
          invoiceNumber: String(updatePayload.invoiceNumber ?? existingExpense.invoiceNumber ?? "")
        },
        req.params.id
      );
      if (duplicates.length > 0) {
        res.status(409).json({
          message: "Potential duplicate expenses found",
          duplicates
        });
        return;
      }
    }

    const expense = await ExpenseModel.findByIdAndUpdate(req.params.id, updatePayload, {
      new: true
    });
    if (expense) {
      const afterSnapshot = buildExpenseSnapshot(expense);
      const changedFields = buildChangedFields(beforeSnapshot, afterSnapshot);
      await recordHistoryEvent({
        operationId,
        entityType: "EXPENSE",
        entityId: String(expense._id),
        entityLabel: expense.name,
        action: "UPDATE",
        summary:
          beforeSnapshot.amount !== afterSnapshot.amount
            ? `Expense ${expense.name} amount changed from ${toMoney(Number(beforeSnapshot.amount ?? 0))} to ${toMoney(Number(afterSnapshot.amount ?? 0))}`
            : `Expense ${expense.name} updated`,
        actor: req.user,
        scope: buildExpenseHistoryScope(expense),
        before: beforeSnapshot,
        after: afterSnapshot,
        changedFields,
        moneyImpact:
          beforeSnapshot.amount !== afterSnapshot.amount
            ? {
                label: "Expense Amount",
                before: Number(beforeSnapshot.amount ?? 0),
                after: Number(afterSnapshot.amount ?? 0)
              }
            : undefined
      });
    }

    res.json({ expense });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireRole("OWNER"), async (req, res, next) => {
  try {
    const operationId = randomUUID();
    const existingExpense = await ExpenseModel.findById(req.params.id);

    if (!existingExpense) {
      res.status(404).json({ message: "Expense not found" });
      return;
    }

    if (existingExpense.source === "task-complete") {
      res.status(409).json({
        message: "Task-linked expenses cannot be deleted here. Edit or remove the linked task instead."
      });
      return;
    }

    const beforeSnapshot = buildExpenseSnapshot(existingExpense);

    await ExpenseModel.findByIdAndDelete(req.params.id);
    await recordHistoryEvent({
      operationId,
      entityType: "EXPENSE",
      entityId: String(existingExpense._id),
      entityLabel: existingExpense.name,
      action: "DELETE",
      summary: `Expense ${existingExpense.name} deleted`,
      actor: req.user,
      scope: buildExpenseHistoryScope(existingExpense),
      before: beforeSnapshot,
      moneyImpact: {
        label: "Expense Amount",
        before: Number(beforeSnapshot.amount ?? 0),
        after: 0
      }
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
