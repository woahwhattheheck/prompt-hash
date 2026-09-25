/**
 * Persisted seller payout statements — Issue #245.
 */
import mongoose from "mongoose";
import type { PayoutSettlementStatus } from "../types/PayoutStatement";

const saleLineSchema = new mongoose.Schema(
  {
    purchaseId: { type: String, required: true },
    promptId: { type: String, required: true },
    buyerWallet: { type: String, required: true, lowercase: true },
    grossStroops: { type: Number, required: true },
    platformFeeStroops: { type: Number, required: true },
    sellerNetStroops: { type: Number, required: true },
    purchasedAt: { type: String, required: true },
  },
  { _id: false },
);

const refundLineSchema = new mongoose.Schema(
  {
    purchaseId: { type: String, required: true },
    promptId: { type: String, required: true },
    sellerDebitStroops: { type: Number, required: true },
    originalGrossStroops: { type: Number, required: true },
    feeReversalStroops: { type: Number, required: true },
    refundedAt: { type: String, required: true },
    isClawback: { type: Boolean, default: false },
  },
  { _id: false },
);

const payoutAttemptSchema = new mongoose.Schema(
  {
    attemptId: { type: String, required: true },
    amountStroops: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "settled", "failed"] as PayoutSettlementStatus[],
      required: true,
    },
    attemptedAt: { type: String, required: true },
    failureReason: { type: String, default: "" },
    txHash: { type: String, default: "" },
  },
  { _id: false },
);

const payoutStatementSchema = new mongoose.Schema(
  {
    statementId: { type: String, required: true, unique: true, index: true },
    sellerWallet: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    payoutAddress: { type: String, required: true, lowercase: true },
    period: {
      start: { type: String, required: true },
      end: { type: String, required: true },
    },
    feeBps: { type: Number, required: true },
    saleCount: { type: Number, default: 0 },
    grossStroops: { type: Number, default: 0 },
    platformFeeStroops: { type: Number, default: 0 },
    refundSellerDebitStroops: { type: Number, default: 0 },
    clawbackStroops: { type: Number, default: 0 },
    previousBalanceCarryoverStroops: { type: Number, default: 0 },
    netSettlementStroops: { type: Number, default: 0 },
    payableStroops: { type: Number, default: 0 },
    closingBalanceCarryoverStroops: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "settled", "failed"] as PayoutSettlementStatus[],
      default: "pending",
      index: true,
    },
    failureReason: { type: String, default: "" },
    payoutTxHash: { type: String, default: "" },
    sales: [saleLineSchema],
    refunds: [refundLineSchema],
    payoutAttempts: [payoutAttemptSchema],
    generatedAt: { type: String, required: true },
    signature: { type: String, default: "" },
  },
  { timestamps: true },
);

payoutStatementSchema.index({ sellerWallet: 1, "period.start": -1 });

const PayoutStatementModel =
  mongoose.models.PayoutStatement ||
  mongoose.model("PayoutStatement", payoutStatementSchema);

export default PayoutStatementModel;
