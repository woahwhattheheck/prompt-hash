/**
 * Seller payout statement API — Issue #245.
 * Mirrors the Express route style used by fulfillment / reconciliation.
 */
import { Router, Request, Response } from "express";
import PayoutStatementModel from "../models/PayoutStatement";
import {
  aggregateSellerStatementFromDb,
  exportStatementToCsv,
  exportStatementToJson,
  reconcilePayoutStatement,
} from "../services/payoutStatementService";
import type { PayoutSettlementStatus } from "../types/PayoutStatement";

export const payoutRouter = Router();

/**
 * GET /api/payouts/statements/:walletAddress
 * List persisted statements, or preview a live reconciliation via
 * ?from=&to= query params (ISO-8601).
 */
payoutRouter.get(
  "/statements/:walletAddress",
  async (req: Request, res: Response) => {
    try {
      const walletAddress = String(req.params.walletAddress).toLowerCase();
      const { from, to } = req.query;

      if (typeof from === "string" && typeof to === "string") {
        const statement = await aggregateSellerStatementFromDb({
          sellerWallet: walletAddress,
          periodStart: from,
          periodEnd: to,
          previousBalanceCarryoverStroops: req.query.carryover
            ? Number(req.query.carryover)
            : 0,
          priorSettledPeriodEnd:
            typeof req.query.priorSettledPeriodEnd === "string"
              ? req.query.priorSettledPeriodEnd
              : undefined,
        });
        res.json({ statement });
        return;
      }

      const statements = await PayoutStatementModel.find({
        sellerWallet: walletAddress,
      })
        .sort({ "period.start": -1 })
        .lean();
      res.json({ statements });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

/**
 * GET /api/payouts/statements/:walletAddress/:statementId
 */
payoutRouter.get(
  "/statements/:walletAddress/:statementId",
  async (req: Request, res: Response) => {
    try {
      const walletAddress = String(req.params.walletAddress).toLowerCase();
      const { statementId } = req.params;
      const statement = await PayoutStatementModel.findOne({
        statementId,
        sellerWallet: walletAddress,
      }).lean();
      if (!statement) {
        res.status(404).json({ error: "Payout statement not found" });
        return;
      }
      res.json({ statement });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

/**
 * GET /api/payouts/statements/:walletAddress/:statementId/export?format=csv|json
 */
payoutRouter.get(
  "/statements/:walletAddress/:statementId/export",
  async (req: Request, res: Response) => {
    try {
      const walletAddress = String(req.params.walletAddress).toLowerCase();
      const { statementId } = req.params;
      const format = String(req.query.format || "json").toLowerCase();

      const statement = await PayoutStatementModel.findOne({
        statementId,
        sellerWallet: walletAddress,
      }).lean();
      if (!statement) {
        res.status(404).json({ error: "Payout statement not found" });
        return;
      }

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${statementId}.csv"`,
        );
        res.send(exportStatementToCsv(statement as any));
        return;
      }

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${statementId}.json"`,
      );
      res.send(exportStatementToJson(statement as any));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

/**
 * POST /api/payouts/statements/generate
 * Body: { sellerWallet, periodStart, periodEnd, previousBalanceCarryoverStroops?,
 *         priorSettledPeriodEnd?, persist?, payoutAttempts? }
 */
payoutRouter.post("/statements/generate", async (req: Request, res: Response) => {
  try {
    const {
      sellerWallet,
      periodStart,
      periodEnd,
      previousBalanceCarryoverStroops = 0,
      priorSettledPeriodEnd,
      persist = true,
      payoutAttempts,
      // Allow pure event-driven generation (tests / offline tooling)
      purchases,
      refunds,
      payoutAddress,
      feeBps,
    } = req.body || {};

    if (!sellerWallet || !periodStart || !periodEnd) {
      res.status(400).json({
        error: "sellerWallet, periodStart, and periodEnd are required",
      });
      return;
    }

    let statement;
    if (Array.isArray(purchases)) {
      statement = reconcilePayoutStatement({
        sellerWallet,
        payoutAddress,
        period: { start: periodStart, end: periodEnd },
        purchases,
        refunds,
        payoutAttempts,
        previousBalanceCarryoverStroops,
        priorSettledPeriodEnd,
        feeBps,
      });
    } else {
      statement = await aggregateSellerStatementFromDb({
        sellerWallet,
        periodStart,
        periodEnd,
        previousBalanceCarryoverStroops,
        priorSettledPeriodEnd,
        payoutAttempts,
      });
    }

    if (persist) {
      await PayoutStatementModel.findOneAndUpdate(
        { statementId: statement.statementId },
        statement,
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }

    res.status(201).json({ statement });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * PATCH /api/payouts/statements/:statementId/status
 * Body: { status: pending|settled|failed, failureReason?, payoutTxHash? }
 */
payoutRouter.patch(
  "/statements/:statementId/status",
  async (req: Request, res: Response) => {
    try {
      const { statementId } = req.params;
      const { status, failureReason, payoutTxHash } = req.body || {};
      const allowed: PayoutSettlementStatus[] = [
        "pending",
        "settled",
        "failed",
      ];
      if (!allowed.includes(status)) {
        res.status(400).json({
          error: "status must be pending, settled, or failed",
        });
        return;
      }

      const statement = await PayoutStatementModel.findOneAndUpdate(
        { statementId },
        {
          status,
          failureReason: failureReason ?? "",
          payoutTxHash: payoutTxHash ?? "",
        },
        { new: true },
      ).lean();

      if (!statement) {
        res.status(404).json({ error: "Payout statement not found" });
        return;
      }
      res.json({ statement });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);
