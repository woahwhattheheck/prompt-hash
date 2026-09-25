/**
 * Platform fee constants for seller payout reconciliation (#245).
 *
 * Source of truth: contracts/prompt-hash/src/contract.rs
 *   const DEFAULT_FEE_BPS: u32 = 500;
 *   const MAX_BPS: u32 = 10_000;
 *
 * Fee arithmetic matches the on-chain `bps_amount` helper:
 *   fee = floor(grossStroops * feeBps / MAX_BPS)
 *
 * Do not invent alternate USD rates or percentages here — reuse these
 * contract defaults (or values already stored on purchase/payout records).
 */

/** Default marketplace platform fee in basis points (5.00%). */
export const DEFAULT_FEE_BPS = 500;

/** Basis-point denominator used by the Prompt Hash contract. */
export const MAX_BPS = 10_000;

/** Stellar stroops per 1 XLM (indexer stores Prompt.price in XLM). */
export const STROOPS_PER_XLM = 10_000_000;

/**
 * Floor-rounded fee in stroops, matching `bps_amount` in
 * contracts/prompt-hash/src/contract.rs.
 */
export function platformFeeStroops(
  grossStroops: number,
  feeBps: number = DEFAULT_FEE_BPS,
): number {
  if (!Number.isFinite(grossStroops) || grossStroops <= 0) return 0;
  if (!Number.isFinite(feeBps) || feeBps < 0) return 0;
  return Math.floor((grossStroops * feeBps) / MAX_BPS);
}

/** Convert an XLM price (Prompt.price) to integer stroops. */
export function xlmToStroops(xlm: number): number {
  if (!Number.isFinite(xlm) || xlm <= 0) return 0;
  return Math.round(xlm * STROOPS_PER_XLM);
}
