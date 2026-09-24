import connectDb from "../../../server/src/db/connectDb";
import Prompt from "../../../server/src/models/Prompt";
import User from "../../../server/src/models/User";
import {
  resolvePaymentAsset,
  toListingQuote,
  xlmToStroopsString,
  type ListingQuote,
  type ListingTerms,
} from "./listingTerms";

export type ResolveListingQuoteOptions = {
  /** Override payment asset (tests / multi-asset). */
  asset?: string;
  /** When true, skip DB and throw (used by pure unit tests). */
  skipDb?: boolean;
};

/**
 * Load the public listing quote used to bind unlock challenges (#239).
 * Seller comes from the prompt owner wallet; version from currentVersionIndex;
 * price is normalized to stroops; asset defaults to the network native asset.
 */
export async function resolveListingQuote(
  promptId: string,
  options: ResolveListingQuoteOptions = {},
): Promise<ListingQuote> {
  if (options.skipDb) {
    throw new Error("Listing quote resolution skipped.");
  }

  await connectDb();

  const prompt = await Prompt.findById(promptId).lean();
  if (!prompt) {
    throw new Error("Prompt listing not found.");
  }

  const ownerId = (prompt as { owner?: unknown }).owner;
  const owner = ownerId
    ? await User.findById(ownerId).lean()
    : null;
  const seller =
    (owner as { walletAddress?: string } | null)?.walletAddress ??
    (prompt as { creatorWallet?: string }).creatorWallet ??
    "";

  if (!seller) {
    throw new Error("Prompt seller wallet is not available.");
  }

  const priceRaw = Number((prompt as { price?: number }).price ?? 0);
  const versionIndex = Number(
    (prompt as { currentVersionIndex?: number }).currentVersionIndex ?? 1,
  );
  const active =
    (prompt as { isActive?: boolean; active?: boolean }).isActive ??
    (prompt as { active?: boolean }).active ??
    true;

  const terms: ListingTerms = {
    promptId: String(promptId),
    versionIndex: Number.isFinite(versionIndex) && versionIndex > 0 ? versionIndex : 1,
    priceStroops: xlmToStroopsString(priceRaw),
    asset: resolvePaymentAsset(options.asset),
    seller: String(seller),
    active: Boolean(active),
  };

  return toListingQuote(terms);
}

/**
 * Build a listing quote from an already-known on-chain / in-memory record.
 * Used by unlock settle when the challenge already carries terms, and by tests.
 */
export function listingQuoteFromRecord(input: {
  promptId: string | number | bigint;
  versionIndex?: number;
  priceStroops: string | number | bigint;
  asset?: string;
  seller: string;
  active?: boolean;
}): ListingQuote {
  return toListingQuote({
    promptId: String(input.promptId),
    versionIndex: Number(input.versionIndex ?? 1),
    priceStroops: String(input.priceStroops),
    asset: resolvePaymentAsset(input.asset),
    seller: String(input.seller),
    active: input.active !== false,
  });
}
