import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { getJmdRateQuote } from "../services/exchangeRates.js";
import { buildChangedFields, buildProjectSnapshot, recordHistoryEvent } from "../services/history.js";
import { ensureProject } from "../utils/ensureProject.js";

const router = Router();

const floorPlanMarkupSchema = z.object({
  plans: z
    .array(
      z.object({
        attachmentId: z.string().min(1),
        name: z.string().trim().min(1),
        strokes: z.array(
          z.object({
            color: z.string().min(1),
            width: z.coerce.number().min(1).max(32),
            points: z.array(
              z.object({
                x: z.coerce.number().min(0).max(1),
                y: z.coerce.number().min(0).max(1)
              })
            )
          })
        )
      })
    )
    .optional(),
  strokes: z
    .array(
      z.object({
        color: z.string().min(1),
        width: z.coerce.number().min(1).max(32),
        points: z.array(
          z.object({
            x: z.coerce.number().min(0).max(1),
            y: z.coerce.number().min(0).max(1)
          })
        )
      })
    )
    .optional()
});

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  phase: z.string().min(1).optional(),
  totalBudget: z.coerce.number().positive().optional(),
  currency: z.string().min(3).max(3).optional(),
  notes: z.string().optional(),
  floorPlanMarkup: floorPlanMarkupSchema.optional()
});

router.get("/", async (_req, res, next) => {
  try {
    const project = await ensureProject();
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

router.get("/fx-rate", async (req, res, next) => {
  try {
    const query = z
      .object({
        currency: z.string().min(3).max(3).optional(),
        date: z.string().optional()
      })
      .parse(req.query);

    const quote = await getJmdRateQuote({
      currency: query.currency ?? "USD",
      date: query.date ?? new Date()
    });

    if (!quote) {
      res.status(503).json({ message: "Could not load JMD exchange rate right now" });
      return;
    }

    res.json({ quote });
  } catch (error) {
    next(error);
  }
});

router.put("/", requireRole("OWNER"), async (req, res, next) => {
  try {
    const payload = updateProjectSchema.parse(req.body);
    const project = await ensureProject();
    const beforeSnapshot = buildProjectSnapshot(project);

    project.name = payload.name ?? project.name;
    project.phase = payload.phase ?? project.phase;
    project.totalBudget = payload.totalBudget ?? project.totalBudget;
    project.currency = payload.currency ?? project.currency;
    project.notes = payload.notes ?? project.notes;
    if (payload.floorPlanMarkup) {
      project.floorPlanMarkup = {
        plans: payload.floorPlanMarkup.plans ?? project.floorPlanMarkup?.plans ?? [],
        strokes: payload.floorPlanMarkup.strokes ?? project.floorPlanMarkup?.strokes ?? []
      } as typeof project.floorPlanMarkup;
    }

    await project.save();
    const afterSnapshot = buildProjectSnapshot(project);
    const changedFields = buildChangedFields(beforeSnapshot, afterSnapshot, [
      "name",
      "phase",
      "totalBudget",
      "currency",
      "notes",
      "floorPlanPlanCount"
    ]);
    const budgetChanged = beforeSnapshot.totalBudget !== afterSnapshot.totalBudget;
    await recordHistoryEvent({
      entityType: "PROJECT",
      entityId: String(project._id),
      entityLabel: project.name,
      action: budgetChanged ? "BUDGET_CHANGE" : "UPDATE",
      summary: budgetChanged
        ? `Project budget changed from ${beforeSnapshot.currency} ${beforeSnapshot.totalBudget} to ${afterSnapshot.currency} ${afterSnapshot.totalBudget}`
        : `Project settings updated for ${project.name}`,
      actor: req.user,
      before: beforeSnapshot,
      after: afterSnapshot,
      changedFields,
      moneyImpact: budgetChanged
        ? {
            label: "Project Budget",
            currency: String(afterSnapshot.currency ?? beforeSnapshot.currency ?? "USD"),
            before: Number(beforeSnapshot.totalBudget ?? 0),
            after: Number(afterSnapshot.totalBudget ?? 0)
          }
        : undefined,
      metadata: {
        updatedFields: changedFields.map((field) => field.field)
      }
    });
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

export default router;
