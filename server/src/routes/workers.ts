import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { WorkerProfileModel } from "../models/WorkerProfile.js";

const router = Router();

const workerRoleSchema = z
  .enum(["PLUMBER", "ELECTRICIAN", "CONTRACTOR", "STEELWORKER", "CARPENTER", "MASON", "LABORER", "OTHER"])
  .or(z.literal("STEEL_MAN"))
  .transform((role) => (role === "STEEL_MAN" ? "STEELWORKER" : role));

const workerPayloadSchema = z.object({
  name: z.string().min(1),
  role: workerRoleSchema,
  phone: z.string().optional(),
  email: z.string().optional(),
  company: z.string().optional(),
  notes: z.string().optional(),
  isActive: z.boolean().optional()
});

router.get("/", async (_req, res, next) => {
  try {
    const workers = await WorkerProfileModel.find().sort({ name: 1 });
    res.json({
      workers: workers.map((worker) => {
        const document = worker.toObject();
        return {
          ...document,
          role: document.role === "STEEL_MAN" ? "STEELWORKER" : document.role
        };
      })
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = workerPayloadSchema.parse(req.body);
    const worker = await WorkerProfileModel.create({
      ...payload,
      phone: payload.phone ?? "",
      email: payload.email ?? "",
      company: payload.company ?? "",
      notes: payload.notes ?? "",
      isActive: payload.isActive ?? true,
      createdBy: req.user?.id
    });

    res.status(201).json({ worker });
  } catch (error) {
    next(error);
  }
});

router.put("/:id", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = workerPayloadSchema.partial().parse(req.body);
    const worker = await WorkerProfileModel.findByIdAndUpdate(req.params.id, payload, { new: true });

    if (!worker) {
      res.status(404).json({ message: "Worker profile not found" });
      return;
    }

    res.json({ worker });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireRole("OWNER"), async (req, res, next) => {
  try {
    const deleted = await WorkerProfileModel.findByIdAndDelete(req.params.id);

    if (!deleted) {
      res.status(404).json({ message: "Worker profile not found" });
      return;
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
