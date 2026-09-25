import { describe, expect, it } from "vitest";
import type { PromptRecord } from "@/lib/stellar/promptHashClient";
import {
  calculateCreatorAnalytics,
  formatEstimatedGrossRevenue,
} from "./creatorAnalytics";

const prompt = (overrides: Partial<PromptRecord>): PromptRecord => ({
  id: 1n,
  creator: "GCREATOR",
  priceStroops: 10_000_000n,
  title: "Prompt",
  category: "Writing",
  previewText: "Preview",
  imageUrl: "",
  salesCount: 0,
  active: true,
  contentHash: "hash",
  ...overrides,
});

describe("creator analytics", () => {
  it("calculates listing, sales, revenue, and ranking signals", () => {
    const analytics = calculateCreatorAnalytics([
      prompt({ id: 1n, priceStroops: 25_000_000n, salesCount: 2 }),
      prompt({ id: 2n, priceStroops: 10_000_000n, salesCount: 5, active: false }),
      prompt({ id: 3n, priceStroops: 7_500_000n, salesCount: 1 }),
    ]);

    expect(analytics.activeListings).toBe(2);
    expect(analytics.inactiveListings).toBe(1);
    expect(analytics.totalSales).toBe(8);
    expect(analytics.estimatedGrossRevenueStroops).toBe(107_500_000n);
    expect(analytics.topPrompts.map(({ id }) => id)).toEqual([2n, 1n, 3n]);
  });

  it("formats derived revenue as an estimate", () => {
    expect(formatEstimatedGrossRevenue(107_500_000n)).toBe("Estimated 10.75 XLM");
  });


  it("tie-breaks equal sales by ascending id without Number coercion (#178)", () => {
    const above = BigInt(Number.MAX_SAFE_INTEGER) + 9n;
    const analytics = calculateCreatorAnalytics([
      prompt({ id: above + 2n, salesCount: 4 }),
      prompt({ id: above, salesCount: 4 }),
      prompt({ id: above + 1n, salesCount: 4 }),
      prompt({ id: 1n, salesCount: 1 }),
    ]);
    expect(analytics.topPrompts.map(({ id }) => id)).toEqual([
      above,
      above + 1n,
      above + 2n,
      1n,
    ]);
  });

  it("returns a stable empty state", () => {
    expect(calculateCreatorAnalytics([])).toEqual({
      activeListings: 0,
      inactiveListings: 0,
      totalSales: 0,
      estimatedGrossRevenueStroops: 0n,
      topPrompts: [],
    });
  });
});
