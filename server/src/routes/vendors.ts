import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { VendorModel } from "../models/Vendor.js";

const router = Router();

const vendorPayloadSchema = z.object({
  name: z.string().min(1)
});

router.get("/", async (_req, res, next) => {
  try {
    const vendors = await VendorModel.find().sort({ name: 1 });
    res.json({ vendors });
  } catch (error) {
    next(error);
  }
});

router.post("/", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const payload = vendorPayloadSchema.parse(req.body);
    const normalizedName = payload.name.trim();

    const existingVendor = await VendorModel.findOne({
      name: { $regex: `^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" }
    });

    if (existingVendor) {
      res.status(409).json({ message: "Vendor already exists" });
      return;
    }

    const vendor = await VendorModel.create({
      name: normalizedName,
      createdBy: req.user?.id
    });

    res.status(201).json({ vendor });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireRole("OWNER", "CONTRACTOR"), async (req, res, next) => {
  try {
    const deleted = await VendorModel.findByIdAndDelete(req.params.id);

    if (!deleted) {
      res.status(404).json({ message: "Vendor not found" });
      return;
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
