import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { ExpenseModel } from "../models/Expense.js";
import { EstimateGroupModel } from "../models/EstimateGroup.js";
import { TaskModel } from "../models/Task.js";
import { getJmdRateQuote } from "../services/exchangeRates.js";
import {
  buildChangedFields,
  buildExpenseSnapshot,
  buildTaskSnapshot,
  recordHistoryEvent,
  toIdString as historyToIdString
} from "../services/history.js";
import {
  attachEstimateGroupToTasks,
  buildEstimateGroupSnapshot,
  clearEstimateGroupFromTasks,
  deleteEstimateGroupAndClearTasks,
  toEstimateGroupResponse
} from "../services/estimateGroups.js";
import { syncTaskHierarchyState } from "../utils/taskHierarchy.js";

const router = Router();

const createEstimateGroupSchema = z.object({
  name: z.string().trim().min(1).max(160),
  totalAmount: z.coerce.number().min(0),
  currency: z.string().trim().min(3).max(3).optional(),
  taskIds: z.array(z.string()).min(2)
});

const updateEstimateGroupSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  totalAmount: z.coerce.number().min(0).optional(),
  currency: z.string().trim().min(3).max(3).optional(),
  recordPayment: z
    .object({
      amount: z.coerce.number().min(0),
      date: z.string().optional()
    })
    .optional(),
  taskAllocations: z
    .array(
      z.object({
        taskId: z.string(),
        estimateAmount: z.coerce.number().min(0)
      })
    )
    .optional()
});

function buildEstimateGroupScope(group: {
  phase?: string;
  phaseTaskId?: unknown;
  section?: string;
  sectionTaskId?: unknown;
}) {
  return {
    phase: group.phase ?? "",
    phaseTaskId: historyToIdString(group.phaseTaskId),
    section: group.section ?? "",
    sectionTaskId: historyToIdString(group.sectionTaskId)
  };
}

function normalizeEstimateGroupCurrency(value?: string): string {
  const normalized = (value ?? "USD").trim().toUpperCase();
  return normalized.length === 3 ? normalized : "USD";
}

function toMoney(value: number): number {
  return Number(Number(value ?? 0).toFixed(2));
}

async function resolveEstimateGroupCurrencyContext(input: {
  currency?: string;
  date?: string;
}) {
  const entryCurrency = normalizeEstimateGroupCurrency(input.currency);
  const effectiveDate = input.date ? new Date(input.date) : new Date();
  const resolvedDate = Number.isNaN(effectiveDate.getTime()) ? new Date() : effectiveDate;

  if (entryCurrency !== "JMD") {
    return {
      entryCurrency,
      totalAmountUsd: undefined as number | undefined,
      usdToEntryRate: 1,
      exchangeRateDate: resolvedDate.toISOString().slice(0, 10)
    };
  }

  const quote = await getJmdRateQuote({
    currency: "USD",
    date: resolvedDate
  });

  if (!quote || !Number.isFinite(quote.rate) || quote.rate <= 0) {
    throw new Error("Could not load the JMD exchange rate right now");
  }

  return {
    entryCurrency,
    totalAmountUsd: undefined as number | undefined,
    usdToEntryRate: quote.rate,
    exchangeRateDate: quote.rateDate
  };
}

function convertEstimateGroupEntryToUsd(amount: number, currencyContext: { entryCurrency: string; usdToEntryRate: number }) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }

  if (currencyContext.entryCurrency === "JMD") {
    return toMoney(amount / currencyContext.usdToEntryRate);
  }

  return toMoney(amount);
}

async function createEstimateGroupPaymentExpense(input: {
  estimateGroup: {
    _id?: unknown;
    name?: string;
    phase?: string;
    phaseTaskId?: unknown;
    section?: string;
    sectionTaskId?: unknown;
  };
  paymentEntry: {
    entryAmount?: number;
    amountUsd?: number;
    entryCurrency?: string;
    usdToEntryRate?: number;
    exchangeRateDate?: Date | string | null;
    recordedAt?: Date | string | null;
  };
  createdBy?: string;
}) {
  const recordedAt = input.paymentEntry.recordedAt ? new Date(input.paymentEntry.recordedAt) : new Date();
  const amountUsd = toMoney(Number(input.paymentEntry.amountUsd ?? 0));
  const entryAmount = toMoney(Number(input.paymentEntry.entryAmount ?? 0));
  const entryCurrency = normalizeEstimateGroupCurrency(input.paymentEntry.entryCurrency);
  const usdToEntryRate = toMoney(Number(input.paymentEntry.usdToEntryRate ?? 1));
  const exchangeRateDate =
    input.paymentEntry.exchangeRateDate instanceof Date
      ? input.paymentEntry.exchangeRateDate.toISOString().slice(0, 10)
      : typeof input.paymentEntry.exchangeRateDate === "string" && input.paymentEntry.exchangeRateDate
        ? input.paymentEntry.exchangeRateDate.slice(0, 10)
        : recordedAt.toISOString().slice(0, 10);

  return ExpenseModel.create({
    name: `${input.estimateGroup.name ?? "Grouped Estimate"} Payment`,
    category: "Labour Cost",
    amount: amountUsd,
    date: recordedAt,
    vendor: "",
    phase: input.estimateGroup.phase ?? "",
    phaseTaskId: input.estimateGroup.phaseTaskId,
    section: input.estimateGroup.section ?? "",
    sectionTaskId: input.estimateGroup.sectionTaskId,
    subsection: "",
    unit: "Payment",
    unitPrice: amountUsd,
    quantity: 1,
    notes:
      entryCurrency === "JMD"
        ? `Grouped estimate payment recorded in JMD ${entryAmount} at 1 USD = ${usdToEntryRate} JMD on ${exchangeRateDate}.`
        : `Grouped estimate payment recorded in USD ${entryAmount}.`,
    source: "estimate-group-payment",
    workerRole: "OTHER",
    createdBy: input.createdBy
  });
}

async function backfillEstimateGroupPaymentExpenses(
  estimateGroup: {
    paymentEntries?: Array<{
      entryAmount?: number;
      amountUsd?: number;
      entryCurrency?: string;
      usdToEntryRate?: number;
      exchangeRateDate?: Date | string | null;
      recordedAt?: Date | string | null;
      expenseId?: unknown;
    }>;
    save: () => Promise<unknown>;
    _id?: unknown;
    name?: string;
    phase?: string;
    phaseTaskId?: unknown;
    section?: string;
    sectionTaskId?: unknown;
  }
) {
  if (!Array.isArray(estimateGroup.paymentEntries) || estimateGroup.paymentEntries.length === 0) {
    return false;
  }

  let changed = false;

  for (const paymentEntry of estimateGroup.paymentEntries) {
    if (historyToIdString(paymentEntry?.expenseId)) {
      continue;
    }

    const amountUsd = toMoney(Number(paymentEntry?.amountUsd ?? 0));
    if (amountUsd <= 0) {
      continue;
    }

    const createdExpense = await createEstimateGroupPaymentExpense({
      estimateGroup,
      paymentEntry
    });

    paymentEntry.expenseId = createdExpense._id;
    changed = true;
  }

  if (changed) {
    await estimateGroup.save();
  }

  return changed;
}

async function loadGroupTasks(taskIds: string[]) {
  const tasks = await TaskModel.find({ _id: { $in: taskIds } }).sort({ sortOrder: 1, createdAt: 1 });
  const order = new Map(taskIds.map((taskId, index) => [taskId, index]));
  return [...tasks].sort(
    (left, right) => (order.get(historyToIdString(left._id)) ?? 0) - (order.get(historyToIdString(right._id)) ?? 0)
  );
}

function summarizeEstimateGroupUpdate(
  beforeSnapshot: ReturnType<typeof buildEstimateGroupSnapshot>,
  afterSnapshot: ReturnType<typeof buildEstimateGroupSnapshot>,
  allocationChangedCount: number
) {
  const currency = afterSnapshot.entryCurrency || "USD";
  const beforeEntryTotal = Number(beforeSnapshot.entryTotalAmount ?? beforeSnapshot.totalAmount ?? 0);
  const afterEntryTotal = Number(afterSnapshot.entryTotalAmount ?? afterSnapshot.totalAmount ?? 0);
  if (beforeSnapshot.totalAmount !== afterSnapshot.totalAmount) {
    return `Estimate group ${afterSnapshot.name} total updated from ${currency} ${beforeEntryTotal.toLocaleString()} to ${currency} ${afterEntryTotal.toLocaleString()}`;
  }

  if (beforeSnapshot.name !== afterSnapshot.name) {
    return `Estimate group renamed from ${beforeSnapshot.name} to ${afterSnapshot.name}`;
  }

  if (beforeSnapshot.paidAmount !== afterSnapshot.paidAmount) {
    const beforeEntryPaid = Number(beforeSnapshot.entryPaidAmount ?? 0);
    const afterEntryPaid = Number(afterSnapshot.entryPaidAmount ?? 0);
    return `Recorded grouped payment on ${afterSnapshot.name}: ${currency} ${afterEntryPaid.toLocaleString()} paid to date (${beforeEntryPaid.toLocaleString()} before)`;
  }

  if (allocationChangedCount > 0) {
    return `Estimate group ${afterSnapshot.name} allocations updated across ${allocationChangedCount} task(s)`;
  }

  return `Estimate group ${afterSnapshot.name} updated`;
}

router.get("/", async (req, res, next) => {
  try {
    const sectionTaskId = typeof req.query.sectionTaskId === "string" ? req.query.sectionTaskId.trim() : "";
    const filters: Record<string, unknown> = {};

    if (sectionTaskId) {
      filters.sectionTaskId = sectionTaskId;
    }

    const estimateGroups = await EstimateGroupModel.find(filters).sort({ updatedAt: -1, createdAt: -1 });
    let repairedPaymentExpenseCount = 0;
    for (const group of estimateGroups) {
      const repaired = await backfillEstimateGroupPaymentExpenses(group as any);
      if (repaired) {
        repairedPaymentExpenseCount += 1;
      }
    }
    res.json({
      repairedPaymentExpenseCount,
      estimateGroups: estimateGroups.map((group) => toEstimateGroupResponse(group))
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const operationId = randomUUID();
    const payload = createEstimateGroupSchema.parse(req.body);
    const uniqueTaskIds = [...new Set(payload.taskIds.map((taskId) => taskId.trim()).filter(Boolean))];
    const tasks = await loadGroupTasks(uniqueTaskIds);

    if (tasks.length !== uniqueTaskIds.length) {
      res.status(400).json({ message: "Some selected tasks could not be found" });
      return;
    }

    if (tasks.some((task) => task.nodeType !== "TASK")) {
      res.status(400).json({ message: "Only task items can be grouped into an estimate" });
      return;
    }

    const firstSectionTaskId = historyToIdString(tasks[0]?.sectionTaskId);
    const firstPhaseTaskId = historyToIdString(tasks[0]?.phaseTaskId);

    if (!firstSectionTaskId || !firstPhaseTaskId) {
      res.status(400).json({ message: "Selected tasks must belong to a valid phase section" });
      return;
    }

    const sameSection = tasks.every(
      (task) =>
        historyToIdString(task.sectionTaskId) === firstSectionTaskId &&
        historyToIdString(task.phaseTaskId) === firstPhaseTaskId
    );

    if (!sameSection) {
      res.status(400).json({ message: "Grouped estimates can only include tasks from the same section" });
      return;
    }

    const alreadyGroupedTask = tasks.find((task) => historyToIdString(task.estimateGroupId));
    if (alreadyGroupedTask) {
      res.status(400).json({ message: `${alreadyGroupedTask.title} is already part of another grouped estimate` });
      return;
    }

    const currencyContext = await resolveEstimateGroupCurrencyContext({
      currency: payload.currency
    });
    const totalAmountUsd = convertEstimateGroupEntryToUsd(payload.totalAmount, currencyContext);

    const estimateGroup = await EstimateGroupModel.create({
      name: payload.name,
      totalAmount: totalAmountUsd,
      entryTotalAmount: toMoney(payload.totalAmount),
      entryCurrency: currencyContext.entryCurrency,
      usdToEntryRate: currencyContext.usdToEntryRate,
      exchangeRateDate: new Date(currencyContext.exchangeRateDate),
      phase: tasks[0].phase ?? "",
      phaseTaskId: tasks[0].phaseTaskId,
      section: tasks[0].section ?? "",
      sectionTaskId: tasks[0].sectionTaskId,
      taskIds: tasks.map((task) => task._id),
      createdBy: req.user?.id
    });

    await attachEstimateGroupToTasks(historyToIdString(estimateGroup._id), uniqueTaskIds);
    await syncTaskHierarchyState();

    await recordHistoryEvent({
      operationId,
      entityType: "ESTIMATE_GROUP",
      entityId: historyToIdString(estimateGroup._id),
      entityLabel: estimateGroup.name,
      action: "CREATE",
      summary: `Estimate group ${estimateGroup.name} created for ${tasks.length} task(s)`,
      actor: req.user,
      scope: buildEstimateGroupScope(estimateGroup),
      after: buildEstimateGroupSnapshot(estimateGroup, tasks),
      moneyImpact: {
        label: "Grouped Estimate Total",
        before: 0,
        currency: "USD",
        after: Number(estimateGroup.totalAmount ?? 0)
      },
      metadata: {
        taskIds: uniqueTaskIds,
        entryCurrency: currencyContext.entryCurrency,
        entryTotalAmount: toMoney(payload.totalAmount),
        usdToEntryRate: currencyContext.usdToEntryRate,
        exchangeRateDate: currencyContext.exchangeRateDate
      }
    });

    res.status(201).json({ estimateGroup: toEstimateGroupResponse(estimateGroup) });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const operationId = randomUUID();
    const payload = updateEstimateGroupSchema.parse(req.body);
    const estimateGroup = await EstimateGroupModel.findById(req.params.id);

    if (!estimateGroup) {
      res.status(404).json({ message: "Estimate group not found" });
      return;
    }

    const groupTaskIds = estimateGroup.taskIds.map((taskId) => historyToIdString(taskId)).filter(Boolean);
    const currentTasks = await loadGroupTasks(groupTaskIds);
    const beforeSnapshot = buildEstimateGroupSnapshot(estimateGroup, currentTasks);
    const taskMap = new Map(currentTasks.map((task) => [historyToIdString(task._id), task]));
    let allocationChangedCount = 0;

    if (payload.name !== undefined) {
      estimateGroup.name = payload.name;
    }

    if (payload.totalAmount !== undefined || payload.currency !== undefined) {
      const entryCurrency = payload.currency !== undefined ? payload.currency : estimateGroup.entryCurrency;
      const entryTotalAmount = payload.totalAmount !== undefined ? payload.totalAmount : Number(estimateGroup.entryTotalAmount ?? estimateGroup.totalAmount ?? 0);
      const currencyContext = await resolveEstimateGroupCurrencyContext({
        currency: entryCurrency
      });
      estimateGroup.totalAmount = convertEstimateGroupEntryToUsd(entryTotalAmount, currencyContext);
      estimateGroup.entryTotalAmount = toMoney(entryTotalAmount);
      estimateGroup.entryCurrency = currencyContext.entryCurrency;
      estimateGroup.usdToEntryRate = currencyContext.usdToEntryRate;
      estimateGroup.exchangeRateDate = new Date(currencyContext.exchangeRateDate);
    }

    if (payload.recordPayment && payload.recordPayment.amount > 0) {
      const paymentContext = await resolveEstimateGroupCurrencyContext({
        currency: estimateGroup.entryCurrency,
        date: payload.recordPayment.date
      });
      const recordedAt = payload.recordPayment.date ? new Date(payload.recordPayment.date) : new Date();
      const amountUsd = convertEstimateGroupEntryToUsd(payload.recordPayment.amount, paymentContext);
      const createdExpense = await createEstimateGroupPaymentExpense({
        estimateGroup,
        paymentEntry: {
          entryAmount: toMoney(payload.recordPayment.amount),
          amountUsd,
          entryCurrency: paymentContext.entryCurrency,
          usdToEntryRate: paymentContext.usdToEntryRate,
          exchangeRateDate: paymentContext.exchangeRateDate,
          recordedAt
        },
        createdBy: req.user?.id
      });
      const createdExpenseSnapshot = buildExpenseSnapshot(createdExpense);
      await recordHistoryEvent({
        operationId,
        entityType: "EXPENSE",
        entityId: historyToIdString(createdExpense._id),
        entityLabel: createdExpense.name,
        action: "CREATE",
        summary: `Expense ${createdExpense.name} created from grouped payment`,
        actor: req.user,
        scope: buildEstimateGroupScope(estimateGroup),
        after: createdExpenseSnapshot,
        moneyImpact: {
          label: "Expense Amount",
          currency: "USD",
          before: 0,
          after: Number(createdExpenseSnapshot.amount ?? 0)
        },
        metadata: {
          estimateGroupId: historyToIdString(estimateGroup._id),
          estimateGroupName: estimateGroup.name,
          category: "Labour Cost",
          entryCurrency: paymentContext.entryCurrency,
          entryAmount: toMoney(payload.recordPayment.amount),
          usdToEntryRate: paymentContext.usdToEntryRate,
          exchangeRateDate: paymentContext.exchangeRateDate
        }
      });
      const paymentEntry = {
        entryAmount: toMoney(payload.recordPayment.amount),
        amountUsd,
        entryCurrency: paymentContext.entryCurrency,
        usdToEntryRate: paymentContext.usdToEntryRate,
        exchangeRateDate: new Date(paymentContext.exchangeRateDate),
        recordedAt,
        recordedBy: req.user?.id,
        expenseId: createdExpense._id
      };
      estimateGroup.paymentEntries = [...(estimateGroup.paymentEntries ?? []), paymentEntry] as any;
    }

    if (payload.taskAllocations) {
      for (const allocation of payload.taskAllocations) {
        const task = taskMap.get(allocation.taskId);
        if (!task) {
          res.status(400).json({ message: "Estimate allocations must target tasks already in the group" });
          return;
        }
      }

      for (const allocation of payload.taskAllocations) {
        const task = taskMap.get(allocation.taskId);
        if (!task) {
          continue;
        }

        const nextEstimate = Number(allocation.estimateAmount ?? 0);
        const currentEstimate = Number(task.estimateAmount ?? task.budgetImpact ?? 0);
        if (currentEstimate === nextEstimate) {
          continue;
        }

        const beforeTaskSnapshot = buildTaskSnapshot(task);
        task.estimateAmount = nextEstimate;
        task.budgetImpact = nextEstimate;
        await task.save();
        allocationChangedCount += 1;

        const afterTaskSnapshot = buildTaskSnapshot(task);
      await recordHistoryEvent({
        operationId,
        entityType: "TASK",
          entityId: historyToIdString(task._id),
          entityLabel: task.title,
          action: "UPDATE",
          summary: `Estimate updated for ${task.title} from $${Number(beforeTaskSnapshot.estimateAmount ?? 0).toLocaleString()} to $${Number(afterTaskSnapshot.estimateAmount ?? 0).toLocaleString()}`,
          actor: req.user,
          scope: {
            phase: task.phase ?? "",
            phaseTaskId: historyToIdString(task.phaseTaskId),
            section: task.section ?? "",
            sectionTaskId: historyToIdString(task.sectionTaskId),
            subsection: task.title ?? "",
            subsectionTaskId: historyToIdString(task._id)
          },
          before: beforeTaskSnapshot,
          after: afterTaskSnapshot,
          changedFields: buildChangedFields(beforeTaskSnapshot, afterTaskSnapshot),
          moneyImpact: {
            label: "Task Estimate",
            before: Number(beforeTaskSnapshot.estimateAmount ?? 0),
            after: Number(afterTaskSnapshot.estimateAmount ?? 0)
          },
          metadata: {
            estimateGroupId: historyToIdString(estimateGroup._id),
            estimateGroupName: estimateGroup.name
          }
        });
      }
    }

    await estimateGroup.save();
    await syncTaskHierarchyState();

    const refreshedTasks = await loadGroupTasks(groupTaskIds);
    const afterSnapshot = buildEstimateGroupSnapshot(estimateGroup, refreshedTasks);
    const changedFields = buildChangedFields(beforeSnapshot, afterSnapshot);

    if (changedFields.length > 0 || allocationChangedCount > 0) {
      await recordHistoryEvent({
        operationId,
        entityType: "ESTIMATE_GROUP",
        entityId: historyToIdString(estimateGroup._id),
        entityLabel: estimateGroup.name,
        action: "UPDATE",
        summary: summarizeEstimateGroupUpdate(beforeSnapshot, afterSnapshot, allocationChangedCount),
        actor: req.user,
        scope: buildEstimateGroupScope(estimateGroup),
        before: beforeSnapshot,
        after: afterSnapshot,
        changedFields,
        moneyImpact:
          beforeSnapshot.totalAmount !== afterSnapshot.totalAmount || beforeSnapshot.paidAmount !== afterSnapshot.paidAmount
            ? {
                label:
                  beforeSnapshot.paidAmount !== afterSnapshot.paidAmount
                    ? "Grouped Payment Recorded"
                    : "Grouped Estimate Total",
                currency: "USD",
                before:
                  beforeSnapshot.paidAmount !== afterSnapshot.paidAmount
                    ? Number(beforeSnapshot.paidAmount ?? 0)
                    : Number(beforeSnapshot.totalAmount ?? 0),
                after:
                  beforeSnapshot.paidAmount !== afterSnapshot.paidAmount
                    ? Number(afterSnapshot.paidAmount ?? 0)
                    : Number(afterSnapshot.totalAmount ?? 0)
              }
            : undefined,
        metadata: {
          allocationChangedCount,
          category: payload.recordPayment && payload.recordPayment.amount > 0 ? "Labour Cost" : undefined,
          entryCurrency: afterSnapshot.entryCurrency,
          entryTotalAmount: afterSnapshot.entryTotalAmount,
          entryPaidAmount: afterSnapshot.entryPaidAmount,
          usdToEntryRate: afterSnapshot.usdToEntryRate,
          exchangeRateDate: afterSnapshot.exchangeRateDate,
          latestPayment:
            payload.recordPayment && payload.recordPayment.amount > 0
              ? {
                  entryAmount: toMoney(payload.recordPayment.amount),
                  amountUsd:
                    Number(afterSnapshot.paidAmount ?? 0) - Number(beforeSnapshot.paidAmount ?? 0),
                  entryCurrency: afterSnapshot.entryCurrency,
                  usdToEntryRate: afterSnapshot.usdToEntryRate,
                  exchangeRateDate: afterSnapshot.exchangeRateDate,
                  recordedAt: payload.recordPayment.date ?? new Date().toISOString()
                }
              : undefined
        }
      });
    }

    res.json({ estimateGroup: toEstimateGroupResponse(estimateGroup) });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const operationId = randomUUID();
    const estimateGroup = await EstimateGroupModel.findById(req.params.id);

    if (!estimateGroup) {
      res.status(404).json({ message: "Estimate group not found" });
      return;
    }

    const groupTaskIds = estimateGroup.taskIds.map((taskId) => historyToIdString(taskId)).filter(Boolean);
    const groupTasks = await loadGroupTasks(groupTaskIds);
    const beforeSnapshot = buildEstimateGroupSnapshot(estimateGroup, groupTasks);

    await deleteEstimateGroupAndClearTasks(req.params.id);
    await syncTaskHierarchyState();

    await recordHistoryEvent({
      operationId,
      entityType: "ESTIMATE_GROUP",
      entityId: historyToIdString(estimateGroup._id),
      entityLabel: estimateGroup.name,
      action: "DELETE",
      summary: `Estimate group ${estimateGroup.name} dissolved`,
      actor: req.user,
      scope: buildEstimateGroupScope(estimateGroup),
      before: beforeSnapshot,
      metadata: {
        taskIds: groupTaskIds
      }
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
