import { Router } from "express";
import { ExpenseModel } from "../models/Expense.js";
import { InvoiceModel } from "../models/Invoice.js";
import { TaskModel } from "../models/Task.js";
import { ensureProject } from "../utils/ensureProject.js";
import { syncTaskHierarchyState } from "../utils/taskHierarchy.js";

const router = Router();

function normalizeDashboardCategory(category?: string): string {
  const normalized = (category ?? "").trim();
  if (!normalized) {
    return "Uncategorized";
  }

  if (/^materials(?:\s*\/.*)?$/i.test(normalized)) {
    return "Materials";
  }

  if (normalized === "Labor Cost") {
    return "Labour Cost";
  }

  if (normalized.startsWith("Labor Cost /")) {
    return normalized.replace("Labor Cost /", "Labour Cost /").trim();
  }

  return normalized;
}

router.get("/summary", async (_req, res, next) => {
  try {
    await syncTaskHierarchyState();
    const project = await ensureProject();

    const [spendTotals, categoryTotals, monthlySpend, taskCounts, unpaidInvoiceTotals] = await Promise.all([
      ExpenseModel.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]),
      ExpenseModel.aggregate([
        { $group: { _id: "$category", total: { $sum: "$amount" } } },
        { $sort: { total: -1 } }
      ]),
      ExpenseModel.aggregate([
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$date" } },
            total: { $sum: "$amount" }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      TaskModel.aggregate([
        {
          $match: {
            $or: [{ nodeType: "TASK" }, { nodeType: { $exists: false } }]
          }
        },
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      InvoiceModel.aggregate([
        { $match: { status: { $in: ["UNPAID", "PARTIALLY_PAID"] } } },
        {
          $project: {
            openBalance: {
              $max: [{ $subtract: ["$totalAmount", "$paidAmount"] }, 0]
            }
          }
        },
        { $group: { _id: null, total: { $sum: "$openBalance" }, count: { $sum: 1 } } }
      ])
    ]);

    const totalSpent = spendTotals[0]?.total ?? 0;
    const unpaidCommitted = unpaidInvoiceTotals[0]?.total ?? 0;
    const unpaidInvoiceCount = unpaidInvoiceTotals[0]?.count ?? 0;
    const remainingBudget = project.totalBudget - totalSpent;
    const remainingAfterCommitments = project.totalBudget - totalSpent - unpaidCommitted;
    const mergedCategoryTotals = Array.from(
      categoryTotals.reduce<Map<string, number>>((map, entry) => {
        const category = normalizeDashboardCategory(entry._id);
        const currentTotal = map.get(category) ?? 0;
        map.set(category, currentTotal + Number(entry.total ?? 0));
        return map;
      }, new Map<string, number>())
    )
      .map(([category, total]: [string, number]) => ({
        category,
        total
      }))
      .sort((a, b) => b.total - a.total);

    res.json({
      project,
      metrics: {
        totalBudget: project.totalBudget,
        totalSpent,
        unpaidCommitted,
        unpaidInvoiceCount,
        remainingBudget,
        remainingAfterCommitments,
        burnRate: project.totalBudget > 0 ? Number(((totalSpent / project.totalBudget) * 100).toFixed(2)) : 0
      },
      categoryTotals: mergedCategoryTotals,
      monthlySpend: monthlySpend.map((entry) => ({
        month: entry._id,
        total: entry.total
      })),
      taskCounts
    });
  } catch (error) {
    next(error);
  }
});

export default router;
