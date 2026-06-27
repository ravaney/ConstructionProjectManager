import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { answerProjectAssistantQuestion } from "../services/projectAssistant.js";
import {
  applyPhaseAnalysis,
  phaseAnalysisApplyOperationSchema,
  suggestPhaseAnalysisPrompts,
  previewPhaseAnalysis
} from "../services/phaseAnalysis.js";

const router = Router();

const assistantChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(12000)
      })
    )
    .min(1)
    .max(40),
  activeTab: z.string().trim().max(64).optional(),
  model: z.string().trim().min(1).max(80).optional()
});

const phaseAnalysisPreviewSchema = z.object({
  phaseTaskId: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(5).max(6000),
  model: z.string().trim().min(1).max(80).optional()
});

const phaseAnalysisSuggestionsSchema = z.object({
  phaseTaskId: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(80).optional()
});

const phaseAnalysisApplySchema = z.object({
  phaseTaskId: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(2000),
  operations: z.array(phaseAnalysisApplyOperationSchema).min(1).max(80)
});

router.post("/chat", async (req, res, next) => {
  try {
    const payload = assistantChatSchema.parse(req.body);
    const result = await answerProjectAssistantQuestion({
      messages: payload.messages,
      activeTab: payload.activeTab,
      model: payload.model
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/phase-analysis/preview", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = phaseAnalysisPreviewSchema.parse(req.body);
    const result = await previewPhaseAnalysis({
      phaseTaskId: payload.phaseTaskId,
      instruction: payload.instruction,
      model: payload.model
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/phase-analysis/suggestions", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = phaseAnalysisSuggestionsSchema.parse(req.body);
    const result = await suggestPhaseAnalysisPrompts({
      phaseTaskId: payload.phaseTaskId,
      model: payload.model
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/phase-analysis/apply", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = phaseAnalysisApplySchema.parse(req.body);
    const result = await applyPhaseAnalysis({
      phaseTaskId: payload.phaseTaskId,
      summary: payload.summary,
      operations: payload.operations,
      actor: req.user
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
