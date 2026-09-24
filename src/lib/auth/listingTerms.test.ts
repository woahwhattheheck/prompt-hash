// @vitest-environment node

import { describe, expect, it } from "vitest";
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
