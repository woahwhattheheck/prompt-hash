/**
 * Canonical listing terms bound into unlock challenges (#239).
 * A signature is only valid for this exact quote snapshot.
 */
export type ListingTerms = {
  promptId: string;
  versionIndex: number;
  /** Price in stroops as a decimal string (no scientific notation). */
  priceStroops: string;
  /** Payment asset contract id or "native". */
  asset: string;
  /** Seller / creator wallet (case-normalized for hashing). */
  seller: string;
  active: boolean;
};

export type ListingQuote = ListingTerms & {
  termsHash: string;
};

export type ListingTermsChange =
  | "price"
  | "asset"
  | "seller"
  | "version"
  | "active"
  | "promptId";

export function diffListingTerms(
  expected: ListingTerms,
  actual: ListingTerms,
): ListingTermsChange[] {
  const changes: ListingTermsChange[] = [];
  if (String(expected.promptId) !== String(actual.promptId)) {
    changes.push("promptId");
  }
  if (Number(expected.versionIndex) !== Number(actual.versionIndex)) {
    changes.push("version");
  }
  if (String(expected.priceStroops) !== String(actual.priceStroops)) {
    changes.push("price");
  }
  if (String(expected.asset) !== String(actual.asset)) {
    changes.push("asset");
  }
  if (expected.seller.toLowerCase() !== actual.seller.toLowerCase()) {
    changes.push("seller");
  }
  if (Boolean(expected.active) !== Boolean(actual.active)) {
    changes.push("active");
  }
  return changes;
}

export function formatTermsChangeMessage(
  changes: ListingTermsChange[],
): string {
  if (changes.length === 0) {
    return "Listing terms are unchanged.";
  }
  const labels: Record<ListingTermsChange, string> = {
    price: "price",
    asset: "payment asset",
    seller: "seller",
    version: "prompt version",
    active: "listing availability",
    promptId: "prompt",
  };
  const parts = changes.map((c) => labels[c]);
  if (parts.length === 1) {
    return `Listing ${parts[0]} changed since you started. Review the updated terms before signing.`;
  }
  const last = parts[parts.length - 1];
  const head = parts.slice(0, -1).join(", ");
  return `Listing ${head} and ${last} changed since you started. Review the updated terms before signing.`;
}

export class ListingTermsChangedError extends Error {
  readonly code = "TERMS_CHANGED" as const;
  readonly changes: ListingTermsChange[];
  readonly quote: ListingQuote;

  constructor(changes: ListingTermsChange[], quote: ListingQuote) {
    super(formatTermsChangeMessage(changes));
    this.name = "ListingTermsChangedError";
    this.changes = changes;
    this.quote = quote;
  }
}
