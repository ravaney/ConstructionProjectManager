import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { UserModel } from "../models/User.js";
import { signToken } from "../services/authToken.js";

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["OWNER", "CONTRACTOR"]).optional()
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

function toUserDto(user: { _id: unknown; name: string; email: string; role: "OWNER" | "CONTRACTOR" }) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role
  };
}

router.post("/register", async (req, res, next) => {
  try {
    const payload = registerSchema.parse(req.body);
    const userCount = await UserModel.countDocuments();

    if (userCount > 0) {
      res.status(409).json({ message: "Owner account already exists. Login and use add-user endpoint." });
      return;
    }

    const existingUser = await UserModel.findOne({ email: payload.email.toLowerCase() });
    if (existingUser) {
      res.status(409).json({ message: "A user with this email already exists" });
      return;
    }

    const passwordHash = await bcrypt.hash(payload.password, 10);

    const user = await UserModel.create({
      name: payload.name,
      email: payload.email.toLowerCase(),
      passwordHash,
      role: "OWNER"
    });

    const dto = toUserDto(user);
    const token = signToken(dto);

    res.status(201).json({ user: dto, token });
  } catch (error) {
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const payload = loginSchema.parse(req.body);

    const user = await UserModel.findOne({ email: payload.email.toLowerCase() });
    if (!user) {
      res.status(401).json({ message: "Invalid email or password" });
      return;
    }

    const ok = await bcrypt.compare(payload.password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ message: "Invalid email or password" });
      return;
    }

    const dto = toUserDto(user);
    const token = signToken(dto);

    res.json({ user: dto, token });
  } catch (error) {
    next(error);
  }
});

router.get("/me", requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

router.get("/users", requireAuth, requireRole("OWNER"), async (_req, res, next) => {
  try {
    const users = await UserModel.find({}, { passwordHash: 0 }).sort({ createdAt: -1 });
    res.json({
      users: users.map((user) =>
        toUserDto(user as unknown as { _id: unknown; name: string; email: string; role: "OWNER" | "CONTRACTOR" })
      )
    });
  } catch (error) {
    next(error);
  }
});

router.post("/users", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const payload = registerSchema.parse(req.body);

    const existingUser = await UserModel.findOne({ email: payload.email.toLowerCase() });
    if (existingUser) {
      res.status(409).json({ message: "A user with this email already exists" });
      return;
    }

    const passwordHash = await bcrypt.hash(payload.password, 10);

    const user = await UserModel.create({
      name: payload.name,
      email: payload.email.toLowerCase(),
      passwordHash,
      role: payload.role ?? "CONTRACTOR"
    });

    res.status(201).json({ user: toUserDto(user) });
  } catch (error) {
    next(error);
  }
});

export default router;