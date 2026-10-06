/** Focused payout-attempt status admission for seller statements (#245). */
jest.mock("../models/Purchase", () => ({ __esModule: true, default: {} }));
jest.mock("../models/Prompt", () => ({ __esModule: true, default: {} }));
jest.mock("../models/FulfillmentRecord", () => ({ __esModule: true, default: {} }));
jest.mock("../models/User", () => ({ __esModule: true, default: {} }));
jest.mock("../models/PayoutStatement", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), findOneAndUpdate: jest.fn() },
}));

import express from "express";
import request from "supertest";
import PayoutStatementModel from "../models/PayoutStatement";
import { payoutRouter } from "../routes/payoutRoutes";
import {
  deriveStatementStatus,
  PayoutStatementStatusError,
  reconcilePayoutStatement,
  signPayoutStatement,
} from "../services/payoutStatementService";
import type { PayoutAttemptLineItem } from "../types/PayoutStatement";

const attempt = (status: unknown, attemptId = "attempt-1"): PayoutAttemptLineItem => ({
  attemptId,
  amountStroops: 950,
  status: status as PayoutAttemptLineItem["status"],
  attemptedAt: "2026-01-15T00:00:00.000Z",
  failureReason: "declined",
  txHash: `tx-${attemptId}`,
});

const input = (payoutAttempts: PayoutAttemptLineItem[]) => ({
  sellerWallet: "seller",
  period: { start: "2026-01-01", end: "2026-01-31" },
  purchases: [],
  payoutAttempts,
});

const app = express();
app.use(express.json());
app.use("/api/payouts", payoutRouter);

beforeEach(() => jest.clearAllMocks());

describe("payout attempt status admission", () => {
  it.each([undefined, null, "", "processing", "Pending", 0, false])(
    "rejects invalid status %p rather than signing a settled statement",
    (status) => {
      const attempts = [attempt(status)];
      expect(() => deriveStatementStatus(attempts)).toThrow(PayoutStatementStatusError);
      expect(() => reconcilePayoutStatement(input(attempts))).toThrow(PayoutStatementStatusError);
    },
  );

  it.each(["failed", "pending", "settled"])(
    "does not hide an invalid later row behind %s precedence",
    (status) => {
      expect(() => deriveStatementStatus([
        attempt(status), attempt("processing", "unknown"),
      ])).toThrow(PayoutStatementStatusError);
    },
  );

  it("preserves empty, failed, pending and last-settled outcomes without mutation", () => {
    expect(deriveStatementStatus([])).toEqual({ status: "pending" });
    const settled = [attempt("settled", "first"), attempt("settled", "last")];
    const original = JSON.stringify(settled);
    expect(deriveStatementStatus(settled)).toEqual({ status: "settled", payoutTxHash: "tx-last" });
    expect(JSON.stringify(settled)).toBe(original);
    expect(deriveStatementStatus([...settled, attempt("pending")])).toEqual({
      status: "pending", payoutTxHash: "tx-attempt-1",
    });
    expect(deriveStatementStatus([attempt("pending"), attempt("failed", "failure")])).toEqual({
      status: "failed", failureReason: "declined", payoutTxHash: "tx-failure",
    });
  });

  it("re-signs the canonical stored payload when settlement fields change", async () => {
    const findOne = PayoutStatementModel.findOne as jest.Mock;
    const update = PayoutStatementModel.findOneAndUpdate as jest.Mock;
    const stored = {
      _id: "mongo-id",
      __v: 2,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-02T00:00:00.000Z"),
      statementId: "stmt-signature",
      sellerWallet: "seller",
      payoutAddress: "seller",
      period: { start: "2026-01-01", end: "2026-01-31" },
      feeBps: 500,
      saleCount: 0,
      grossStroops: 0,
      platformFeeStroops: 0,
      refundSellerDebitStroops: 0,
      clawbackStroops: 0,
      previousBalanceCarryoverStroops: 0,
      netSettlementStroops: 0,
      payableStroops: 0,
      closingBalanceCarryoverStroops: 0,
      status: "pending",
      failureReason: "",
      payoutTxHash: "",
      sales: [],
      refunds: [],
      payoutAttempts: [],
      generatedAt: "2026-02-01T00:00:00.000Z",
      signature: "sha256=stale",
    };
    findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(stored) });
    update.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...stored,
        status: "settled",
        payoutTxHash: "tx-settled",
      }),
    });

    const response = await request(app)
      .patch("/api/payouts/statements/stmt-signature/status")
      .send({ status: "settled", payoutTxHash: "tx-settled" });

    const {
      _id,
      __v,
      createdAt,
      updatedAt,
      signature: _oldSignature,
      ...canonical
    } = stored;
    const expectedSignature = signPayoutStatement({
      ...canonical,
      status: "settled",
      failureReason: "",
      payoutTxHash: "tx-settled",
    });

    expect(response.status).toBe(200);
    expect(findOne).toHaveBeenCalledWith({ statementId: "stmt-signature" });
    expect(update).toHaveBeenCalledWith(
      { statementId: "stmt-signature" },
      {
        status: "settled",
        failureReason: "",
        payoutTxHash: "tx-settled",
        signature: expectedSignature,
      },
      { new: true },
    );
    expect(expectedSignature).not.toBe(stored.signature);
  });

  it("returns HTTP 400 and does not persist invalid generation input", async () => {
    const response = await request(app)
      .post("/api/payouts/statements/generate")
      .send({
        sellerWallet: "seller", periodStart: "2026-01-01", periodEnd: "2026-01-31",
        purchases: [], payoutAttempts: [attempt("processing")], persist: true,
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("payoutAttempts.status must be pending, settled, or failed");
    expect(response.body.statement).toBeUndefined();
    expect(PayoutStatementModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
