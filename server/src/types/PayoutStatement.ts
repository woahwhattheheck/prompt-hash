/**
 * Typed seller payout statement schema — Issue #245.
 *
 * All monetary fields are integers in Stellar stroops (1 XLM = 10_000_000
 * stroops) to avoid floating-point drift. Platform fees are derived from
 * DEFAULT_FEE_BPS in server/src/constants/platformFee.ts (sourced from
 * contracts/prompt-hash/src/contract.rs), never from invented USD rates.
 */

/** Settlement lifecycle for a statement or payout attempt. */
export type PayoutSettlementStatus = "pending" | "settled" | "failed";

/** Inclusive billing period boundaries (ISO-8601 timestamps or dates). */
export interface PayoutPeriod {
  /** Inclusive period start. */
  start: string;
  /** Inclusive period end. */
  end: string;
}

/** One confirmed purchase credited to the seller in the period. */
export interface SaleLineItem {
  purchaseId: string;
  promptId: string;
  buyerWallet: string;
  /** Gross sale amount in stroops. */
  grossStroops: number;
  /** Platform fee in stroops = floor(gross * feeBps / 10000). */
  platformFeeStroops: number;
  /** Seller credit before refunds: gross − fee. */
  sellerNetStroops: number;
  purchasedAt: string;
}

/** Refund that debits the seller (same-period or prior-period clawback). */
export interface RefundLineItem {
  purchaseId: string;
  promptId: string;
  /**
   * Amount debited from the seller (typically original seller net =
   * gross − platform fee). Full gross is returned to the buyer on-chain;
   * the platform fee is reversed separately and is not double-counted here.
   */
  sellerDebitStroops: number;
  /** Original purchase gross, for audit. */
  originalGrossStroops: number;
  /** Fee reversed on refund (audit only; already excluded from seller debit). */
  feeReversalStroops: number;
  refundedAt: string;
  /**
   * True when the original purchase settled in a prior statement that was
   * already paid out — this period must claw the seller debit back.
   */
  isClawback: boolean;
}

/** Explicit payout attempt against a statement net. */
export interface PayoutAttemptLineItem {
  attemptId: string;
  amountStroops: number;
  status: PayoutSettlementStatus;
  attemptedAt: string;
  failureReason?: string;
  txHash?: string;
}

/**
 * Complete payout statement for a seller over a billing period.
 *
 * Invariant (must hold for every generated statement):
 *   netSettlementStroops =
 *     grossStroops
 *     − platformFeeStroops
 *     − refundSellerDebitStroops
 *     + previousBalanceCarryoverStroops
 *
 * Pending/failed payout attempts are represented on `status` and
 * `payoutAttempts` without altering the reconciliation identity above.
 * When netSettlementStroops < 0, closingBalanceCarryoverStroops carries the
 * deficit into the next period and payableStroops is 0.
 */
export interface PayoutStatement {
  statementId: string;
  /** Seller wallet (creator). */
  sellerWallet: string;
  /**
   * Destination from User.payoutSettings.payoutAddress when present,
   * otherwise the seller wallet. Never invent routing addresses.
   */
  payoutAddress: string;
  period: PayoutPeriod;

  /** Fee rate applied (bps). Always DEFAULT_FEE_BPS unless overridden by stored fields. */
  feeBps: number;

  saleCount: number;
  grossStroops: number;
  platformFeeStroops: number;
  /** Sum of seller debits from same-period refunds + clawbacks. */
  refundSellerDebitStroops: number;
  /** Portion of refundSellerDebitStroops that are prior-period clawbacks. */
  clawbackStroops: number;
  /** Carry-in from a prior negative closing balance. */
  previousBalanceCarryoverStroops: number;

  /**
   * Reconciled net before payout attempt status:
   * gross − fees − refunds + carryover.
   */
  netSettlementStroops: number;
  /** Amount actually payable this period (max(net, 0)). */
  payableStroops: number;
  /** Negative net carried to the next period (min(net, 0)). */
  closingBalanceCarryoverStroops: number;

  status: PayoutSettlementStatus;
  failureReason?: string;
  payoutTxHash?: string;

  sales: SaleLineItem[];
  refunds: RefundLineItem[];
  payoutAttempts: PayoutAttemptLineItem[];

  generatedAt: string;
  signature?: string;
}

/** Raw purchase event used by the aggregator (amounts already in stroops). */
export interface PurchaseEventInput {
  purchaseId: string;
  promptId: string;
  buyerWallet: string;
  grossStroops: number;
  purchasedAt: string;
}

/** Raw refund event. */
export interface RefundEventInput {
  purchaseId: string;
  promptId: string;
  /** Original purchase gross in stroops (fee recomputed via DEFAULT_FEE_BPS). */
  originalGrossStroops: number;
  refundedAt: string;
  /** When the original purchase occurred (to detect clawback). */
  originalPurchasedAt: string;
}

/** Raw payout attempt event. */
export interface PayoutAttemptInput {
  attemptId: string;
  amountStroops: number;
  status: PayoutSettlementStatus;
  attemptedAt: string;
  failureReason?: string;
  txHash?: string;
}

export interface ReconcilePayoutInput {
  sellerWallet: string;
  /** Existing payout settings address; falls back to sellerWallet. */
  payoutAddress?: string;
  period: PayoutPeriod;
  purchases: PurchaseEventInput[];
  refunds?: RefundEventInput[];
  payoutAttempts?: PayoutAttemptInput[];
  /** Carry-in from previous statement closing balance. */
  previousBalanceCarryoverStroops?: number;
  /**
   * End timestamp of the most recently settled prior statement. Refunds for
   * purchases at/before this instant become clawbacks in the current period.
   */
  priorSettledPeriodEnd?: string;
  feeBps?: number;
  statementId?: string;
  generatedAt?: string;
}
