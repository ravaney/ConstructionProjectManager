import { NextFunction, Request, Response } from "express";
import { getDatabaseStatus, isDatabaseConnected } from "../db.js";

export function requireDatabaseReady(_req: Request, res: Response, next: NextFunction) {
  if (isDatabaseConnected()) {
    next();
    return;
  }

  const status = getDatabaseStatus();
  res.status(503).json({
    message: "Database unavailable",
    details: status.lastError ?? "Database connection is still starting"
  });
}
