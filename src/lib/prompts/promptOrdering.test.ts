import { describe, expect, it } from "vitest";
import type { PromptRecord } from "@/lib/stellar/promptHashClient";
import {
  priceStroopsWithinXlmBounds,
  sortPromptsBy,
  xlmBoundToStroops,
} from "./promptOrdering";

const ABOVE_SAFE = BigInt(Number.MAX_SAFE_INTEGER) + 42n;

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

describe("promptOrdering", () => {
  it("sorts extreme IDs newest/oldest without Number conversion", () => {
    const prompts = [
      prompt({ id: ABOVE_SAFE, title: "mid" }),
      prompt({ id: ABOVE_SAFE + 5n, title: "high" }),
      prompt({ id: ABOVE_SAFE - 5n, title: "low" }),
    ];

    expect(sortPromptsBy(prompts, "newest").map((p) => p.title)).toEqual([
      "high",
      "mid",
      "low",
    ]);
    expect(sortPromptsBy(prompts, "oldest").map((p) => p.title)).toEqual([
      "low",
      "mid",
      "high",
    ]);
    expect(sortPromptsBy(prompts, "recent").map((p) => p.id)).toEqual(
      sortPromptsBy(prompts, "newest").map((p) => p.id),
    );
  });

  it("sorts extreme prices asc/desc with stable id tie-break", () => {
    const huge = ABOVE_SAFE * 10_000_000n;
    const prompts = [
      prompt({ id: 3n, priceStroops: huge, title: "a" }),
      prompt({ id: 1n, priceStroops: huge, title: "b" }),
      prompt({ id: 2n, priceStroops: huge + 1n, title: "c" }),
      prompt({ id: 4n, priceStroops: 1n, title: "d" }),
    ];

    expect(sortPromptsBy(prompts, "price-low").map((p) => p.title)).toEqual([
      "d",
      "b",
      "a",
      "c",
    ]);
    expect(sortPromptsBy(prompts, "price-high").map((p) => p.title)).toEqual([
      "c",
      "b",
      "a",
      "d",
    ]);
  });

  it("keeps equal primary keys stable across repeated sorts (pagination)", () => {
    const prompts = [
      prompt({ id: ABOVE_SAFE + 2n, priceStroops: 50n, salesCount: 7 }),
      prompt({ id: ABOVE_SAFE + 1n, priceStroops: 50n, salesCount: 7 }),
      prompt({ id: ABOVE_SAFE, priceStroops: 50n, salesCount: 7 }),
    ];

    const first = sortPromptsBy(prompts, "price-low").map((p) => p.id);
    const second = sortPromptsBy(prompts, "price-low").map((p) => p.id);
    expect(first).toEqual(second);
    expect(first).toEqual([ABOVE_SAFE, ABOVE_SAFE + 1n, ABOVE_SAFE + 2n]);

    const bySales = sortPromptsBy(prompts, "sales").map((p) => p.id);
    expect(bySales).toEqual([ABOVE_SAFE, ABOVE_SAFE + 1n, ABOVE_SAFE + 2n]);
  });

  it("orders sales desc then id asc on ties", () => {
    const prompts = [
      prompt({ id: 9n, salesCount: 1 }),
      prompt({ id: 2n, salesCount: 5 }),
      prompt({ id: 8n, salesCount: 5 }),
    ];
    expect(sortPromptsBy(prompts, "sales").map((p) => p.id)).toEqual([
      2n,
      8n,
      9n,
    ]);
  });

  it("filters prices with exact stroop bounds (no float coercion)", () => {
    const edge = xlmBoundToStroops(1.5);
    expect(edge).toBe(15_000_000n);

    expect(priceStroopsWithinXlmBounds(edge, 1.5, 1.5)).toBe(true);
    expect(priceStroopsWithinXlmBounds(edge - 1n, 1.5, undefined)).toBe(false);
    expect(priceStroopsWithinXlmBounds(edge + 1n, undefined, 1.5)).toBe(false);

    // Large stroop amounts near/above safe integer remain exact via bigint bounds
    const hugePrice = ABOVE_SAFE;
    const bound = Number(xlmBoundToStroops(0)); // 0n path
    expect(bound).toBe(0);
    expect(priceStroopsWithinXlmBounds(hugePrice, 0)).toBe(true);
    expect(priceStroopsWithinXlmBounds(0n, undefined, 0)).toBe(true);
    expect(priceStroopsWithinXlmBounds(1n, undefined, 0)).toBe(false);
  });
});
