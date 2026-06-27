import "dotenv/config";
import path from "node:path";
import cors from "cors";
import express from "express";
import { connectDatabase, getDatabaseStatus } from "./db.js";
import { env } from "./env.js";
import { requireAuth } from "./middleware/auth.js";
import { requireDatabaseReady } from "./middleware/database.js";
import authRoutes from "./routes/auth.js";
import attachmentRoutes from "./routes/attachments.js";
import assistantRoutes from "./routes/assistant.js";
import dashboardRoutes from "./routes/dashboard.js";
import estimateGroupRoutes from "./routes/estimateGroups.js";
import expenseRoutes from "./routes/expenses.js";
import historyRoutes from "./routes/history.js";
import invoiceRoutes from "./routes/invoices.js";
import materialPresetRoutes from "./routes/materialPresets.js";
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
  const database = getDatabaseStatus();
  res.status(database.connected ? 200 : 503).json({ ok: true, database });
});

app.use("/api/auth", requireDatabaseReady, authRoutes);
app.use("/api/assistant", requireDatabaseReady, requireAuth, assistantRoutes);
app.use("/api/dashboard", requireDatabaseReady, requireAuth, dashboardRoutes);
app.use("/api/estimate-groups", requireDatabaseReady, requireAuth, estimateGroupRoutes);
app.use("/api/history", requireDatabaseReady, requireAuth, historyRoutes);
app.use("/api/expenses", requireDatabaseReady, requireAuth, expenseRoutes);
app.use("/api/invoices", requireDatabaseReady, requireAuth, invoiceRoutes);
app.use("/api/material-presets", requireDatabaseReady, requireAuth, materialPresetRoutes);
app.use("/api/workers", requireDatabaseReady, requireAuth, workerRoutes);
app.use("/api/vendors", requireDatabaseReady, requireAuth, vendorRoutes);
app.use("/api/tasks", requireDatabaseReady, requireAuth, taskRoutes);
app.use("/api/project", requireDatabaseReady, requireAuth, projectRoutes);
app.use("/api/attachments", requireDatabaseReady, requireAuth, attachmentRoutes);
app.use("/api/reports", requireDatabaseReady, requireAuth, reportRoutes);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error && typeof error === "object" && "issues" in error) {
    res.status(400).json({ message: "Validation failed", details: error });
    return;
  }

  console.error(error);
  res.status(500).json({ message: "Something went wrong" });
});

async function start() {
  app.listen(env.PORT, () => {
    console.log(`Server running on http://localhost:${env.PORT}`);
  });

  const retryDelayMs = 15000;

  async function connectWithRetry() {
    try {
      await connectDatabase();
      console.log("Database connected");
    } catch (error) {
      console.error(`Database connection failed. Retrying in ${retryDelayMs / 1000}s.`);
      console.error(error);
      setTimeout(() => {
        void connectWithRetry();
      }, retryDelayMs);
    }
  }

  void connectWithRetry();
}

start().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
