/**
 * Relational bigint ordering that never coerces through JavaScript Number.
 * Subtract-then-Number overflows for values above Number.MAX_SAFE_INTEGER.
 */

export type CompareResult = -1 | 0 | 1;

/** Ascending relational compare: -1 if a < b, 0 if equal, 1 if a > b. */
export function compareBigInt(a: bigint, b: bigint): CompareResult {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Descending relational compare. */
export function compareBigIntDesc(a: bigint, b: bigint): CompareResult {
  return compareBigInt(b, a);
}

/**
 * Apply a secondary bigint key when the primary comparison is equal.
 * Keeps Array.prototype.sort stable across equal primary keys.
 */
export function withBigIntTieBreak(
  primary: CompareResult,
  tieA: bigint,
  tieB: bigint,
  tieDescending = false,
): CompareResult {
  if (primary !== 0) return primary;
  return tieDescending ? compareBigIntDesc(tieA, tieB) : compareBigInt(tieA, tieB);
}
