import React from "react";
import { RefreshCw, AlertTriangle } from "lucide-react";
import type { ListingQuote } from "@/lib/auth/listingTerms";
import type { ListingTermsChange } from "@/lib/auth/listingTerms";

function stroopsToXlm(priceStroops: string): string {
  try {
    const stroops = BigInt(priceStroops);
    const whole = stroops / 10_000_000n;
    const frac = stroops % 10_000_000n;
    const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return priceStroops;
  }
}

const CHANGE_LABELS: Record<ListingTermsChange, string> = {
  price: "Price",
  asset: "Payment asset",
  seller: "Seller",
  version: "Prompt version",
  active: "Availability",
  promptId: "Prompt",
};

export interface StaleListingBannerProps {
  quote: ListingQuote;
  changes: ListingTermsChange[];
  onConfirmRefresh: () => void;
  onDismiss?: () => void;
}

/**
 * Buyer-facing feedback when listing terms changed before wallet signing (#239).
 */
export const StaleListingBanner: React.FC<StaleListingBannerProps> = ({
  quote,
  changes,
  onConfirmRefresh,
  onDismiss,
}) => {
  const changeLabels = changes.map((c) => CHANGE_LABELS[c] ?? c);

  return (
    <div
      className="rounded-xl border border-amber-500/40 bg-amber-950/40 p-4 text-amber-50"
      role="alert"
      aria-live="assertive"
      data-testid="stale-listing-banner"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-sm font-semibold text-amber-200">
              Listing updated — confirm before signing
            </p>
            <p className="mt-1 text-sm text-amber-100/90">
              {changeLabels.length > 0
                ? `${changeLabels.join(", ")} changed since you started. Wallet signing was blocked so you do not commit to outdated terms.`
                : "Listing terms changed since you started. Wallet signing was blocked so you do not commit to outdated terms."}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-amber-500/20 bg-black/20 p-3 text-xs sm:text-sm">
            <div>
              <dt className="text-amber-200/70">Price</dt>
              <dd className="font-semibold text-white">
                {stroopsToXlm(quote.priceStroops)} XLM
              </dd>
            </div>
            <div>
              <dt className="text-amber-200/70">Version</dt>
              <dd className="font-semibold text-white">v{quote.versionIndex}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-amber-200/70">Seller</dt>
              <dd className="truncate font-mono text-white" title={quote.seller}>
                {quote.seller.length > 16
                  ? `${quote.seller.slice(0, 6)}…${quote.seller.slice(-4)}`
                  : quote.seller}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-amber-200/70">Asset</dt>
              <dd className="truncate font-mono text-white" title={quote.asset}>
                {quote.asset.length > 20
                  ? `${quote.asset.slice(0, 8)}…${quote.asset.slice(-4)}`
                  : quote.asset}
              </dd>
            </div>
            <div>
              <dt className="text-amber-200/70">Status</dt>
              <dd className="font-semibold text-white">
                {quote.active ? "Active" : "Inactive"}
              </dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onConfirmRefresh}
              className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-3 py-2 text-sm font-bold text-slate-950 transition hover:bg-amber-300"
            >
              <RefreshCw className="h-4 w-4" />
              Use updated terms
            </button>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-lg border border-amber-500/30 px-3 py-2 text-sm text-amber-100/80 hover:bg-amber-500/10"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default StaleListingBanner;
