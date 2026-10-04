import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptRecord } from "@/lib/stellar/promptHashClient";
import { useFeaturedPrompts, useSearchPrompts } from "./useSearchPrompts";

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

describe.each(["search", "featured"] as const)(
  "%s API price conversion",
  (kind) => {
    it.each([
      [2.01, 20_100_000n],
      [4.02, 40_200_000n],
      ["2.01", 20_100_000n],
      ["900719925.4740991", 9_007_199_254_740_991n],
      ["900719925.4740997", 9_007_199_254_740_997n],
      ["123456789012.1234567", 1_234_567_890_121_234_567n],
      ["0", 0n],
      [0, 0n],
      [1.5, 15_000_000n],
      [1.2345678, 12_345_678n],
      [1_000_000_000.25, 10_000_000_002_500_000n],
      [undefined, 0n],
    ])(
      "preserves the exact stroop value of %j XLM",
      async (price, expected) => {
        const apiPrompt = {
          onChainId: "9007199254740993",
          price,
          title: "Indexed prompt",
          category: "Writing",
          content: "Preview",
          owner: { walletAddress: "GCREATOR" },
          isActive: true,
        };
        vi.mocked(fetch).mockResolvedValueOnce({
          ok: true,
          json: async () =>
            kind === "search"
              ? {
                  prompts: [apiPrompt],
                  total: 1,
                  page: 1,
                  totalPages: 1,
                  hasMore: false,
                }
              : [apiPrompt],
        } as Response);

        if (kind === "search") useSearchPrompts({});
        else useFeaturedPrompts();
        const [{ queryFn }] = useQuery.mock.calls.at(-1)!;
        const result = await queryFn();
        const prompts = kind === "search" ? result.prompts : result;

        expect(prompts).toHaveLength(1);
        expect(prompts[0].id).toBe(9_007_199_254_740_993n);
        expect(prompts[0].priceStroops).toBe(expected);
        expect(getAllPrompts).not.toHaveBeenCalled();
      },
    );
  },
);

it("keeps a successful indexed price within equal inclusive XLM bounds", async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      prompts: [
        {
          onChainId: "1",
          price: 2.01,
          title: "Exact boundary",
          category: "Writing",
          content: "Preview",
          isActive: true,
        },
      ],
      total: 1,
      page: 1,
      totalPages: 1,
      hasMore: false,
    }),
  } as Response);

  const result = await search({ minPrice: 2.01, maxPrice: 2.01 });
  expect(result.prompts[0].priceStroops).toBe(20_100_000n);
  expect(result).toMatchObject({
    total: 1,
    page: 1,
    totalPages: 1,
    hasMore: false,
  });
  expect(getAllPrompts).not.toHaveBeenCalled();
});
