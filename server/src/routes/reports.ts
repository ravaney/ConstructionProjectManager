import { Router } from "express";
import PDFDocument from "pdfkit";
import { z } from "zod";
import { ExpenseModel } from "../models/Expense.js";
import { ensureProject } from "../utils/ensureProject.js";

const router = Router();

const monthQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional()
});

function parseMonthRange(monthInput?: string): { monthLabel: string; start: Date; end: Date } {
  const now = new Date();
  const [year, month] = (monthInput ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`)
    .split("-")
    .map((part) => Number(part));

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { monthLabel: `${year}-${String(month).padStart(2, "0")}`, start, end };
}

function toCsvValue(value: string | number): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

router.get("/monthly.csv", async (req, res, next) => {
  try {
    const { month } = monthQuerySchema.parse(req.query);
    const range = parseMonthRange(month);

    const expenses = await ExpenseModel.find({
      date: { $gte: range.start, $lt: range.end }
    }).sort({ date: 1, createdAt: 1 });

    const rows = [
      ["Date", "Item", "Category", "Amount", "Vendor", "Phase"],
      ...expenses.map((expense) => [
        new Date(expense.date).toISOString().slice(0, 10),
        expense.name,
        expense.category,
        expense.amount.toFixed(2),
        expense.vendor || "",
        expense.phase || ""
      ])
    ];

    const csv = rows.map((row) => row.map((value) => toCsvValue(value)).join(",")).join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=construction-report-${range.monthLabel}.csv`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

router.get("/monthly.pdf", async (req, res, next) => {
  try {
    const { month } = monthQuerySchema.parse(req.query);
    const range = parseMonthRange(month);

    const expenses = await ExpenseModel.find({
      date: { $gte: range.start, $lt: range.end }
    }).sort({ date: 1, createdAt: 1 });

    const total = expenses.reduce((sum, item) => sum + item.amount, 0);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=construction-report-${range.monthLabel}.pdf`);

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    doc.fontSize(18).text("Dream Home Construction Monthly Report");
    doc.moveDown(0.5);
    doc.fontSize(11).text(`Month: ${range.monthLabel}`);
    doc.text(`Records: ${expenses.length}`);
    doc.text(`Total Spend: $${total.toFixed(2)}`);

    doc.moveDown();
    doc.fontSize(12).text("Expense Items", { underline: true });
    doc.moveDown(0.5);

    const preview = expenses.slice(0, 40);
    preview.forEach((expense) => {
      doc
        .fontSize(10)
        .text(
          `${new Date(expense.date).toISOString().slice(0, 10)}  |  ${expense.name}  |  ${expense.category}  |  $${expense.amount.toFixed(2)}`
        );
    });

    if (expenses.length > 40) {
      doc.moveDown(0.5);
      doc.fontSize(10).text(`+ ${expenses.length - 40} more rows not shown in preview.`);
    }

    doc.end();
  } catch (error) {
    next(error);
  }
});

router.get("/alerts", async (_req, res, next) => {
  try {
    const project = await ensureProject();

    const [spendTotals, categoryTotals, monthlySpend] = await Promise.all([
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
        { $sort: { _id: -1 } }
      ])
    ]);

    const totalSpent = spendTotals[0]?.total ?? 0;
    const burnRate = project.totalBudget > 0 ? (totalSpent / project.totalBudget) * 100 : 0;

    const alerts: Array<{ severity: "INFO" | "WARN" | "CRITICAL"; message: string }> = [];

    if (totalSpent > project.totalBudget) {
      alerts.push({
        severity: "CRITICAL",
        message: `Budget exceeded by $${(totalSpent - project.totalBudget).toFixed(2)}.`
      });
    } else if (burnRate >= 90) {
      alerts.push({
        severity: "WARN",
        message: `Budget burn rate is ${burnRate.toFixed(1)}%. You are close to budget cap.`
      });
    } else if (burnRate >= 75) {
      alerts.push({
        severity: "INFO",
        message: `Budget burn rate is ${burnRate.toFixed(1)}%. Monitor upcoming commitments.`
      });
    }

    const highCategory = categoryTotals.find((entry) => entry.total > project.totalBudget * 0.35);
    if (highCategory) {
      alerts.push({
        severity: "WARN",
        message: `${highCategory._id} has consumed $${highCategory.total.toFixed(2)} of total budget.`
      });
    }

    if (monthlySpend.length >= 2) {
      const current = monthlySpend[0].total;
      const previous = monthlySpend[1].total;

      if (previous > 0 && current > previous * 1.3) {
        alerts.push({
          severity: "WARN",
          message: `Monthly spend increased by ${(((current - previous) / previous) * 100).toFixed(1)}% compared to last month.`
        });
      }
    }

    res.json({
      generatedAt: new Date().toISOString(),
      alerts
    });
  } catch (error) {
    next(error);
  }
});

export default router;