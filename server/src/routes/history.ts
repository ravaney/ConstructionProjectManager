import { Router } from "express";
import { z } from "zod";
import { HistoryEntryModel } from "../models/HistoryEntry.js";
import { buildHistoricalJmdConversion } from "../services/exchangeRates.js";

const router = Router();

const historyQuerySchema = z.object({
  entityType: z.enum(["PROJECT", "TASK", "EXPENSE", "INVOICE", "ESTIMATE_GROUP", "ALL"]).optional(),
  action: z
    .enum(["CREATE", "UPDATE", "DELETE", "STATUS_CHANGE", "MARK_PAID", "BUDGET_CHANGE", "BUILD_PLAN", "CLEAR_PHASES", "ALL"])
    .optional(),
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  moneyOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

router.get("/", async (req, res, next) => {
  try {
    const query = historyQuerySchema.parse(req.query);
    const filters: Record<string, unknown> = {};

    if (query.entityType && query.entityType !== "ALL") {
      filters.entityType = query.entityType;
    }

    if (query.action && query.action !== "ALL") {
      filters.action = query.action;
    }

    if (query.moneyOnly) {
      filters.moneyImpact = { $exists: true };
    }

    if (query.from || query.to) {
      filters.createdAt = {};
      if (query.from) {
        (filters.createdAt as Record<string, unknown>).$gte = new Date(query.from);
      }
      if (query.to) {
        (filters.createdAt as Record<string, unknown>).$lte = new Date(query.to);
      }
    }

    if (query.search?.trim()) {
      const regex = new RegExp(query.search.trim(), "i");
      filters.$or = [{ summary: regex }, { entityLabel: regex }, { "actor.name": regex }];
    }

    const historyDocuments = await HistoryEntryModel.find(filters).sort({ createdAt: -1 }).limit(query.limit);
    const entries = await Promise.all(
      historyDocuments.map(async (entryDocument) => {
        const entry = entryDocument.toObject();
        if (!entry.moneyImpact) {
          return entry;
        }

        const conversion = await buildHistoricalJmdConversion({
          date: entry.createdAt,
          currency: entry.moneyImpact.currency,
          before: Number(entry.moneyImpact.before ?? 0),
          after: Number(entry.moneyImpact.after ?? 0)
        });

        if (!conversion) {
          return entry;
        }

        return {
          ...entry,
          moneyImpact: {
            ...entry.moneyImpact,
            jmdConversion: conversion
          }
        };
      })
    );

    res.json({ entries });
  } catch (error) {
    next(error);
  }
});

export default router;
