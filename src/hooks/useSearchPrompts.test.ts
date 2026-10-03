import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptRecord } from "@/lib/stellar/promptHashClient";
import { useSearchPrompts } from "./useSearchPrompts";

const { getAllPrompts, useQuery } = vi.hoisted(() => ({
  getAllPrompts: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/lib/stellar/promptHashClient", () => ({ getAllPrompts }));
vi.mock("@/lib/stellar/browserConfig", () => ({ browserStellarConfig: {} }));

const prompt = (id: bigint, priceStroops: bigint): PromptRecord => ({
  id,
  priceStroops,
  creator: "GCREATOR",
  title: "Prompt",
  category: "Writing",
  previewText: "Preview",
  imageUrl: "",
  salesCount: 0,
  active: true,
  contentHash: "hash",
});

async function search(filters: Parameters<typeof useSearchPrompts>[0]) {
  useSearchPrompts(filters);
  const [{ queryFn }] = useQuery.mock.calls.at(-1)!;
  return queryFn();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("search unavailable")),
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("search fallback price bounds", () => {
  it("keeps exact inclusive stroop boundaries and deterministic pagination", async () => {
    const id = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    getAllPrompts.mockResolvedValue([
      prompt(id + 3n, 12_345_678n),
      prompt(id, 12_345_677n),
      prompt(id + 2n, 12_345_678n),
      prompt(id + 4n, 12_345_679n),
      { ...prompt(id + 1n, 12_345_678n), active: false },
    ]);

    const filters = {
      minPrice: 1.2345678,
      maxPrice: 1.2345678,
      sortBy: "price-low" as const,
      limit: 1,
    };
    const first = await search(filters);
    const second = await search({ ...filters, page: 2 });
    expect(first.prompts.map((p: PromptRecord) => p.id)).toEqual([id + 2n]);
    expect(second.prompts.map((p: PromptRecord) => p.id)).toEqual([id + 3n]);
    expect(first).toMatchObject({
      total: 2,
      page: 1,
      totalPages: 2,
      hasMore: true,
    });
    expect(second).toMatchObject({
      total: 2,
      page: 2,
      totalPages: 2,
      hasMore: false,
    });
  });

  it.each([
    [{ minPrice: 1 }, [2n, 1n]],
    [{ maxPrice: 1 }, [1n, 0n]],
    [{ minPrice: 0, maxPrice: 0 }, [0n]],
    [{}, [2n, 1n, 0n]],
  ])("preserves omitted and zero bounds: %j", async (filters, expectedIds) => {
    getAllPrompts.mockResolvedValue([
      prompt(0n, 0n),
      prompt(1n, 10_000_000n),
      prompt(2n, 20_000_000n),
    ]);
    const result = await search(filters);
    expect(result.prompts.map((p: PromptRecord) => p.id)).toEqual(expectedIds);
  });

  it("keeps bound parsing work constant as the listing count grows", async () => {
    const parsing = vi.spyOn(Number.prototype, "toFixed");
    for (const count of [10, 10_000]) {
      getAllPrompts.mockResolvedValue(
        Array.from({ length: count }, (_, i) => prompt(BigInt(i), 15_000_000n)),
      );
      parsing.mockClear();
      const result = await search({ minPrice: 1, maxPrice: 2, limit: 20 });
      expect(result.total).toBe(count);
      expect(result.prompts).toHaveLength(Math.min(count, 20));
      expect(parsing).toHaveBeenCalledTimes(2);
    }
  });
});
