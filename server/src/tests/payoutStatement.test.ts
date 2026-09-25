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
