import type { PromptRecord } from "@/lib/stellar/promptHashClient";
import { formatPriceLabel } from "@/lib/stellar/format";
import { comparePromptSalesDesc } from "@/lib/prompts/promptOrdering";

export interface CreatorAnalytics {
  activeListings: number;
  inactiveListings: number;
  totalSales: number;
  estimatedGrossRevenueStroops: bigint;
  topPrompts: PromptRecord[];
}

export function calculateCreatorAnalytics(
  prompts: PromptRecord[],
  topPromptLimit = 5,
): CreatorAnalytics {
  return {
    activeListings: prompts.filter((prompt) => prompt.active).length,
    inactiveListings: prompts.filter((prompt) => !prompt.active).length,
    totalSales: prompts.reduce((total, prompt) => total + prompt.salesCount, 0),
    estimatedGrossRevenueStroops: prompts.reduce(
      (total, prompt) => total + prompt.priceStroops * BigInt(prompt.salesCount),
      0n,
    ),
    topPrompts: [...prompts]
      .sort(comparePromptSalesDesc)
      .slice(0, topPromptLimit),
  };
}

export function formatEstimatedGrossRevenue(stroops: bigint): string {
  return `Estimated ${formatPriceLabel(stroops)}`;
}
