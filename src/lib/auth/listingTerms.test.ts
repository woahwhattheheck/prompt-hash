// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeListingTerms,
  diffListingTerms,
  formatTermsChangeMessage,
  hashListingTerms,
  listingTermsMatch,
  ListingTermsChangedError,
  toListingQuote,
  xlmToStroopsString,
  type ListingTerms,
} from "./listingTerms";
import { resolveListingQuote } from "./resolveListingQuote";

const { findPromptById, findPromptByChainId, findUserById } = vi.hoisted(() => ({
  findPromptById: vi.fn(),
  findPromptByChainId: vi.fn(),
  findUserById: vi.fn(),
}));

vi.mock("../../../server/src/db/connectDb", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../server/src/models/Prompt", () => ({
  default: {
    findById: (id: string) => ({ lean: () => findPromptById(id) }),
    findOne: (filter: { onChainId: string }) => ({
      lean: () => findPromptByChainId(filter),
    }),
  },
}));

vi.mock("../../../server/src/models/User", () => ({
  default: {
    findById: (id: string) => ({ lean: () => findUserById(id) }),
  },
}));

const baseTerms = (): ListingTerms => ({
  promptId: "42",
  versionIndex: 1,
  priceStroops: "50000000",
  asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  seller: "GCREATORACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789",
  active: true,
});

describe("listingTerms (#239)", () => {
  it("hashes canonical terms stably and case-normalizes seller", () => {
    const a = baseTerms();
    const b = { ...baseTerms(), seller: a.seller.toLowerCase() };
    expect(hashListingTerms(a)).toBe(hashListingTerms(b));
    expect(canonicalizeListingTerms(a)).toContain("50000000");
  });

  it("converts XLM to stroops strings", () => {
    expect(xlmToStroopsString(5)).toBe("50000000");
    expect(xlmToStroopsString(0.1)).toBe("1000000");
  });

  it("detects price changes", () => {
    const changes = diffListingTerms(baseTerms(), {
      ...baseTerms(),
      priceStroops: "75000000",
    });
    expect(changes).toEqual(["price"]);
    expect(formatTermsChangeMessage(changes)).toMatch(/price/i);
  });

  it("detects asset changes", () => {
    const changes = diffListingTerms(baseTerms(), {
      ...baseTerms(),
      asset: "CASSETCHANGED0000000000000000000000000000000000000000000",
    });
    expect(changes).toEqual(["asset"]);
  });

  it("detects seller changes", () => {
    const changes = diffListingTerms(baseTerms(), {
      ...baseTerms(),
      seller: "GBUYERACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789",
    });
    expect(changes).toEqual(["seller"]);
  });

  it("detects version changes", () => {
    const changes = diffListingTerms(baseTerms(), {
      ...baseTerms(),
      versionIndex: 3,
    });
    expect(changes).toEqual(["version"]);
  });

  it("matches identical terms and builds a quote", () => {
    const quote = toListingQuote(baseTerms());
    expect(listingTermsMatch(baseTerms(), quote)).toBe(true);
    expect(quote.termsHash).toHaveLength(64);
  });

  it("ListingTermsChangedError carries refreshed quote", () => {
    const quote = toListingQuote({ ...baseTerms(), priceStroops: "90000000" });
    const err = new ListingTermsChangedError(["price"], quote);
    expect(err.code).toBe("TERMS_CHANGED");
    expect(err.quote.priceStroops).toBe("90000000");
    expect(err.message).toMatch(/price/i);
  });
});

describe("resolveListingQuote ID mapping (#239)", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  function mockListing(onChainId = "7") {
    const prompt = {
      _id: "64f1c7a1b2c3d4e5f6071829",
      onChainId,
      owner: "64f1c7a1b2c3d4e5f6071830",
      price: 5,
      currentVersionIndex: 2,
      isActive: true,
    };
    findPromptById.mockImplementation(async (id: string) =>
      id === prompt._id ? prompt : null,
    );
    findPromptByChainId.mockImplementation(async (filter: { onChainId: string }) =>
      filter.onChainId === prompt.onChainId ? prompt : null,
    );
    findUserById.mockResolvedValue({ walletAddress: baseTerms().seller });
    return prompt;
  }

  it.each(["7", "9007199254740993"])(
    "resolves indexed on-chain prompt %s without ObjectId lookup",
    async (promptId) => {
      mockListing(promptId);
      const quote = await resolveListingQuote(promptId);
      expect(quote).toMatchObject({
        promptId,
        priceStroops: "50000000",
        versionIndex: 2,
        seller: baseTerms().seller,
        active: true,
      });
      expect(findPromptByChainId).toHaveBeenCalledWith({ onChainId: promptId });
      expect(findPromptById).not.toHaveBeenCalled();
    },
  );

  it("canonicalizes the indexed numeric ID without rewriting the quote binding", async () => {
    mockListing("7");
    const quote = await resolveListingQuote("0007");
    expect(quote.promptId).toBe("0007");
    expect(findPromptByChainId).toHaveBeenCalledWith({ onChainId: "7" });
  });

  it("preserves existing nondecimal document-ID quote lookup", async () => {
    const prompt = mockListing();
    const quote = await resolveListingQuote(prompt._id);
    expect(quote.promptId).toBe(prompt._id);
    expect(quote.priceStroops).toBe("50000000");
    expect(findPromptById).toHaveBeenCalledWith(prompt._id);
    expect(findPromptByChainId).not.toHaveBeenCalled();
  });

  it("does not fall back to a document ID when a numeric listing is missing", async () => {
    mockListing("8");
    await expect(resolveListingQuote("7")).rejects.toThrow("Prompt listing not found.");
    expect(findPromptByChainId).toHaveBeenCalledWith({ onChainId: "7" });
    expect(findPromptById).not.toHaveBeenCalled();
  });

  it("refreshes changed listing terms through the same on-chain mapping", async () => {
    const prompt = mockListing();
    const before = await resolveListingQuote("7");
    prompt.price = 9;
    const after = await resolveListingQuote("7");
    expect(after.priceStroops).toBe("90000000");
    expect(diffListingTerms(before, after)).toEqual(["price"]);
    expect(after.termsHash).not.toBe(before.termsHash);
  });
});
