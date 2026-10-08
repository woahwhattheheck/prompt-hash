import { Router, Request, Response } from "express";
import FulfillmentRecord, {
  FulfillmentStatus,
} from "../models/FulfillmentRecord";
import { requireWalletPrincipal } from "../auth/walletPrincipalHttp";
import { requireFulfillmentService } from "../auth/fulfillmentService";

export const fulfillmentRouter = Router();

/** Match a URL buyer selector to a signed wallet principal before any query. */
function authenticatedBuyer(req: Request, res: Response): string | null {
  res.setHeader("Cache-Control", "no-store");
  const principal = res.locals.walletPrincipal?.address;
  if (typeof principal !== "string") {
    res.status(401).json({ error: "Wallet session required." });
    return null;
  }
  const selector = req.params.buyerWallet;
  if (typeof selector !== "string" || selector.toLowerCase() !== principal.toLowerCase()) {
    res.status(403).json({ error: "Wallet does not match authenticated session." });
    return null;
  }
  return principal.toLowerCase();
}

/**
 * GET /api/fulfillment/:promptId/:buyerWallet
 * Returns the fulfillment record for a specific purchase.
 */
fulfillmentRouter.get(
  "/:promptId/:buyerWallet",
  requireWalletPrincipal,
  async (req: Request, res: Response) => {
    const { promptId } = req.params;
    const buyerWallet = authenticatedBuyer(req, res);
    if (!buyerWallet) return;
    const record = await FulfillmentRecord.findOne({
      promptId,
      buyerWallet: buyerWallet.toLowerCase(),
    });
    if (!record) {
      res.status(404).json({ error: "Fulfillment record not found" });
      return;
    }
    res.json(record);
  },
);

/**
 * POST /api/fulfillment
 * Creates or updates the fulfillment record for a purchase.
 * Called by the unlock service when delivery is attempted.
 *
 * Body: { promptId, buyerWallet, txHash?, status, failureReason? }
 */
fulfillmentRouter.post("/", requireFulfillmentService, async (req: Request, res: Response) => {
  const {
    promptId,
    buyerWallet,
    txHash,
    status,
    failureReason,
  }: {
    promptId: string;
    buyerWallet: string;
    txHash?: string;
    status: FulfillmentStatus;
    failureReason?: string;
  } = req.body ?? {};

  // Dispute and refund transitions belong to their separate privileged paths.
  if (typeof promptId !== "string" || !promptId ||
      typeof buyerWallet !== "string" || !buyerWallet ||
      !["pending", "delivered", "failed"].includes(status) ||
      (txHash !== undefined && typeof txHash !== "string") ||
      (failureReason !== undefined && typeof failureReason !== "string")) {
    res.status(400).json({ error: "Invalid fulfillment delivery input." });
    return;
  }

  const record = await FulfillmentRecord.findOneAndUpdate(
    { promptId, buyerWallet: buyerWallet.toLowerCase() },
    {
      $set: {
        txHash: txHash ?? "",
        status,
        failureReason: failureReason ?? "",
        ...(status !== "pending" ? { deliveryAttemptedAt: new Date() } : {}),
      },
      $push: {
        auditLog: { status, note: failureReason ?? "", at: new Date() },
      },
    },
    { upsert: true, new: true },
  );

  res.json(record);
});

/**
 * POST /api/fulfillment/:promptId/:buyerWallet/request-refund
 * The buyer requests a refund for a failed or timed-out delivery.
 *
 * Body: { reason, disputeTxHash? }
 */
fulfillmentRouter.post(
  "/:promptId/:buyerWallet/request-refund",
  requireWalletPrincipal,
  async (req: Request, res: Response) => {
    const { promptId } = req.params;
    const buyerWallet = authenticatedBuyer(req, res);
    if (!buyerWallet) return;
    const { reason, disputeTxHash } = (req.body ?? {}) as {
      reason: string;
      disputeTxHash?: string;
    };

    if (typeof reason !== "string" || !reason.trim() || reason.length > 4000 ||
        (disputeTxHash !== undefined && typeof disputeTxHash !== "string")) {
      res.status(400).json({ error: "A valid refund reason is required." });
      return;
    }

    const record = await FulfillmentRecord.findOne({
      promptId,
      buyerWallet: buyerWallet.toLowerCase(),
    });

    if (!record) {
      res.status(404).json({ error: "Fulfillment record not found" });
      return;
    }

    if (!record.isRefundEligible()) {
      res.status(409).json({
        error: "Purchase is not eligible for a refund",
        status: record.status,
      });
      return;
    }

    record.status = "refund_requested";
    record.refundReason = reason;
    if (disputeTxHash) record.disputeTxHash = disputeTxHash;
    record.auditLog.push({
      status: "refund_requested",
      note: reason,
      at: new Date(),
    });
    await record.save();

    res.json(record);
  },
);

/**
 * POST /api/fulfillment/:promptId/:buyerWallet/resolve
 * Admin resolves a refund request (approve or reject).
 *
 * Body: { refund: boolean, resolutionTxHash? }
 */
fulfillmentRouter.post(
  "/:promptId/:buyerWallet/resolve",
  requireFulfillmentService,
  async (req: Request, res: Response) => {
    const { promptId, buyerWallet } = req.params;
    const { refund, resolutionTxHash } = (req.body ?? {}) as {
      refund: boolean;
      resolutionTxHash?: string;
    };
    if (typeof refund !== "boolean" ||
        (resolutionTxHash !== undefined && typeof resolutionTxHash !== "string")) {
      res.status(400).json({ error: "Invalid refund resolution." });
      return;
    }

    const record = await FulfillmentRecord.findOne({
      promptId,
      buyerWallet: buyerWallet.toLowerCase(),
    });

    if (!record) {
      res.status(404).json({ error: "Fulfillment record not found" });
      return;
    }

    if (record.status !== "refund_requested") {
      res.status(409).json({
        error: "Record is not in refund_requested state",
        status: record.status,
      });
      return;
    }

    const newStatus: FulfillmentStatus = refund ? "refunded" : "rejected";
    record.status = newStatus;
    if (resolutionTxHash) record.resolutionTxHash = resolutionTxHash;
    record.auditLog.push({
      status: newStatus,
      note: refund ? "Refund approved" : "Refund rejected",
      at: new Date(),
    });
    await record.save();

    res.json(record);
  },
);

/**
 * GET /api/fulfillment/pending-refunds
 * Returns all records with status=refund_requested.
 * Intended for admin dashboards.
 */
fulfillmentRouter.get("/pending-refunds", requireFulfillmentService, async (_req, res: Response) => {
  const records = await FulfillmentRecord.find({
    status: "refund_requested",
  }).sort({ updatedAt: -1 });
  res.json(records);
});

/**
 * POST /api/fulfillment/auto-refund-sweep
 * Marks all purchases that are still `pending` or `failed` after the
 * timeout window as `refund_requested`.  Intended to be called by a
 * cron job or a scheduled task (#335).
 */
fulfillmentRouter.post("/auto-refund-sweep", requireFulfillmentService, async (_req, res: Response) => {
  const timeoutMs = parseInt(
    process.env.FULFILLMENT_TIMEOUT_MS ?? "600000",
    10,
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    res.status(503).json({ error: "Invalid fulfillment timeout configuration." });
    return;
  }
  const cutoff = new Date(Date.now() - timeoutMs);

  const result = await FulfillmentRecord.updateMany(
    {
      status: { $in: ["pending", "failed"] },
      deliveryAttemptedAt: { $lte: cutoff },
    },
    {
      $set: { status: "refund_requested", refundReason: "Auto-refund: delivery timeout" },
      $push: {
        auditLog: {
          status: "refund_requested",
          note: "Auto-refund: delivery timeout exceeded",
          at: new Date(),
        },
      },
    },
  );

  res.json({ swept: result.modifiedCount });
});
