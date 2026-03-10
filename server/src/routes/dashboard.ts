import { Router } from "express";
import { ExpenseModel } from "../models/Expense.js";
import { InvoiceModel } from "../models/Invoice.js";
import { TaskModel } from "../models/Task.js";
import { ensureProject } from "../utils/ensureProject.js";

const router = Router();

router.get("/summary", async (_req, res, next) => {
  try {
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
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      InvoiceModel.aggregate([
        { $match: { status: "UNPAID" } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } }
      ])
    ]);

    const totalSpent = spendTotals[0]?.total ?? 0;
    const unpaidCommitted = unpaidInvoiceTotals[0]?.total ?? 0;
    const unpaidInvoiceCount = unpaidInvoiceTotals[0]?.count ?? 0;
    const remainingBudget = project.totalBudget - totalSpent;
    const remainingAfterCommitments = project.totalBudget - totalSpent - unpaidCommitted;

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
      categoryTotals: categoryTotals.map((entry) => ({
        category: entry._id || "Uncategorized",
        total: entry.total
      })),
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