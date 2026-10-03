/**
 * Seller payout statement reconciliation — Issue #245.
 *
 * Covers:
 * 1. Balance: gross − fees − refunds (+ carryover) = net
 * 2. Pending and failed payout representation
 * 3. Refund AFTER a settled payout (clawback / next-period adjustment)
 * 4. Partial period date-range boundaries
 *
 * Fee source: DEFAULT_FEE_BPS from server/src/constants/platformFee.ts
 * (contracts/prompt-hash/src/contract.rs) — never invented USD rates.
 */

jest.mock("../models/Purchase", () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn() } }));
jest.mock("../models/Prompt", () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock("../models/FulfillmentRecord", () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock("../models/User", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../models/PayoutStatement", () => ({ __esModule: true, default: { findOneAndUpdate: jest.fn() } }));

import express from "express";
import request from "supertest";
import PayoutStatementModel from "../models/PayoutStatement";
import User from "../models/User";
import Prompt from "../models/Prompt";
import Purchase from "../models/Purchase";
import FulfillmentRecord from "../models/FulfillmentRecord";
import { payoutRouter } from "../routes/payoutRoutes";

import {
  DEFAULT_FEE_BPS,
  MAX_BPS,
  platformFeeStroops,
} from "../constants/platformFee";
import {
  deriveStatementStatus,
  exportStatementToCsv,
  exportStatementToJson,
  isWithinPeriod,
  PayoutStatementPeriodError,
  reconcilePayoutStatement,
} from "../services/payoutStatementService";
import type {
  PayoutAttemptLineItem,
  PurchaseEventInput,
  RefundEventInput,
} from "../types/PayoutStatement";

const FEE_BPS = DEFAULT_FEE_BPS; // 500 — contract default

function fee(gross: number): number {
  return platformFeeStroops(gross, FEE_BPS);
}

function sellerNet(gross: number): number {
  return gross - fee(gross);
}

const invalidStatementPeriods: Array<[string, unknown, unknown]> = [
  ["malformed start", "not-a-date", "2026-01-31T23:59:59.999Z"],
  ["malformed end", "2026-01-01T00:00:00.000Z", "not-a-date"],
  ["reversed bounds", "2026-02-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
  ["numeric start", 1767225600000, "2026-01-31T23:59:59.999Z"],
  ["array end", "2026-01-01T00:00:00.000Z", ["2026-01-31T23:59:59.999Z"]],
  ["object start", { toString: null }, "2026-01-31T23:59:59.999Z"],
  [
    "out-of-range start",
    "-271821-04-19T00:00:00.000Z",
    "2026-01-31T23:59:59.999Z",
  ],
  [
    "out-of-range end",
    "2026-01-01T00:00:00.000Z",
    "+275760-09-14T00:00:00.000Z",
  ],
];

describe("statement amount boundaries", () => {
  const period = {
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-01-31T23:59:59.999Z",
  };
  const purchase = (grossStroops: number, purchaseId = "p1"): PurchaseEventInput => ({
    purchaseId,
    promptId: "1",
    buyerWallet: "gbuyer",
    grossStroops,
    purchasedAt: "2026-01-15T00:00:00.000Z",
  });
  const refund = (originalGrossStroops: number, purchaseId = "p1"): RefundEventInput => ({
    purchaseId,
    promptId: "1",
    originalGrossStroops,
    originalPurchasedAt: "2025-12-15T00:00:00.000Z",
    refundedAt: "2026-01-15T00:00:00.000Z",
  });
  const base = { sellerWallet: "GSELLER", period, purchases: [] as PurchaseEventInput[] };

  it.each(["1", 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1])(
    "rejects an invalid carryover before signing: %p",
    (carryover) => {
      expect(() => reconcilePayoutStatement({
        ...base,
        previousBalanceCarryoverStroops: carryover as unknown as number,
      })).toThrow(RangeError);
    },
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid payout attempt amount: %p",
    (amountStroops) => {
      expect(() => reconcilePayoutStatement({
        ...base,
        payoutAttempts: [{
          attemptId: "attempt",
          amountStroops,
          status: "pending",
          attemptedAt: period.end,
        }],
      })).toThrow(RangeError);
    },
  );

  it("rejects a gross total outside the exact numeric range", () => {
    expect(() => reconcilePayoutStatement({
      ...base,
      purchases: [purchase(Number.MAX_SAFE_INTEGER), purchase(2, "p2")],
    })).toThrow(/grossStroops/);
  });

  it("rejects an overflowing refund total made from individually valid refunds", () => {
    expect(() => reconcilePayoutStatement({
      ...base,
      feeBps: 0,
      refunds: [refund(Number.MAX_SAFE_INTEGER), refund(2, "p2")],
    })).toThrow(/refundSellerDebitStroops/);
  });

  it.each([1, -1])("rejects net settlement overflow with carryover %i", (carryover) => {
    expect(() => reconcilePayoutStatement({
      ...base,
      feeBps: 0,
      purchases: carryover > 0 ? [purchase(Number.MAX_SAFE_INTEGER)] : [],
      refunds: carryover < 0 ? [refund(Number.MAX_SAFE_INTEGER)] : [],
      previousBalanceCarryoverStroops: carryover,
    })).toThrow(/netSettlementStroops/);
  });

  it.each([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])(
    "preserves a valid signed carryover boundary in JSON and CSV: %p",
    (carryover) => {
      const statement = reconcilePayoutStatement({ ...base, previousBalanceCarryoverStroops: carryover });
      expect(statement.netSettlementStroops).toBe(carryover);
      expect(JSON.parse(exportStatementToJson(statement)).netSettlementStroops).toBe(carryover);
      expect(exportStatementToCsv(statement)).toContain(`summary,netSettlementStroops,${carryover}`);
    },
  );

  it("keeps an exact maximum-safe aggregate and its fee/refund reconciliation", () => {
    const statement = reconcilePayoutStatement({
      ...base,
      purchases: [purchase(Number.MAX_SAFE_INTEGER - 1), purchase(1, "p2")],
      refunds: [refund(1, "p2")],
    });
    expect(statement.grossStroops).toBe(Number.MAX_SAFE_INTEGER);
    const expectedNet = BigInt(Number.MAX_SAFE_INTEGER) - BigInt(fee(Number.MAX_SAFE_INTEGER - 1)) - 1n;
    expect(BigInt(statement.netSettlementStroops)).toBe(expectedNet);
  });

  describe("actual payout HTTP routes", () => {
    const persist = PayoutStatementModel.findOneAndUpdate as jest.Mock;
    const findUser = User.findOne as jest.Mock;
    const findPrompts = Prompt.find as jest.Mock;
    const payload = {
      sellerWallet: base.sellerWallet,
      periodStart: period.start,
      periodEnd: period.end,
      purchases: [purchase(1000)],
    };
    const app = express();
    app.use(express.json());
    app.use("/api/payouts", payoutRouter);

    beforeEach(() => {
      jest.clearAllMocks();
      persist.mockResolvedValue({});
    });

    it.each(["1", 0.5, Number.MAX_SAFE_INTEGER + 1])(
      "rejects invalid JSON carryover %p without persisting a statement",
      async (carryover) => {
        const res = await request(app).post("/api/payouts/statements/generate").send({
          ...payload,
          previousBalanceCarryoverStroops: carryover,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("previousBalanceCarryoverStroops");
        expect(res.body.statement).toBeUndefined();
        expect(persist).not.toHaveBeenCalled();
      },
    );

    it("rejects aggregate overflow before persistence", async () => {
      const res = await request(app).post("/api/payouts/statements/generate").send({
        ...payload,
        purchases: [purchase(Number.MAX_SAFE_INTEGER), purchase(2, "p2")],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("grossStroops");
      expect(persist).not.toHaveBeenCalled();
    });

    it("rejects a nonfinite query carryover before database reads", async () => {
      findUser.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
      findPrompts.mockReturnValue({ select: () => ({ lean: jest.fn().mockResolvedValue([]) }) });
      const res = await request(app).get("/api/payouts/statements/GSELLER").query({
        from: period.start,
        to: period.end,
        carryover: "1e999",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("previousBalanceCarryoverStroops");
      expect(findUser).not.toHaveBeenCalled();
      expect(findPrompts).not.toHaveBeenCalled();
    });

    function expectNoStatementIo(): void {
      expect(persist).not.toHaveBeenCalled();
      expect(findUser).not.toHaveBeenCalled();
      expect(findPrompts).not.toHaveBeenCalled();
      expect(Purchase.find).not.toHaveBeenCalled();
      expect(Purchase.findOne).not.toHaveBeenCalled();
      expect(FulfillmentRecord.find).not.toHaveBeenCalled();
    }

    it.each(invalidStatementPeriods)(
      "rejects %s before reads or persistence in both generation modes",
      async (_name, periodStart, periodEnd) => {
        findUser.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
        findPrompts.mockReturnValue({
          select: () => ({ lean: jest.fn().mockResolvedValue([]) }),
        });
        for (const events of [{ purchases: [], refunds: [] }, {}]) {
          const res = await request(app)
            .post("/api/payouts/statements/generate")
            .send({
              sellerWallet: payload.sellerWallet,
              periodStart,
              periodEnd,
              ...events,
            });
          expect(res.status).toBe(400);
          expect(res.body.error).toMatch(/periodStart|periodEnd/);
          expect(res.body.statement).toBeUndefined();
          expectNoStatementIo();
        }
      },
    );

    it.each(
      invalidStatementPeriods.filter(
        ([, start, end]) =>
          typeof start === "string" && typeof end === "string",
      ),
    )(
      "rejects %s in a preview before database reads",
      async (_name, from, to) => {
        findUser.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
        findPrompts.mockReturnValue({
          select: () => ({ lean: jest.fn().mockResolvedValue([]) }),
        });
        const res = await request(app)
          .get("/api/payouts/statements/GSELLER")
          .query({ from, to });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/periodStart|periodEnd/);
        expect(res.body.statement).toBeUndefined();
        expectNoStatementIo();
      },
    );

    it("persists a numeric carryover as the exact numeric net", async () => {
      const res = await request(app).post("/api/payouts/statements/generate").send({
        ...payload,
        previousBalanceCarryoverStroops: 1,
      });
      expect(res.status).toBe(201);
      expect(res.body.statement.netSettlementStroops).toBe(951);
      expect(res.body.statement.payableStroops).toBe(951);
      expect(persist).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ netSettlementStroops: 951, previousBalanceCarryoverStroops: 1 }),
        expect.any(Object),
      );
    });
  });
});

describe("platformFeeStroops (contract DEFAULT_FEE_BPS)", () => {
  it("matches contracts/prompt-hash DEFAULT_FEE_BPS = 500", () => {
    expect(DEFAULT_FEE_BPS).toBe(500);
    expect(MAX_BPS).toBe(10_000);
  });

  it("floor-divides like on-chain bps_amount", () => {
    // 10 XLM = 100_000_000 stroops → fee = 5_000_000 (5%)
    expect(fee(100_000_000)).toBe(5_000_000);
    // Dust: 1 stroop * 500 / 10000 = 0
    expect(fee(1)).toBe(0);
    // 19 stroops * 500 / 10000 = 0 (floor)
    expect(fee(19)).toBe(0);
    // 20 stroops * 500 / 10000 = 1
    expect(fee(20)).toBe(1);
  });

  it.each([
    [0, 0],
    [1, 900_719_925_472],
    [500, 450_359_962_736_049],
    [3333, 3_002_099_511_598_508],
    [9999, 9_006_298_534_795_526],
    [10000, 9_007_199_254_720_999],
  ])("keeps exact contract division for a large amount at %i bps", (bps, expected) => {
    // Gross is a safe integer, but gross * bps can exceed Number's exact range.
    expect(platformFeeStroops(9_007_199_254_720_999, bps)).toBe(expected);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a gross amount outside nonnegative safe integer stroops: %s",
    (gross) => {
      expect(() => platformFeeStroops(gross)).toThrow(RangeError);
    },
  );

  it.each([-1, 0.5, NaN, Infinity, MAX_BPS + 1])(
    "rejects a fee outside the contract's integer basis-point range: %s",
    (bps) => {
      expect(() => platformFeeStroops(100_000_000, bps)).toThrow(RangeError);
    },
  );
});

describe("reconcilePayoutStatement — balance invariant", () => {
  const period = {
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-01-31T23:59:59.999Z",
  };

  it("balances gross, fees, refunds, and net payout", () => {
    const purchases: PurchaseEventInput[] = [
      {
        purchaseId: "p1",
        promptId: "10",
        buyerWallet: "gbuyer1",
        grossStroops: 100_000_000, // 10 XLM
        purchasedAt: "2026-01-10T12:00:00.000Z",
      },
      {
        purchaseId: "p2",
        promptId: "11",
        buyerWallet: "gbuyer2",
        grossStroops: 50_000_000, // 5 XLM
        purchasedAt: "2026-01-15T12:00:00.000Z",
      },
    ];

    const statement = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      payoutAddress: "GSELLER",
      period,
      purchases,
      refunds: [],
      generatedAt: "2026-02-01T00:00:00.000Z",
      statementId: "stmt_balance",
    });

    const expectedGross = 150_000_000;
    const expectedFee = fee(100_000_000) + fee(50_000_000);
    const expectedNet = expectedGross - expectedFee;

    expect(statement.feeBps).toBe(FEE_BPS);
    expect(statement.grossStroops).toBe(expectedGross);
    expect(statement.platformFeeStroops).toBe(expectedFee);
    expect(statement.refundSellerDebitStroops).toBe(0);
    expect(statement.netSettlementStroops).toBe(expectedNet);
    expect(statement.payableStroops).toBe(expectedNet);
    expect(statement.closingBalanceCarryoverStroops).toBe(0);

    // Exact invariant
    expect(statement.netSettlementStroops).toBe(
      statement.grossStroops -
        statement.platformFeeStroops -
        statement.refundSellerDebitStroops +
        statement.previousBalanceCarryoverStroops,
    );
  });

  it("same-period refund zeroes the sale contribution", () => {
    const gross = 100_000_000;
    const purchases: PurchaseEventInput[] = [
      {
        purchaseId: "p1",
        promptId: "10",
        buyerWallet: "gbuyer1",
        grossStroops: gross,
        purchasedAt: "2026-01-10T12:00:00.000Z",
      },
    ];
    const refunds: RefundEventInput[] = [
      {
        purchaseId: "p1",
        promptId: "10",
        originalGrossStroops: gross,
        refundedAt: "2026-01-20T12:00:00.000Z",
        originalPurchasedAt: "2026-01-10T12:00:00.000Z",
      },
    ];

    const statement = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      period,
      purchases,
      refunds,
      statementId: "stmt_same_period_refund",
      generatedAt: "2026-02-01T00:00:00.000Z",
    });

    // gross - fee - sellerDebit(gross - fee) = 0
    expect(statement.netSettlementStroops).toBe(0);
    expect(statement.refunds[0].isClawback).toBe(false);
    expect(statement.refundSellerDebitStroops).toBe(sellerNet(gross));
    expect(statement.netSettlementStroops).toBe(
      statement.grossStroops -
        statement.platformFeeStroops -
        statement.refundSellerDebitStroops +
        statement.previousBalanceCarryoverStroops,
    );
  });

  it("retains exact large sale and refund fees in statement exports", () => {
    const gross = 9_007_199_254_720_999;
    const statement = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      period,
      purchases: [{
        purchaseId: "large-sale",
        promptId: "10",
        buyerWallet: "gbuyer",
        grossStroops: gross,
        purchasedAt: "2026-01-10T12:00:00.000Z",
      }],
      refunds: [{
        purchaseId: "large-sale",
        promptId: "10",
        originalGrossStroops: gross,
        refundedAt: "2026-01-20T12:00:00.000Z",
        originalPurchasedAt: "2026-01-10T12:00:00.000Z",
      }],
      statementId: "stmt_large_refund",
      generatedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(statement.platformFeeStroops).toBe(450_359_962_736_049);
    expect(statement.refunds[0].feeReversalStroops).toBe(450_359_962_736_049);
    expect(statement.refundSellerDebitStroops).toBe(8_556_839_291_984_950);
    expect(statement.netSettlementStroops).toBe(0);
    expect(JSON.parse(exportStatementToJson(statement)).platformFeeStroops)
      .toBe(450_359_962_736_049);
    expect(exportStatementToCsv(statement))
      .toContain("summary,platformFeeStroops,450359962736049");
  });

  it("applies previousBalanceCarryover to the balance identity", () => {
    const statement = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      period,
      purchases: [
        {
          purchaseId: "p1",
          promptId: "10",
          buyerWallet: "gbuyer1",
          grossStroops: 20_000_000,
          purchasedAt: "2026-01-12T00:00:00.000Z",
        },
      ],
      previousBalanceCarryoverStroops: -5_000_000,
      statementId: "stmt_carry",
      generatedAt: "2026-02-01T00:00:00.000Z",
    });

    const expectedNet =
      20_000_000 - fee(20_000_000) - 0 + -5_000_000;
    expect(statement.netSettlementStroops).toBe(expectedNet);
    expect(statement.netSettlementStroops).toBe(
      statement.grossStroops -
        statement.platformFeeStroops -
        statement.refundSellerDebitStroops +
        statement.previousBalanceCarryoverStroops,
    );
  });
});

describe("pending and failed payout representation", () => {
  const period = {
    start: "2026-02-01T00:00:00.000Z",
    end: "2026-02-28T23:59:59.999Z",
  };

  it("defaults to pending when no payout attempts exist", () => {
    const statement = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      period,
      purchases: [],
      statementId: "stmt_pending_empty",
      generatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(statement.status).toBe("pending");
    expect(statement.payoutAttempts).toEqual([]);
  });

  it("represents a pending payout attempt on the statement", () => {
    const statement = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      period,
      purchases: [
        {
          purchaseId: "p1",
          promptId: "1",
          buyerWallet: "gb",
          grossStroops: 10_000_000,
          purchasedAt: "2026-02-05T00:00:00.000Z",
        },
      ],
      payoutAttempts: [
        {
          attemptId: "att_1",
          amountStroops: sellerNet(10_000_000),
          status: "pending",
          attemptedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      statementId: "stmt_pending",
      generatedAt: "2026-03-01T00:00:00.000Z",
    });

    expect(statement.status).toBe("pending");
    expect(statement.payoutAttempts).toHaveLength(1);
    expect(statement.payoutAttempts[0].status).toBe("pending");
  });

  it("represents a failed payout with failure reason", () => {
    const statement = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      period,
      purchases: [
        {
          purchaseId: "p1",
          promptId: "1",
          buyerWallet: "gb",
          grossStroops: 10_000_000,
          purchasedAt: "2026-02-05T00:00:00.000Z",
        },
      ],
      payoutAttempts: [
        {
          attemptId: "att_fail",
          amountStroops: sellerNet(10_000_000),
          status: "failed",
          attemptedAt: "2026-03-01T00:00:00.000Z",
          failureReason: "Destination account not funded",
        },
      ],
      statementId: "stmt_failed",
      generatedAt: "2026-03-01T00:00:00.000Z",
    });

    expect(statement.status).toBe("failed");
    expect(statement.failureReason).toBe("Destination account not funded");
    expect(statement.payoutAttempts[0].status).toBe("failed");
  });

  it("deriveStatementStatus prefers failed over pending over settled", () => {
    const attempts: PayoutAttemptLineItem[] = [
      {
        attemptId: "a1",
        amountStroops: 1,
        status: "settled",
        attemptedAt: "2026-01-01T00:00:00.000Z",
        txHash: "tx1",
      },
      {
        attemptId: "a2",
        amountStroops: 1,
        status: "pending",
        attemptedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    expect(deriveStatementStatus(attempts).status).toBe("pending");

    attempts.push({
      attemptId: "a3",
      amountStroops: 1,
      status: "failed",
      attemptedAt: "2026-01-03T00:00:00.000Z",
      failureReason: "horizon timeout",
    });
    expect(deriveStatementStatus(attempts).status).toBe("failed");
  });
});

describe("refund AFTER a settled payout (clawback)", () => {
  it("marks prior-period refunds as clawbacks and carries deficit forward", () => {
    // Period 1 (settled): one sale of 10 XLM, net paid to seller.
    const priorGross = 100_000_000;
    const priorPeriodEnd = "2026-01-31T23:59:59.999Z";

    // Period 2: no new sales; refund for the period-1 sale arrives.
    const statement = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      period: {
        start: "2026-02-01T00:00:00.000Z",
        end: "2026-02-28T23:59:59.999Z",
      },
      purchases: [],
      refunds: [
        {
          purchaseId: "p_prior",
          promptId: "42",
          originalGrossStroops: priorGross,
          refundedAt: "2026-02-10T12:00:00.000Z",
          originalPurchasedAt: "2026-01-15T12:00:00.000Z",
        },
      ],
      priorSettledPeriodEnd: priorPeriodEnd,
      statementId: "stmt_clawback",
      generatedAt: "2026-03-01T00:00:00.000Z",
    });

    expect(statement.refunds).toHaveLength(1);
    expect(statement.refunds[0].isClawback).toBe(true);
    expect(statement.clawbackStroops).toBe(sellerNet(priorGross));
    expect(statement.refundSellerDebitStroops).toBe(sellerNet(priorGross));
    expect(statement.grossStroops).toBe(0);
    expect(statement.platformFeeStroops).toBe(0);
    expect(statement.netSettlementStroops).toBe(-sellerNet(priorGross));
    expect(statement.payableStroops).toBe(0);
    expect(statement.closingBalanceCarryoverStroops).toBe(
      -sellerNet(priorGross),
    );

    // Next period absorbs the clawback carryover.
    const next = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      period: {
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-03-31T23:59:59.999Z",
      },
      purchases: [
        {
          purchaseId: "p_new",
          promptId: "99",
          buyerWallet: "gb",
          grossStroops: 200_000_000,
          purchasedAt: "2026-03-05T00:00:00.000Z",
        },
      ],
      previousBalanceCarryoverStroops:
        statement.closingBalanceCarryoverStroops,
      statementId: "stmt_after_clawback",
      generatedAt: "2026-04-01T00:00:00.000Z",
    });

    expect(next.netSettlementStroops).toBe(
      200_000_000 -
        fee(200_000_000) -
        0 +
        statement.closingBalanceCarryoverStroops,
    );
    expect(next.netSettlementStroops).toBe(
      next.grossStroops -
        next.platformFeeStroops -
        next.refundSellerDebitStroops +
        next.previousBalanceCarryoverStroops,
    );
  });
});

describe("partial periods (date-range boundaries)", () => {
  it.each(invalidStatementPeriods)(
    "rejects %s even when no purchase or refund can trigger date parsing",
    (_name, start, end) => {
      expect(() =>
        reconcilePayoutStatement({
          sellerWallet: "GSELLER",
          period: { start: start as string, end: end as string },
          purchases: [],
          refunds: [],
        }),
      ).toThrow(PayoutStatementPeriodError);
    },
  );

  it.each([
    ["reversed bounds", "2026-01-01T00:00:00.000Z"],
    ["a malformed end after all events predate the start", "not-a-date"],
  ])("rejects %s instead of silently discarding real events", (_name, end) => {
    expect(() =>
      reconcilePayoutStatement({
        sellerWallet: "GSELLER",
        period: { start: "2026-02-01T00:00:00.000Z", end },
        purchases: [
          {
            purchaseId: "p1",
            promptId: "1",
            buyerWallet: "gbuyer",
            grossStroops: 1000,
            purchasedAt: "2026-01-15T00:00:00.000Z",
          },
        ],
        refunds: [
          {
            purchaseId: "p1",
            promptId: "1",
            originalGrossStroops: 1000,
            originalPurchasedAt: "2026-01-15T00:00:00.000Z",
            refundedAt: "2026-01-16T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow(PayoutStatementPeriodError);
  });

  it.each([
    ["equal instants", "2026-01-10T00:00:00.000Z", "2026-01-10T00:00:00.000Z"],
    ["date-only bounds", "2026-01-10", "2026-01-11"],
    [
      "timezone offsets whose text order differs from their instant order",
      "2026-01-10T02:00:00.000+02:00",
      "2026-01-10T00:30:00.000Z",
    ],
  ])(
    "preserves inclusive purchases and refunds for %s",
    (_name, start, end) => {
      const period = { start, end };
      const events = [
        { id: "before", at: new Date(Date.parse(start) - 1).toISOString() },
        { id: "start", at: new Date(start).toISOString() },
        { id: "end", at: new Date(end).toISOString() },
        { id: "after", at: new Date(Date.parse(end) + 1).toISOString() },
      ];
      const statement = reconcilePayoutStatement({
        sellerWallet: "GSELLER",
        period,
        purchases: events.map(({ id, at }) => ({
          purchaseId: id,
          promptId: "1",
          buyerWallet: "gbuyer",
          grossStroops: 1000,
          purchasedAt: at,
        })),
        refunds: events.map(({ id, at }) => ({
          purchaseId: `refund_${id}`,
          promptId: "1",
          originalGrossStroops: 100,
          originalPurchasedAt: "2026-01-01T00:00:00.000Z",
          refundedAt: at,
        })),
      });
      expect(statement.period).toEqual(period);
      expect(statement.sales.map(({ purchaseId }) => purchaseId)).toEqual([
        "start",
        "end",
      ]);
      expect(statement.refunds.map(({ purchaseId }) => purchaseId)).toEqual([
        "refund_start",
        "refund_end",
      ]);
      expect(statement.saleCount).toBe(2);
      expect(statement.grossStroops).toBe(2000);
      expect(statement.signature).toMatch(/^sha256=[a-f0-9]{64}$/);
    },
  );

  it("includes events on inclusive start and end boundaries", () => {
    expect(
      isWithinPeriod(
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-31T23:59:59.999Z",
      ),
    ).toBe(true);
    expect(
      isWithinPeriod(
        "2026-01-31T23:59:59.999Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-31T23:59:59.999Z",
      ),
    ).toBe(true);
  });

  it("excludes purchases outside the requested partial window", () => {
    const period = {
      start: "2026-01-10T00:00:00.000Z",
      end: "2026-01-20T23:59:59.999Z",
    };

    const statement = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      period,
      purchases: [
        {
          purchaseId: "before",
          promptId: "1",
          buyerWallet: "gb",
          grossStroops: 10_000_000,
          purchasedAt: "2026-01-09T23:59:59.999Z",
        },
        {
          purchaseId: "start_edge",
          promptId: "2",
          buyerWallet: "gb",
          grossStroops: 20_000_000,
          purchasedAt: "2026-01-10T00:00:00.000Z",
        },
        {
          purchaseId: "mid",
          promptId: "3",
          buyerWallet: "gb",
          grossStroops: 30_000_000,
          purchasedAt: "2026-01-15T12:00:00.000Z",
        },
        {
          purchaseId: "end_edge",
          promptId: "4",
          buyerWallet: "gb",
          grossStroops: 40_000_000,
          purchasedAt: "2026-01-20T23:59:59.999Z",
        },
        {
          purchaseId: "after",
          promptId: "5",
          buyerWallet: "gb",
          grossStroops: 50_000_000,
          purchasedAt: "2026-01-21T00:00:00.000Z",
        },
      ],
      refunds: [
        {
          purchaseId: "refund_outside",
          promptId: "9",
          originalGrossStroops: 10_000_000,
          refundedAt: "2026-01-09T00:00:00.000Z",
          originalPurchasedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          purchaseId: "refund_inside",
          promptId: "2",
          originalGrossStroops: 20_000_000,
          refundedAt: "2026-01-18T00:00:00.000Z",
          originalPurchasedAt: "2026-01-10T00:00:00.000Z",
        },
      ],
      statementId: "stmt_partial",
      generatedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(statement.sales.map((s) => s.purchaseId).sort()).toEqual([
      "end_edge",
      "mid",
      "start_edge",
    ]);
    expect(statement.grossStroops).toBe(20_000_000 + 30_000_000 + 40_000_000);
    expect(statement.refunds).toHaveLength(1);
    expect(statement.refunds[0].purchaseId).toBe("refund_inside");
    expect(statement.netSettlementStroops).toBe(
      statement.grossStroops -
        statement.platformFeeStroops -
        statement.refundSellerDebitStroops +
        statement.previousBalanceCarryoverStroops,
    );
  });
});

describe("CSV / JSON export", () => {
  it("exports JSON that round-trips key fields", () => {
    const statement = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      period: {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-31T23:59:59.999Z",
      },
      purchases: [
        {
          purchaseId: "p1",
          promptId: "1",
          buyerWallet: "gb",
          grossStroops: 10_000_000,
          purchasedAt: "2026-01-05T00:00:00.000Z",
        },
      ],
      statementId: "stmt_export",
      generatedAt: "2026-02-01T00:00:00.000Z",
    });

    const parsed = JSON.parse(exportStatementToJson(statement));
    expect(parsed.statementId).toBe("stmt_export");
    expect(parsed.feeBps).toBe(DEFAULT_FEE_BPS);
    expect(parsed.netSettlementStroops).toBe(statement.netSettlementStroops);
  });

  it("exports CSV with summary and line-item sections", () => {
    const statement = reconcilePayoutStatement({
      sellerWallet: "GSELLER",
      period: {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-31T23:59:59.999Z",
      },
      purchases: [
        {
          purchaseId: "p1",
          promptId: "1",
          buyerWallet: "gb",
          grossStroops: 10_000_000,
          purchasedAt: "2026-01-05T00:00:00.000Z",
        },
      ],
      payoutAttempts: [
        {
          attemptId: "att_1",
          amountStroops: sellerNet(10_000_000),
          status: "failed",
          attemptedAt: "2026-02-01T00:00:00.000Z",
          failureReason: 'Account "memo" required',
        },
      ],
      statementId: "stmt_csv",
      generatedAt: "2026-02-01T00:00:00.000Z",
    });

    const csv = exportStatementToCsv(statement);
    expect(csv).toContain("summary,feeBps,500");
    expect(csv).toContain("summary,status,failed");
    expect(csv).toContain("sales,purchaseId,promptId");
    expect(csv).toContain("p1");
    expect(csv).toContain("payoutAttempts");
    // Escaped quotes in failure reason
    expect(csv).toContain('Account ""memo"" required');
  });

  it("uses existing payoutAddress when provided (never invents one)", () => {
    const statement = reconcilePayoutStatement({
      sellerWallet: "GCREATORWALLET",
      payoutAddress: "GEXISTINGPAYOUTFROMSETTINGS",
      period: {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-31T23:59:59.999Z",
      },
      purchases: [],
      statementId: "stmt_addr",
      generatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(statement.payoutAddress).toBe("gexistingpayoutfromsettings");
    expect(statement.sellerWallet).toBe("gcreatorwallet");
  });
});
