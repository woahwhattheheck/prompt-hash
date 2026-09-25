/**
 * Stable prompt sort/filter helpers for browse, search, library, and analytics.
 * Uses relational bigint compares — never Number(bigintDiff).
 */

import type { PromptRecord } from "@/lib/stellar/promptHashClient";
import {
  compareBigInt,
  compareBigIntDesc,
  withBigIntTieBreak,
  type CompareResult,
} from "@/lib/stellar/bigintOrder";
import { xlmToStroops } from "@/lib/stellar/format";

export type PromptSortKey =
  | "newest"
  | "oldest"
  | "recent"
  | "price-low"
  | "price-high"
  | "sales";

/** Convert an XLM UI bound to stroops with fixed 7-decimal precision. */
export function xlmBoundToStroops(xlm: number): bigint {
  if (!Number.isFinite(xlm)) {
    throw new Error("XLM bound must be a finite number");
  }
  return xlmToStroops(xlm.toFixed(7));
}

/**
 * Exact stroop-range membership for XLM min/max filters.
 * Avoids Number(priceStroops) / 1e7 float loss on large prices.
 */
export function priceStroopsWithinXlmBounds(
  priceStroops: bigint,
  minXlm?: number,
  maxXlm?: number,
): boolean {
  if (minXlm !== undefined) {
    if (priceStroops < xlmBoundToStroops(minXlm)) return false;
  }
  if (maxXlm !== undefined) {
    if (priceStroops > xlmBoundToStroops(maxXlm)) return false;
  }
  return true;
}

export function comparePromptIdAsc(
  a: Pick<PromptRecord, "id">,
  b: Pick<PromptRecord, "id">,
): CompareResult {
  return compareBigInt(a.id, b.id);
}

export function comparePromptIdDesc(
  a: Pick<PromptRecord, "id">,
  b: Pick<PromptRecord, "id">,
): CompareResult {
  return compareBigIntDesc(a.id, b.id);
}

export function comparePromptPriceAsc(
  a: Pick<PromptRecord, "id" | "priceStroops">,
  b: Pick<PromptRecord, "id" | "priceStroops">,
): CompareResult {
  return withBigIntTieBreak(
    compareBigInt(a.priceStroops, b.priceStroops),
    a.id,
    b.id,
  );
}

export function comparePromptPriceDesc(
  a: Pick<PromptRecord, "id" | "priceStroops">,
  b: Pick<PromptRecord, "id" | "priceStroops">,
): CompareResult {
  return withBigIntTieBreak(
    compareBigIntDesc(a.priceStroops, b.priceStroops),
    a.id,
    b.id,
  );
}

export function comparePromptSalesDesc(
  a: Pick<PromptRecord, "id" | "salesCount">,
  b: Pick<PromptRecord, "id" | "salesCount">,
): CompareResult {
  if (a.salesCount !== b.salesCount) {
    return a.salesCount > b.salesCount ? -1 : 1;
  }
  return compareBigInt(a.id, b.id);
}

/** Sort a prompt list by a known key; always returns a new array. */
export function sortPromptsBy<T extends PromptRecord>(
  prompts: T[],
  sortKey: PromptSortKey | string,
): T[] {
  const sorted = [...prompts];
  switch (sortKey) {
    case "oldest":
      sorted.sort(comparePromptIdAsc);
      break;
    case "price-low":
      sorted.sort(comparePromptPriceAsc);
      break;
    case "price-high":
      sorted.sort(comparePromptPriceDesc);
      break;
    case "sales":
      sorted.sort(comparePromptSalesDesc);
      break;
    case "newest":
    case "recent":
    default:
      sorted.sort(comparePromptIdDesc);
      break;
  }
  return sorted;
}
