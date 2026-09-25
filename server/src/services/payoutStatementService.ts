/**
 * Seller payout statement aggregation & export — Issue #245.
 *
 * Fee source: DEFAULT_FEE_BPS from server/src/constants/platformFee.ts
 * (contracts/prompt-hash/src/contract.rs).
 */

import { createHmac, randomUUID } from "crypto";
import {
  DEFAULT_FEE_BPS,
  platformFeeStroops,
  xlmToStroops,
} from "../constants/platformFee";
import type {
  PayoutAttemptInput,
  PayoutAttemptLineItem,
  PayoutSettlementStatus,
  PayoutStatement,
  PurchaseEventInput,
  ReconcilePayoutInput,
  RefundEventInput,
  RefundLineItem,
  SaleLineItem,
} from "../types/PayoutStatement";
import Purchase from "../models/Purchase";
import Prompt from "../models/Prompt";
import FulfillmentRecord from "../models/FulfillmentRecord";
import User from "../models/User";

const PAYOUT_STATEMENT_SECRET =
  process.env.PAYOUT_STATEMENT_SECRET || "payout-statement-secret-key";

export function signPayoutStatement(
  data: object,
  secret: string = PAYOUT_STATEMENT_SECRET,
): string {
  return `sha256=${createHmac("sha256", secret).update(JSON.stringify(data)).digest("hex")}`;
}

function toMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid timestamp: ${iso}`);
  }
  return ms;
}

/** Inclusive period membership: start <= t <= end. */
export function isWithinPeriod(
  isoTimestamp: string,
  periodStart: string,
  periodEnd: string,
): boolean {
  const t = toMs(isoTimestamp);
  return t >= toMs(periodStart) && t <= toMs(periodEnd);
}

function buildSaleLine(
  purchase: PurchaseEventInput,
  feeBps: number,
): SaleLineItem {
  const fee = platformFeeStroops(purchase.grossStroops, feeBps);
  return {
    purchaseId: purchase.purchaseId,
    promptId: purchase.promptId,
    buyerWallet: purchase.buyerWallet,
    grossStroops: purchase.grossStroops,
    platformFeeStroops: fee,
    sellerNetStroops: purchase.grossStroops - fee,
    purchasedAt: purchase.purchasedAt,
  };
}

function buildRefundLine(
  refund: RefundEventInput,
  feeBps: number,
  priorSettledPeriodEnd?: string,
): RefundLineItem {
  const fee = platformFeeStroops(refund.originalGrossStroops, feeBps);
  const sellerDebit = refund.originalGrossStroops - fee;
  const isClawback = Boolean(
    priorSettledPeriodEnd &&
      toMs(refund.originalPurchasedAt) <= toMs(priorSettledPeriodEnd),
  );
  return {
    purchaseId: refund.purchaseId,
    promptId: refund.promptId,
    sellerDebitStroops: sellerDebit,
    originalGrossStroops: refund.originalGrossStroops,
    feeReversalStroops: fee,
    refundedAt: refund.refundedAt,
    isClawback,
  };
}

/**
 * Derive overall statement status from payout attempts (if any).
 * Prefer failed > pending > settled; default pending when no attempts.
 */
export function deriveStatementStatus(
  attempts: PayoutAttemptLineItem[],
): { status: PayoutSettlementStatus; failureReason?: string; payoutTxHash?: string } {
  if (attempts.length === 0) {
    return { status: "pending" };
  }
  const failed = attempts.find((a) => a.status === "failed");
  if (failed) {
    return {
      status: "failed",
      failureReason: failed.failureReason,
      payoutTxHash: failed.txHash,
    };
  }
  const pending = attempts.find((a) => a.status === "pending");
  if (pending) {
    return { status: "pending", payoutTxHash: pending.txHash };
  }
  const settled = [...attempts].reverse().find((a) => a.status === "settled");
  return {
    status: "settled",
    payoutTxHash: settled?.txHash,
  };
}

/**
 * Reconcile purchase / refund / payout events into a balanced statement.
 *
 * Invariant:
 *   net = gross − platformFees − refundSellerDebits + previousCarryover
 */
export function reconcilePayoutStatement(
  input: ReconcilePayoutInput,
): PayoutStatement {
  const feeBps = input.feeBps ?? DEFAULT_FEE_BPS;
  const period = input.period;

  const purchasesInPeriod = input.purchases.filter((p) =>
    isWithinPeriod(p.purchasedAt, period.start, period.end),
  );

  const refundsInPeriod = (input.refunds ?? []).filter((r) =>
    isWithinPeriod(r.refundedAt, period.start, period.end),
  );

  const sales = purchasesInPeriod.map((p) => buildSaleLine(p, feeBps));
  const refunds = refundsInPeriod.map((r) =>
    buildRefundLine(r, feeBps, input.priorSettledPeriodEnd),
  );

  const attempts: PayoutAttemptLineItem[] = (input.payoutAttempts ?? []).map(
    (a: PayoutAttemptInput) => ({
      attemptId: a.attemptId,
      amountStroops: a.amountStroops,
      status: a.status,
      attemptedAt: a.attemptedAt,
      failureReason: a.failureReason,
      txHash: a.txHash,
    }),
  );

  const grossStroops = sales.reduce((sum, s) => sum + s.grossStroops, 0);
  const platformFeeStroopsTotal = sales.reduce(
    (sum, s) => sum + s.platformFeeStroops,
    0,
  );
  const refundSellerDebitStroops = refunds.reduce(
    (sum, r) => sum + r.sellerDebitStroops,
    0,
  );
  const clawbackStroops = refunds
    .filter((r) => r.isClawback)
    .reduce((sum, r) => sum + r.sellerDebitStroops, 0);

  const previousBalanceCarryoverStroops =
    input.previousBalanceCarryoverStroops ?? 0;

  const netSettlementStroops =
    grossStroops -
    platformFeeStroopsTotal -
    refundSellerDebitStroops +
    previousBalanceCarryoverStroops;

  const payableStroops = Math.max(netSettlementStroops, 0);
  const closingBalanceCarryoverStroops = Math.min(netSettlementStroops, 0);

  const derived = deriveStatementStatus(attempts);
  const sellerWallet = input.sellerWallet.toLowerCase();
  const payoutAddress = (
    input.payoutAddress?.trim() || sellerWallet
  ).toLowerCase();

  const statementData: Omit<PayoutStatement, "signature"> = {
    statementId: input.statementId ?? `stmt_${randomUUID()}`,
    sellerWallet,
    payoutAddress,
    period,
    feeBps,
    saleCount: sales.length,
    grossStroops,
    platformFeeStroops: platformFeeStroopsTotal,
    refundSellerDebitStroops,
    clawbackStroops,
    previousBalanceCarryoverStroops,
    netSettlementStroops,
    payableStroops,
    closingBalanceCarryoverStroops,
    status: derived.status,
    failureReason: derived.failureReason,
    payoutTxHash: derived.payoutTxHash,
    sales,
    refunds,
    payoutAttempts: attempts,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };

  return {
    ...statementData,
    signature: signPayoutStatement(statementData),
  };
}

/** RFC-4180-ish CSV export (summary + line items). */
export function exportStatementToCsv(statement: PayoutStatement): string {
  const escape = (value: string | number | undefined): string => {
    const raw = value === undefined || value === null ? "" : String(value);
    if (/[",\n\r]/.test(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };

  const lines: string[] = [];
  lines.push("section,field,value");
  lines.push(`summary,statementId,${escape(statement.statementId)}`);
  lines.push(`summary,sellerWallet,${escape(statement.sellerWallet)}`);
  lines.push(`summary,payoutAddress,${escape(statement.payoutAddress)}`);
  lines.push(`summary,periodStart,${escape(statement.period.start)}`);
  lines.push(`summary,periodEnd,${escape(statement.period.end)}`);
  lines.push(`summary,feeBps,${statement.feeBps}`);
  lines.push(`summary,status,${escape(statement.status)}`);
  lines.push(`summary,grossStroops,${statement.grossStroops}`);
  lines.push(`summary,platformFeeStroops,${statement.platformFeeStroops}`);
  lines.push(
    `summary,refundSellerDebitStroops,${statement.refundSellerDebitStroops}`,
  );
  lines.push(`summary,clawbackStroops,${statement.clawbackStroops}`);
  lines.push(
    `summary,previousBalanceCarryoverStroops,${statement.previousBalanceCarryoverStroops}`,
  );
  lines.push(`summary,netSettlementStroops,${statement.netSettlementStroops}`);
  lines.push(`summary,payableStroops,${statement.payableStroops}`);
  lines.push(
    `summary,closingBalanceCarryoverStroops,${statement.closingBalanceCarryoverStroops}`,
  );
  lines.push(`summary,failureReason,${escape(statement.failureReason)}`);
  lines.push(`summary,payoutTxHash,${escape(statement.payoutTxHash)}`);
  lines.push(`summary,generatedAt,${escape(statement.generatedAt)}`);

  lines.push("");
  lines.push(
    "sales,purchaseId,promptId,buyerWallet,grossStroops,platformFeeStroops,sellerNetStroops,purchasedAt",
  );
  for (const s of statement.sales) {
    lines.push(
      [
        "sales",
        escape(s.purchaseId),
        escape(s.promptId),
        escape(s.buyerWallet),
        s.grossStroops,
        s.platformFeeStroops,
        s.sellerNetStroops,
        escape(s.purchasedAt),
      ].join(","),
    );
  }

  lines.push("");
  lines.push(
    "refunds,purchaseId,promptId,sellerDebitStroops,originalGrossStroops,feeReversalStroops,isClawback,refundedAt",
  );
  for (const r of statement.refunds) {
    lines.push(
      [
        "refunds",
        escape(r.purchaseId),
        escape(r.promptId),
        r.sellerDebitStroops,
        r.originalGrossStroops,
        r.feeReversalStroops,
        r.isClawback,
        escape(r.refundedAt),
      ].join(","),
    );
  }

  lines.push("");
  lines.push(
    "payoutAttempts,attemptId,amountStroops,status,attemptedAt,failureReason,txHash",
  );
  for (const a of statement.payoutAttempts) {
    lines.push(
      [
        "payoutAttempts",
        escape(a.attemptId),
        a.amountStroops,
        escape(a.status),
        escape(a.attemptedAt),
        escape(a.failureReason),
        escape(a.txHash),
      ].join(","),
    );
  }

  return lines.join("\n");
}

export function exportStatementToJson(statement: PayoutStatement): string {
  return JSON.stringify(statement, null, 2);
}

export interface AggregateFromDbOptions {
  sellerWallet: string;
  periodStart: string;
  periodEnd: string;
  previousBalanceCarryoverStroops?: number;
  priorSettledPeriodEnd?: string;
  payoutAttempts?: PayoutAttemptInput[];
}

/**
 * Load purchase / refund events for a seller from Mongo and reconcile.
 * Gross amounts come from Prompt.price (XLM → stroops); fees from DEFAULT_FEE_BPS.
 * Payout destination comes from User.payoutSettings (existing), never invented.
 */
export async function aggregateSellerStatementFromDb(
  options: AggregateFromDbOptions,
): Promise<PayoutStatement> {
  const sellerWallet = options.sellerWallet.toLowerCase();
  const user = await User.findOne({ walletAddress: sellerWallet }).lean();
  const payoutAddress =
    (user as { payoutSettings?: { payoutAddress?: string } } | null)
      ?.payoutSettings?.payoutAddress || sellerWallet;

  const prompts = await Prompt.find({
    owner: (user as { _id?: unknown } | null)?._id,
  })
    .select("onChainId price")
    .lean();

  const promptById = new Map<string, { price: number }>();
  const onChainIds: string[] = [];
  for (const p of prompts as Array<{ onChainId?: string; price?: number }>) {
    if (!p.onChainId) continue;
    onChainIds.push(p.onChainId);
    promptById.set(p.onChainId, { price: p.price ?? 0 });
  }

  if (onChainIds.length === 0) {
    return reconcilePayoutStatement({
      sellerWallet,
      payoutAddress,
      period: { start: options.periodStart, end: options.periodEnd },
      purchases: [],
      refunds: [],
      payoutAttempts: options.payoutAttempts,
      previousBalanceCarryoverStroops: options.previousBalanceCarryoverStroops,
      priorSettledPeriodEnd: options.priorSettledPeriodEnd,
    });
  }

  const periodStartDate = new Date(options.periodStart);
  const periodEndDate = new Date(options.periodEnd);

  const purchases = await Purchase.find({
    promptId: { $in: onChainIds },
    createdAt: { $gte: periodStartDate, $lte: periodEndDate },
  }).lean();

  const purchaseEvents: PurchaseEventInput[] = (
    purchases as Array<{
      _id: { toString(): string };
      promptId: string;
      buyerWallet: string;
      createdAt: Date | string;
    }>
  ).map((p) => {
    const priceXlm = promptById.get(p.promptId)?.price ?? 0;
    return {
      purchaseId: String(p._id),
      promptId: p.promptId,
      buyerWallet: p.buyerWallet,
      grossStroops: xlmToStroops(priceXlm),
      purchasedAt: new Date(p.createdAt).toISOString(),
    };
  });

  // Refunds that completed in this period (may claw back prior sales).
  const refundRecords = await FulfillmentRecord.find({
    promptId: { $in: onChainIds },
    status: "refunded",
    updatedAt: { $gte: periodStartDate, $lte: periodEndDate },
  }).lean();

  const refundEvents: RefundEventInput[] = [];
  for (const f of refundRecords as Array<{
    promptId: string;
    buyerWallet: string;
    updatedAt: Date | string;
    createdAt: Date | string;
  }>) {
    const matchingPurchase = await Purchase.findOne({
      promptId: f.promptId,
      buyerWallet: f.buyerWallet,
    }).lean();
    const priceXlm = promptById.get(f.promptId)?.price ?? 0;
    const purchasedAt = matchingPurchase
      ? new Date(
          (matchingPurchase as { createdAt: Date | string }).createdAt,
        ).toISOString()
      : new Date(f.createdAt).toISOString();
    refundEvents.push({
      purchaseId: matchingPurchase
        ? String((matchingPurchase as { _id: { toString(): string } })._id)
        : `${f.promptId}:${f.buyerWallet}`,
      promptId: f.promptId,
      originalGrossStroops: xlmToStroops(priceXlm),
      refundedAt: new Date(f.updatedAt).toISOString(),
      originalPurchasedAt: purchasedAt,
    });
  }

  return reconcilePayoutStatement({
    sellerWallet,
    payoutAddress,
    period: { start: options.periodStart, end: options.periodEnd },
    purchases: purchaseEvents,
    refunds: refundEvents,
    payoutAttempts: options.payoutAttempts,
    previousBalanceCarryoverStroops: options.previousBalanceCarryoverStroops,
    priorSettledPeriodEnd: options.priorSettledPeriodEnd,
  });
}
