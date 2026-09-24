import { createHmac, randomUUID } from "crypto";
import Purchase from "../models/Purchase";
import FulfillmentRecord from "../models/FulfillmentRecord";
import WebhookDeliveryLog from "../models/WebhookDeliveryLog";
import ReconciliationReport, { MismatchType } from "../models/ReconciliationReport";
import { dispatchEvent } from "./webhookDispatcher";
import { publicDeliveryLogEndpoint } from "./webhookLogPrivacy";

const RECONCILIATION_SECRET = process.env.RECONCILIATION_SECRET || "reconciliation-secret-key-123";

export function signReport(data: object, secret: string = RECONCILIATION_SECRET): string {
  const serialized = JSON.stringify(data);
  return `sha256=${createHmac("sha256", secret).update(serialized).digest("hex")}`;
}

export interface RunReconciliationOptions {
  isDryRun?: boolean;
  createdBy?: string;
}

export async function runReconciliation(options: RunReconciliationOptions = {}) {
  const isDryRun = options.isDryRun ?? true;
  const createdBy = options.createdBy ?? "system";
  const reportId = `rec_${randomUUID()}`;

  const purchases = await Purchase.find({}).lean();
  const fulfillments = await FulfillmentRecord.find({}).lean();
  const webhookLogs = await WebhookDeliveryLog.find({}).lean();

  const fulfillmentMap = new Map<string, any>();
  for (const f of fulfillments) {
    fulfillmentMap.set(`${f.promptId}:${f.buyerWallet.toLowerCase()}`, f);
  }

  const mismatches: Array<{
    type: MismatchType;
    promptId: string;
    buyerWallet: string;
    txHash?: string;
    details?: Record<string, unknown>;
    repairStatus: "pending" | "approved" | "completed" | "failed" | "skipped";
  }> = [];

  // Computed once, outside the purchase loop: previously this filter (and
  // the mismatch it produces) ran *inside* the loop and was appended using
  // the *current* purchase's promptId/buyerWallet regardless of whether
  // that delivery had anything to do with that purchase - turning every
  // failed delivery into a mismatch against every purchase (an N x M
  // cross-join) instead of correlating each delivery to the one purchase
  // it actually belongs to.
  const failedWebhooks = webhookLogs.filter(
    (w) => w.event === "PromptPurchased" && w.status === "failed"
  );

  // Index failed deliveries by the correlation key persisted at dispatch
  // time (promptId + buyerWallet - see webhookDispatcher.ts), so each
  // purchase only picks up the deliveries that were actually dispatched
  // for it. Deliveries missing that evidence (e.g. logged before this
  // correlation data existed) can't be indexed here and are reported
  // separately below as "webhook_uncorrelated" rather than being silently
  // dropped or attributed to the wrong purchase.
  const failedWebhooksByPurchase = new Map<string, typeof failedWebhooks>();
  const uncorrelatedWebhooks: typeof failedWebhooks = [];
  for (const w of failedWebhooks) {
    if (!w.promptId || !w.buyerWallet) {
      uncorrelatedWebhooks.push(w);
      continue;
    }
    const key = `${w.promptId}:${w.buyerWallet.toLowerCase()}`;
    const bucket = failedWebhooksByPurchase.get(key);
    if (bucket) {
      bucket.push(w);
    } else {
      failedWebhooksByPurchase.set(key, [w]);
    }
  }

  for (const p of purchases) {
    const key = `${p.promptId}:${p.buyerWallet.toLowerCase()}`;
    const f = fulfillmentMap.get(key);

    if (!f) {
      mismatches.push({
        type: "missing_fulfillment",
        promptId: p.promptId,
        buyerWallet: p.buyerWallet,
        txHash: p.txHash,
        details: { purchaseId: String(p._id) },
        repairStatus: "pending",
      });
    } else if (f.status === "failed") {
      mismatches.push({
        type: "missing_fulfillment",
        promptId: p.promptId,
        buyerWallet: p.buyerWallet,
        txHash: p.txHash,
        details: { fulfillmentStatus: "failed", failureReason: f.failureReason },
        repairStatus: "pending",
      });
    }

    const correlatedWebhooks = failedWebhooksByPurchase.get(key) ?? [];
    for (const w of correlatedWebhooks) {
      mismatches.push({
        type: "webhook_undelivered",
        promptId: p.promptId,
        buyerWallet: p.buyerWallet,
        txHash: p.txHash,
        details: publicDeliveryLogEndpoint(w),
        repairStatus: "pending",
      });
    }
  }

  // Failed deliveries that either lacked correlation evidence, or whose
  // promptId/buyerWallet didn't match any known purchase, are reported
  // explicitly rather than being attributed to an unrelated purchase.
  const knownPurchaseKeys = new Set(
    purchases.map((p) => `${p.promptId}:${p.buyerWallet.toLowerCase()}`)
  );
  for (const w of failedWebhooks) {
    if (!w.promptId || !w.buyerWallet) {
      mismatches.push({
        type: "webhook_uncorrelated",
        promptId: "unknown",
        buyerWallet: "unknown",
        details: {
          ...publicDeliveryLogEndpoint(w),
          reason: "Delivery log has no promptId/buyerWallet correlation evidence.",
        },
        repairStatus: "skipped",
      });
      continue;
    }
    const key = `${w.promptId}:${w.buyerWallet.toLowerCase()}`;
    if (!knownPurchaseKeys.has(key)) {
      mismatches.push({
        type: "webhook_uncorrelated",
        promptId: w.promptId,
        buyerWallet: w.buyerWallet,
        details: {
          ...publicDeliveryLogEndpoint(w),
          reason: "No purchase record matches this delivery's promptId/buyerWallet.",
        },
        repairStatus: "skipped",
      });
    }
  }

  const summaryData = {
    reportId,
    totalDbPurchases: purchases.length,
    totalFulfillments: fulfillments.length,
    mismatchCount: mismatches.length,
    isDryRun,
  };

  const signature = signReport(summaryData);

  const report = await ReconciliationReport.create({
    reportId,
    totalDbPurchases: purchases.length,
    totalFulfillments: fulfillments.length,
    mismatches,
    isDryRun,
    signature,
    createdBy,
    status: "generated",
  });

  return report;
}

export async function executeRepair(reportId: string, approvedBy: string) {
  const report = await ReconciliationReport.findOne({ reportId });
  if (!report) {
    throw new Error(`Reconciliation report ${reportId} not found`);
  }

  if (report.approvedBy && report.approvedBy !== approvedBy) {
    throw new Error(`Report was already approved by ${report.approvedBy}`);
  }

  report.approvedBy = approvedBy;
  let repairedCount = 0;

  for (const item of report.mismatches) {
    if (item.repairStatus === "completed") continue;

    try {
      if (item.type === "missing_fulfillment") {
        await FulfillmentRecord.findOneAndUpdate(
          { promptId: item.promptId, buyerWallet: item.buyerWallet.toLowerCase() },
          {
            $set: {
              status: "delivered",
              txHash: item.txHash || "",
              deliveryAttemptedAt: new Date(),
            },
            $push: {
              auditLog: {
                status: "delivered",
                note: `Repaired via reconciliation report ${reportId} by ${approvedBy}`,
                at: new Date(),
              },
            },
          },
          { upsert: true }
        );
        item.repairStatus = "completed";
        item.repairedAt = new Date();
        repairedCount++;
      } else if (item.type === "webhook_undelivered") {
        await dispatchEvent(item.buyerWallet, "PromptPurchased", {
          promptId: item.promptId,
          buyerWallet: item.buyerWallet,
          reconciled: true,
        });
        item.repairStatus = "completed";
        item.repairedAt = new Date();
        repairedCount++;
      }
    } catch (err) {
      item.repairStatus = "failed";
      item.repairError = err instanceof Error ? err.message : String(err);
    }
  }

  const allDone = report.mismatches.every((m: any) => m.repairStatus === "completed");
  report.status = allDone ? "fully_repaired" : "partially_repaired";
  await report.save();

  return { report, repairedCount };
}
