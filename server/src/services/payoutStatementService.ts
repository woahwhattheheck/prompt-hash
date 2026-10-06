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

export class PayoutStatementAmountError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "PayoutStatementAmountError";
  }
}

export class PayoutStatementPeriodError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "PayoutStatementPeriodError";
  }
}

export class PayoutStatementStatusError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "PayoutStatementStatusError";
  }
}

function validatePayoutPeriod(
  periodStart: unknown,
  periodEnd: unknown,
): { start: number; end: number } {
  if (typeof periodStart !== "string" || typeof periodEnd !== "string") {
    throw new PayoutStatementPeriodError(
      "periodStart and periodEnd must be timestamp or date strings",
    );
  }

  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new PayoutStatementPeriodError(
      "periodStart and periodEnd must be valid timestamps or dates",
    );
  }
  if (start > end) {
    throw new PayoutStatementPeriodError(
      "periodStart must be before or equal to periodEnd",
    );
  }
  return { start, end };
}

function safeStroops(value: number, field: string, allowNegative = false): number {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new PayoutStatementAmountError(
      `${field} must be ${allowNegative ? "a signed" : "a nonnegative"} safe integer in stroops`,
    );
  }
  return value;
}

function statementFeeStroops(gross: number, feeBps: number): number {
  try {
    return platformFeeStroops(gross, feeBps);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new PayoutStatementAmountError(error.message);
    }
    throw error;
  }
}

function sumStroops<Key extends string>(
  items: Array<Record<Key, number>>,
  key: Key,
  field: string = key,
): number {
  // Every term is nonnegative, so reject as soon as the total exceeds the
  // statement's exact Number range, before a rounded total can be accepted.
  return items.reduce((sum, item) => safeStroops(sum + item[key], field), 0);
}

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

/** Reuse validated instants when checking a statement's complete event batch. */
function isWithinParsedPeriod(
  isoTimestamp: string,
  period: { start: number; end: number },
): boolean {
  const t = toMs(isoTimestamp);
  return t >= period.start && t <= period.end;
}

function buildSaleLine(
  purchase: PurchaseEventInput,
  feeBps: number,
): SaleLineItem {
  const fee = statementFeeStroops(purchase.grossStroops, feeBps);
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
  const fee = statementFeeStroops(refund.originalGrossStroops, feeBps);
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
  // Unknown or missing attempt statuses must never imply settlement, even
  // when another row would otherwise short-circuit to failed or pending.
  for (const attempt of attempts) {
    if (
      attempt.status !== "pending" &&
      attempt.status !== "settled" &&
      attempt.status !== "failed"
    ) {
      throw new PayoutStatementStatusError(
        "payoutAttempts.status must be pending, settled, or failed",
      );
    }
  }
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
  const parsedPeriod = validatePayoutPeriod(input.period?.start, input.period?.end);
  const feeBps = input.feeBps ?? DEFAULT_FEE_BPS;
  const period = input.period;
  statementFeeStroops(0, feeBps);
  const previousBalanceCarryoverStroops = safeStroops(
    input.previousBalanceCarryoverStroops === undefined
      ? 0
      : input.previousBalanceCarryoverStroops,
    "previousBalanceCarryoverStroops",
    true,
  );

  const purchasesInPeriod = input.purchases.filter((p) =>
    isWithinParsedPeriod(p.purchasedAt, parsedPeriod),
  );

  const refundsInPeriod = (input.refunds ?? []).filter((r) =>
    isWithinParsedPeriod(r.refundedAt, parsedPeriod),
  );

  const sales = purchasesInPeriod.map((p) => buildSaleLine(p, feeBps));
  const refunds = refundsInPeriod.map((r) =>
    buildRefundLine(r, feeBps, input.priorSettledPeriodEnd),
  );

  const attempts: PayoutAttemptLineItem[] = (input.payoutAttempts ?? []).map(
    (a: PayoutAttemptInput) => ({
      attemptId: a.attemptId,
      amountStroops: safeStroops(a.amountStroops, "payoutAttempts.amountStroops"),
      status: a.status,
      attemptedAt: a.attemptedAt,
      failureReason: a.failureReason,
      txHash: a.txHash,
    }),
  );

  const grossStroops = sumStroops(sales, "grossStroops");
  const platformFeeStroopsTotal = sumStroops(sales, "platformFeeStroops");
  const refundSellerDebitStroops = sumStroops(
    refunds,
    "sellerDebitStroops",
    "refundSellerDebitStroops",
  );
  const clawbackStroops = sumStroops(
    refunds.filter((r) => r.isClawback),
    "sellerDebitStroops",
    "clawbackStroops",
  );

  const netSettlementStroops = safeStroops(
    grossStroops -
      platformFeeStroopsTotal -
      refundSellerDebitStroops +
      previousBalanceCarryoverStroops,
    "netSettlementStroops",
    true,
  );

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
    // Quoting alone does not stop spreadsheet formula interpretation. Keep
    // amounts numeric; only potentially executable textual cells are marked.
    const prefix = typeof value === "string" &&
      (/^\s*[=+\-@＝＋－＠]/u.test(raw) || /^[\t\r\n]/.test(raw));
    const text = prefix ? `'${raw}` : raw;
    if (prefix || /[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
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
  const parsedPeriod = validatePayoutPeriod(options.periodStart, options.periodEnd);
  const previousBalanceCarryoverStroops = safeStroops(
    options.previousBalanceCarryoverStroops === undefined
      ? 0
      : options.previousBalanceCarryoverStroops,
    "previousBalanceCarryoverStroops",
    true,
  );
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
      previousBalanceCarryoverStroops,
      priorSettledPeriodEnd: options.priorSettledPeriodEnd,
    });
  }

  const periodStartDate = new Date(parsedPeriod.start);
  const periodEndDate = new Date(parsedPeriod.end);

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

  // Include the recorded refund transition even if a later metadata write
  // moved updatedAt. Keep the old date window for legacy records; after
  // resolving the audit timestamp below, filter again before lookups.
  const refundRecords = await FulfillmentRecord.find({
    promptId: { $in: onChainIds },
    status: "refunded",
    $or: [
      { updatedAt: { $gte: periodStartDate, $lte: periodEndDate } },
      { auditLog: { $elemMatch: {
        status: "refunded", at: { $gte: periodStartDate, $lte: periodEndDate },
      } } },
    ],
  }).lean();

  type RefundRecord = {
    promptId: string;
    buyerWallet: string;
    updatedAt: Date | string;
    createdAt: Date | string;
    auditLog?: Array<{ status?: string; at?: Date | string | null }> | null;
  };
  type RefundPurchase = {
    _id: { toString(): string };
    promptId: string;
    buyerWallet: string;
    createdAt: Date | string;
  };
  const records = (refundRecords as RefundRecord[]).map((record) => {
    // There is one entitlement per prompt/buyer pair. Repeated status
    // writes must not move its original completed refund to a new period.
    let firstRefundAt: number | undefined;
    for (const entry of record.auditLog ?? []) {
      if (entry.status !== "refunded") continue;
      const at = entry.at instanceof Date ? entry.at.getTime()
        : typeof entry.at === "string" ? Date.parse(entry.at) : NaN;
      if (Number.isFinite(at) && (firstRefundAt === undefined || at < firstRefundAt)) {
        firstRefundAt = at;
      }
    }
    // Older/imported rows without a usable transition retain their
    // existing updatedAt fallback; no historical date is manufactured.
    return { ...record, refundedAt: new Date(firstRefundAt ?? record.updatedAt).toISOString() };
  }).filter((record) => isWithinParsedPeriod(record.refundedAt, parsedPeriod));
  // Purchase's unique compound index identifies one entitlement per pair.
  // Match its buyerWallet lowercase setter without changing prompt ID case.
  const purchaseKey = (record: { promptId: string; buyerWallet: string }) =>
    JSON.stringify([record.promptId, record.buyerWallet.toLowerCase()]);
  const pairs = new Map<string, { promptId: string; buyerWallet: string }>();
  for (const record of records) {
    pairs.set(purchaseKey(record), {
      promptId: record.promptId,
      buyerWallet: record.buyerWallet.toLowerCase(),
    });
  }

  const purchaseByPair = new Map<string, RefundPurchase>();
  const lookupPairs = [...pairs.values()];
  const batchSize = 100;
  for (let offset = 0; offset < lookupPairs.length; offset += batchSize) {
    // Do not restrict purchase dates: a refund may claw back an earlier period.
    const matches = await Purchase.find({
      $or: lookupPairs.slice(offset, offset + batchSize),
    }).lean();
    for (const purchase of matches as RefundPurchase[]) {
      const key = purchaseKey(purchase);
      if (!purchaseByPair.has(key)) purchaseByPair.set(key, purchase);
    }
  }

  const refundEvents: RefundEventInput[] = [];
  for (const f of records) {
    const matchingPurchase = purchaseByPair.get(purchaseKey(f));
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
      refundedAt: f.refundedAt,
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
    previousBalanceCarryoverStroops,
    priorSettledPeriodEnd: options.priorSettledPeriodEnd,
  });
}
