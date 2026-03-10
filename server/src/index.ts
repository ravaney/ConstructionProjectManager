import "dotenv/config";
import path from "node:path";
import cors from "cors";
import express from "express";
import { connectDatabase } from "./db.js";
import { env } from "./env.js";
import { requireAuth } from "./middleware/auth.js";
import authRoutes from "./routes/auth.js";
import attachmentRoutes from "./routes/attachments.js";
import dashboardRoutes from "./routes/dashboard.js";
import expenseRoutes from "./routes/expenses.js";
import invoiceRoutes from "./routes/invoices.js";
import projectRoutes from "./routes/project.js";
import reportRoutes from "./routes/reports.js";
import taskRoutes from "./routes/tasks.js";
import vendorRoutes from "./routes/vendors.js";
import workerRoutes from "./routes/workers.js";
import { getUploadDirectory } from "./services/fileStorage.js";

const app = express();

app.use(
  cors({
    origin: env.CLIENT_ORIGIN.split(",").map((origin) => origin.trim())
  })
);
app.use(express.json({ limit: "1mb" }));

app.use("/uploads", express.static(path.resolve(getUploadDirectory())));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRoutes);
app.use("/api/dashboard", requireAuth, dashboardRoutes);
app.use("/api/expenses", requireAuth, expenseRoutes);
app.use("/api/invoices", requireAuth, invoiceRoutes);
app.use("/api/workers", requireAuth, workerRoutes);
app.use("/api/vendors", requireAuth, vendorRoutes);
app.use("/api/tasks", requireAuth, taskRoutes);
app.use("/api/project", requireAuth, projectRoutes);
app.use("/api/attachments", requireAuth, attachmentRoutes);
app.use("/api/reports", requireAuth, reportRoutes);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error && typeof error === "object" && "issues" in error) {
    res.status(400).json({ message: "Validation failed", details: error });
    return;
  }

  console.error(error);
  res.status(500).json({ message: "Something went wrong" });
});

async function start() {
  await connectDatabase();

  app.listen(env.PORT, () => {
    console.log(`Server running on http://localhost:${env.PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
