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

const invoiceItemSchema = z.object({
  description: z.string().min(1),
  category: z.string().min(1),
  workerRole: workerRoleSchema.optional(),
  quantity: z.coerce.number().min(0),
  unit: z.string().optional(),
  unitPrice: z.coerce.number().min(0),
  amount: z.coerce.number().min(0),
  materialLabel: z.string().optional(),
  trackToTally: z.boolean().optional(),
  recordOnly: z.boolean().optional()
});

const createInvoiceSchema = z.object({
  vendor: z.string().min(1),
  invoiceNumber: z.string().min(1),
  issueDate: z.string().optional(),
  dueDate: z.string(),
  currency: z.string().min(3).max(3).optional(),
  notes: z.string().optional(),
  items: z.array(invoiceItemSchema).min(1)
});

const updateInvoiceSchema = createInvoiceSchema;

const listQuerySchema = z.object({
  status: z.enum(["UNPAID", "PARTIALLY_PAID", "PAID", "ALL"]).optional()
});

function isMaterialsCategory(category: string): boolean {
  return category.toLowerCase().includes("material");
}

function toMoney(value: number): number {
  return Number(value.toFixed(2));
}

function resolveInvoiceItemAmount(item: { quantity?: number; unitPrice?: number; amount?: number }): number {
  const quantity = Number(item.quantity ?? 0);
  const unitPrice = Number(item.unitPrice ?? 0);
  const amount = Number(item.amount ?? 0);

  if (quantity > 0 && unitPrice > 0) {
    return toMoney(quantity * unitPrice);
  }

  return toMoney(amount);
}

type ParsedInvoiceItem = z.infer<typeof invoiceItemSchema>;

function normalizeInvoiceItems(items: ParsedInvoiceItem[]) {
  return items.map((item) => ({
    ...item,
    amount: resolveInvoiceItemAmount(item),
    workerRole: item.workerRole ?? "OTHER",
    unit: item.unit ?? "",
    materialLabel: item.materialLabel?.trim() ?? "",
    trackToTally: item.trackToTally ?? false,
    recordOnly: item.recordOnly ?? false,
    paid: false
  }));
}

router.get("/", async (req, res, next) => {
  try {
    const { status } = listQuerySchema.parse(req.query);
    const filters: Record<string, string> = {};

    if (status && status !== "ALL") {
      filters.status = status;
    }

    const invoices = await InvoiceModel.find(filters).sort({ dueDate: 1, createdAt: -1 });
    res.json({
      invoices: invoices.map((invoice) => {
        const document = invoice.toObject();
        return {
          ...document,
          items: document.items.map((item) => ({
            ...item,
            workerRole: item.workerRole === "STEEL_MAN" ? "STEELWORKER" : item.workerRole,
            paid: Boolean(item.paid)
          }))
        };
      })
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = createInvoiceSchema.parse(req.body);
    const normalizedItems = normalizeInvoiceItems(payload.items);
    const computedTotal = normalizedItems.reduce((sum, item) => sum + (item.recordOnly ? 0 : item.amount), 0);

    const invoice = await InvoiceModel.create({
      vendor: payload.vendor,
      invoiceNumber: payload.invoiceNumber,
      issueDate: payload.issueDate ? new Date(payload.issueDate) : new Date(),
      dueDate: new Date(payload.dueDate),
      currency: payload.currency ?? "USD",
      notes: payload.notes ?? "",
      items: normalizedItems,
      totalAmount: computedTotal,
      paidAmount: 0,
      status: "UNPAID",
      createdBy: req.user?.id
    });

    res.status(201).json({ invoice });
  } catch (error) {
    next(error);
  }
});

router.put("/:id", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = updateInvoiceSchema.parse(req.body);
    const invoice = await InvoiceModel.findById(req.params.id);

    if (!invoice) {
      res.status(404).json({ message: "Invoice not found" });
      return;
    }

    if (invoice.status !== "UNPAID") {
      res.status(409).json({ message: "Only unpaid invoices can be fully edited" });
      return;
    }

    const normalizedItems = normalizeInvoiceItems(payload.items);
    const computedTotal = normalizedItems.reduce((sum, item) => sum + (item.recordOnly ? 0 : item.amount), 0);

    invoice.vendor = payload.vendor;
    invoice.invoiceNumber = payload.invoiceNumber;
    invoice.issueDate = payload.issueDate ? new Date(payload.issueDate) : invoice.issueDate;
    invoice.dueDate = new Date(payload.dueDate);
    invoice.currency = payload.currency ?? invoice.currency ?? "USD";
    invoice.notes = payload.notes ?? "";
    invoice.items = normalizedItems as any;
    invoice.totalAmount = computedTotal;
    invoice.paidAmount = 0;
    invoice.paidAt = undefined;
    invoice.generatedExpenseIds = [];
    await invoice.save();

    res.json({ invoice });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/mark-paid", requireRole("OWNER"), async (req, res, next) => {
  try {
    const payloadSchema = z.object({
      paidDate: z.string().optional(),
      phase: z.string().optional(),
      notes: z.string().optional(),
      itemIndexes: z.array(z.coerce.number().int().min(0)).optional()
    });

    const payload = payloadSchema.parse(req.body ?? {});

    const invoice = await InvoiceModel.findById(req.params.id);
    if (!invoice) {
      res.status(404).json({ message: "Invoice not found" });
      return;
    }

    if (invoice.status === "PAID") {
      res.status(409).json({ message: "Invoice is already marked paid" });
      return;
    }

    const normalizedItemIndexes = Array.from(new Set(payload.itemIndexes ?? []))
      .filter((index) => index >= 0 && index < invoice.items.length)
      .sort((a, b) => a - b);
    const unpaidIndexes = invoice.items
      .map((item, index) => ({ index, paid: Boolean(item.paid) }))
      .filter((entry) => !entry.paid)
      .map((entry) => entry.index);
    const targetIndexes = normalizedItemIndexes.length > 0 ? normalizedItemIndexes : unpaidIndexes;

    if (targetIndexes.length === 0) {
      res.status(409).json({ message: "No unpaid invoice items selected" });
      return;
    }

    const paidDate = payload.paidDate ? new Date(payload.paidDate) : new Date();
    const phase = payload.phase ?? "Phase 1";
    const generatedExpenseIds: Array<typeof invoice.generatedExpenseIds[number]> = [...invoice.generatedExpenseIds];
    let createdExpenses = 0;
    let mergedTallies = 0;
    let ignoredItems = 0;
    let newlyPaidItems = 0;
    let alreadyPaidItems = 0;

    for (const index of targetIndexes) {
      const item = invoice.items[index];
      if (!item) {
        continue;
      }

      if (item.paid) {
        alreadyPaidItems += 1;
        continue;
      }

      if (item.recordOnly) {
        ignoredItems += 1;
        item.paid = true;
        item.paidAt = paidDate;
        newlyPaidItems += 1;
        continue;
      }

      const normalizedWorkerRole = item.workerRole === "STEEL_MAN" ? "STEELWORKER" : (item.workerRole ?? "OTHER");
      const materialLabel = item.materialLabel?.trim() ?? "";
      const shouldTrackToTally = Boolean(item.trackToTally) || (Boolean(materialLabel) && isMaterialsCategory(item.category));
      const itemAmount = resolveInvoiceItemAmount(item);
      item.amount = itemAmount;

      if (shouldTrackToTally) {
        const tallyName = materialLabel || item.description;
        const tallyUnit = item.unit?.trim() ?? "";
        const tallyCandidates = await ExpenseModel.find({
          name: tallyName,
          category: { $regex: /^materials/i },
          phase
        }).sort({ updatedAt: -1 });
        const existingTally =
          tallyCandidates.find((candidate) => (candidate.unit ?? "").trim().toLowerCase() === tallyUnit.toLowerCase()) ??
          tallyCandidates[0];

        if (existingTally) {
          const quantity = existingTally.quantity + item.quantity;
          const amount = existingTally.amount + itemAmount;

          existingTally.quantity = Number(quantity.toFixed(3));
          existingTally.amount = toMoney(amount);
          existingTally.unitPrice = quantity > 0 ? Number((amount / quantity).toFixed(2)) : existingTally.unitPrice;
          if (!existingTally.unit && tallyUnit) {
            existingTally.unit = tallyUnit;
          }
          existingTally.date = paidDate;
          existingTally.vendor = invoice.vendor;
          existingTally.notes = payload.notes ?? invoice.notes;
          existingTally.source = "invoice-paid-tally";
          existingTally.workerRole = normalizedWorkerRole;
          existingTally.invoiceId = invoice._id;
          existingTally.invoiceNumber = invoice.invoiceNumber;
          await existingTally.save();

          if (!generatedExpenseIds.some((id) => id.equals(existingTally._id))) {
            generatedExpenseIds.push(existingTally._id);
          }
          item.paid = true;
          item.paidAt = paidDate;
          item.paidExpenseId = existingTally._id;
          newlyPaidItems += 1;
          mergedTallies += 1;
          continue;
        }

        const createdTally = await ExpenseModel.create({
          name: tallyName,
          category: isMaterialsCategory(item.category) ? item.category : "Materials",
          amount: itemAmount,
          date: paidDate,
          vendor: invoice.vendor,
          phase,
          unit: tallyUnit,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          notes: payload.notes ?? invoice.notes,
          source: "invoice-paid-tally",
          workerRole: normalizedWorkerRole,
          invoiceId: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          createdBy: req.user?.id
        });

        if (!generatedExpenseIds.some((id) => id.equals(createdTally._id))) {
          generatedExpenseIds.push(createdTally._id);
        }
        item.paid = true;
        item.paidAt = paidDate;
        item.paidExpenseId = createdTally._id;
        newlyPaidItems += 1;
        createdExpenses += 1;
        continue;
      }

      const createdExpense = await ExpenseModel.create({
        name: item.description,
        category: item.category,
        amount: itemAmount,
        date: paidDate,
        vendor: invoice.vendor,
        phase,
        unit: item.unit ?? "",
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        notes: payload.notes ?? invoice.notes,
        source: "invoice-paid",
        workerRole: normalizedWorkerRole,
        invoiceId: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        createdBy: req.user?.id
      });

      if (!generatedExpenseIds.some((id) => id.equals(createdExpense._id))) {
        generatedExpenseIds.push(createdExpense._id);
      }
      item.paid = true;
      item.paidAt = paidDate;
      item.paidExpenseId = createdExpense._id;
      newlyPaidItems += 1;
      createdExpenses += 1;
    }

    const paidAmount = invoice.items.reduce(
      (sum, item) => sum + (item.paid && !item.recordOnly ? resolveInvoiceItemAmount(item) : 0),
      0
    );
    const remainingUnpaidItems = invoice.items.filter((item) => !item.paid).length;

    invoice.paidAmount = Number(paidAmount.toFixed(2));
    if (remainingUnpaidItems === 0) {
      invoice.status = "PAID";
      invoice.paidAt = paidDate;
    } else if (invoice.paidAmount > 0) {
      invoice.status = "PARTIALLY_PAID";
      invoice.paidAt = undefined;
    } else {
      invoice.status = "UNPAID";
      invoice.paidAt = undefined;
    }
    if (newlyPaidItems > 0) {
      (invoice as any).paidBy = req.user?.id;
    }
    invoice.generatedExpenseIds = generatedExpenseIds;
    await invoice.save();

    res.json({ invoice, createdExpenses, mergedTallies, ignoredItems, newlyPaidItems, alreadyPaidItems, remainingUnpaidItems });
  } catch (error) {
    next(error);
  }
});

export default router;
