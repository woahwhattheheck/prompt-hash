/** Focused reconciliation repair truth cases (#144). */

jest.mock("../models/Purchase", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("../models/FulfillmentRecord", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn() },
}));
jest.mock("../models/WebhookDeliveryLog", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("../models/ReconciliationReport", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("./webhookDispatcher", () => ({
  dispatchEvent: jest.fn(),
}));

import FulfillmentRecord from "../models/FulfillmentRecord";
import ReconciliationReport from "../models/ReconciliationReport";
import { dispatchEvent } from "./webhookDispatcher";
import { executeRepair } from "./reconciliationService";

const APPROVER = "reconciliation-approver";

function report(overrides: Record<string, unknown> = {}) {
  return {
    reportId: "rec-test",
    isDryRun: false,
    approvedBy: undefined,
    status: "generated",
    mismatches: [],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("reconciliation repair truth", () => {
  it("never mutates a dry-run report", async () => {
    const item = {
      type: "webhook_undelivered",
      promptId: "prompt-1",
      buyerWallet: "GTEST",
      repairStatus: "pending",
    };
    const dryRun = report({ isDryRun: true, mismatches: [item] });
    (ReconciliationReport.findOne as jest.Mock).mockResolvedValue(dryRun);

    await expect(executeRepair(dryRun.reportId, APPROVER))
      .rejects.toThrow("Dry-run reconciliation reports cannot be repaired.");

    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(FulfillmentRecord.findOneAndUpdate).not.toHaveBeenCalled();
    expect(dryRun.save).not.toHaveBeenCalled();
    expect(item.repairStatus).toBe("pending");
  });

  it("does not fabricate delivered fulfillment without independent proof", async () => {
    const item = {
      type: "missing_fulfillment",
      promptId: "prompt-2",
      buyerWallet: "GTEST",
      txHash: "tx-hash",
      repairStatus: "pending",
    };
    const nonDryRun = report({ mismatches: [item] });
    (ReconciliationReport.findOne as jest.Mock).mockResolvedValue(nonDryRun);

    const result = await executeRepair(nonDryRun.reportId, APPROVER);

    expect(result.repairedCount).toBe(0);
    expect(item.repairStatus).toBe("skipped");
    expect((item as any).repairError).toContain("independent verification");
    expect(FulfillmentRecord.findOneAndUpdate).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(nonDryRun.save).toHaveBeenCalledTimes(1);
    expect(nonDryRun.status).toBe("partially_repaired");
  });

  it("still repairs a genuine webhook delivery failure", async () => {
    const item = {
      type: "webhook_undelivered",
      promptId: "prompt-3",
      buyerWallet: "GTEST",
      repairStatus: "pending",
    };
    const nonDryRun = report({ mismatches: [item] });
    (ReconciliationReport.findOne as jest.Mock).mockResolvedValue(nonDryRun);
    (dispatchEvent as jest.Mock).mockResolvedValue(undefined);

    const result = await executeRepair(nonDryRun.reportId, APPROVER);

    expect(dispatchEvent).toHaveBeenCalledWith(
      "GTEST",
      "PromptPurchased",
      {
        promptId: "prompt-3",
        buyerWallet: "GTEST",
        reconciled: true,
      },
    );
    expect(result.repairedCount).toBe(1);
    expect(item.repairStatus).toBe("completed");
    expect((item as any).repairedAt).toBeInstanceOf(Date);
    expect(nonDryRun.status).toBe("fully_repaired");
    expect(nonDryRun.save).toHaveBeenCalledTimes(1);
  });
});
