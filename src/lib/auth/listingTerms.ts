import { createHash } from "crypto";
import type { ListingQuote, ListingTerms } from "./listingTermsShared";

// Keep server callers on the existing API while browser callers import the
// dependency-free comparison/error module directly.
export type { ListingQuote, ListingTerms, ListingTermsChange } from "./listingTermsShared";
export { diffListingTerms, formatTermsChangeMessage, ListingTermsChangedError } from "./listingTermsShared";

const DEFAULT_NATIVE_ASSET =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

export function resolvePaymentAsset(explicit?: string | null): string {
  const trimmed = (explicit ?? "").trim();
  if (trimmed) return trimmed;
  return (
    process.env.PUBLIC_STELLAR_NATIVE_ASSET_CONTRACT_ID?.trim() ||
    DEFAULT_NATIVE_ASSET
  );
}

export function xlmToStroopsString(priceXlm: number): string {
  if (!Number.isFinite(priceXlm) || priceXlm < 0) {
    throw new Error("Invalid listing price.");
  }
  return String(BigInt(Math.round(priceXlm * 10_000_000)));
}

export function canonicalizeListingTerms(terms: ListingTerms): string {
  return [
    String(terms.promptId),
    String(terms.versionIndex),
    String(terms.priceStroops),
    String(terms.asset),
    String(terms.seller).toLowerCase(),
    terms.active ? "1" : "0",
  ].join("|");
}

export function hashListingTerms(terms: ListingTerms): string {
  return createHash("sha256")
    .update(canonicalizeListingTerms(terms), "utf8")
    .digest("hex");
}

export function toListingQuote(terms: ListingTerms): ListingQuote {
  return { ...terms, termsHash: hashListingTerms(terms) };
}

export function listingTermsMatch(
  expected: ListingTerms,
  actual: ListingTerms,
): boolean {
  return hashListingTerms(expected) === hashListingTerms(actual);
}

