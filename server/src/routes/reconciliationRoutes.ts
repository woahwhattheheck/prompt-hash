import { Router, Request, Response } from "express";
import { serviceBearer } from "../auth/serviceBearer";
import ReconciliationReport from "../models/ReconciliationReport";
import { runReconciliation, executeRepair } from "../services/reconciliationService";

export const reconciliationRouter = Router();

// Reuse the existing constant-time, fail-closed service auth boundary.
// Read/run and repair use separate least-privilege roles; wallet sessions
// and arbitrary Authorization values confer neither capability.
const requireReconciliationService = serviceBearer("RECONCILIATION_SERVICE_TOKEN", "Reconciliation service");
const requireReconciliationApprover = serviceBearer("RECONCILIATION_APPROVER_TOKEN", "Reconciliation approval");

/**
 * POST /api/reconciliation/run
 * Initiates a settlement reconciliation scan across on-chain events, DB purchases, and webhooks.
 */
reconciliationRouter.post("/run", requireReconciliationService, async (req: Request, res: Response) => {
  try {
    const { isDryRun = true } = req.body || {};
    if (typeof isDryRun !== "boolean") {
      res.status(400).json({ error: "Invalid reconciliation mode." });
      return;
    }
    // Do not attribute audit records to identities supplied by callers.
    const report = await runReconciliation({ isDryRun, createdBy: "reconciliation-service" });
    res.status(201).json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: "Reconciliation operation failed." });
  }
});

/**
 * GET /api/reconciliation/reports
 * Lists all generated reconciliation reports.
 */
reconciliationRouter.get("/reports", requireReconciliationService, async (_req: Request, res: Response) => {
  try {
    const reports = await ReconciliationReport.find({}).sort({ createdAt: -1 }).lean();
    res.json({ reports });
  } catch (err) {
    res.status(500).json({ error: "Reconciliation operation failed." });
  }
});

/**
 * GET /api/reconciliation/reports/:reportId
 * Fetches a single reconciliation report by ID.
 */
reconciliationRouter.get("/reports/:reportId", requireReconciliationService, async (req: Request, res: Response) => {
  try {
    const { reportId } = req.params;
    const report = await ReconciliationReport.findOne({ reportId }).lean();
    if (!report) {
      res.status(404).json({ error: "Reconciliation report not found" });
      return;
    }
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: "Reconciliation operation failed." });
  }
});

/**
 * POST /api/reconciliation/repair/:reportId
 * Approves and executes repairs for a reconciliation report (maker-checker pattern).
 */
reconciliationRouter.post("/repair/:reportId", requireReconciliationApprover, async (req: Request, res: Response) => {
  try {
    const { reportId } = req.params;
    // The approved-by audit label comes from the authenticated role,
    // never from a caller-provided payload field.
    const result = await executeRepair(reportId, "reconciliation-approver");
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: "Reconciliation operation failed." });
  }
});
