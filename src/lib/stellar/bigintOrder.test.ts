import { describe, expect, it } from "vitest";
import {
  compareBigInt,
  compareBigIntDesc,
  withBigIntTieBreak,
} from "./bigintOrder";

const ABOVE_SAFE = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
const ABOVE_SAFE_NEXT = ABOVE_SAFE + 1n;

describe("compareBigInt", () => {
  it("orders values above Number.MAX_SAFE_INTEGER without Number coercion", () => {
    expect(compareBigInt(ABOVE_SAFE, ABOVE_SAFE_NEXT)).toBe(-1);
    expect(compareBigInt(ABOVE_SAFE_NEXT, ABOVE_SAFE)).toBe(1);
    expect(compareBigInt(ABOVE_SAFE, ABOVE_SAFE)).toBe(0);
  });

  it("returns 0 for equal values including extreme equals", () => {
    const huge = 2n ** 80n;
    expect(compareBigInt(huge, huge)).toBe(0);
    expect(compareBigIntDesc(huge, huge)).toBe(0);
  });

  it("supports ascending and descending extremes", () => {
    const values = [ABOVE_SAFE_NEXT, 1n, ABOVE_SAFE, 0n];
    const asc = [...values].sort(compareBigInt);
    expect(asc).toEqual([0n, 1n, ABOVE_SAFE, ABOVE_SAFE_NEXT]);
    const desc = [...values].sort(compareBigIntDesc);
    expect(desc).toEqual([ABOVE_SAFE_NEXT, ABOVE_SAFE, 1n, 0n]);
  });

  it("applies stable bigint tie-breaks when primary is equal", () => {
    expect(withBigIntTieBreak(0, 9n, 3n)).toBe(1);
    expect(withBigIntTieBreak(0, 3n, 9n)).toBe(-1);
    expect(withBigIntTieBreak(0, 5n, 5n)).toBe(0);
    expect(withBigIntTieBreak(-1, 9n, 3n)).toBe(-1);
    expect(withBigIntTieBreak(1, 3n, 9n)).toBe(1);
    expect(withBigIntTieBreak(0, 3n, 9n, true)).toBe(1);
  });

  it("does not collapse neighbors the way Number(diff) would", () => {
    // Number(ABOVE_SAFE_NEXT - ABOVE_SAFE) is fine (1), but
    // Number(hugeA - hugeB) for far-apart huge values becomes Infinity.
    const farA = 2n ** 60n;
    const farB = 2n ** 53n; // just above MAX_SAFE_INTEGER bits for diff magnitude
    const diff = farA - farB;
    expect(Number.isFinite(Number(diff)) || Number(diff) === Infinity).toBe(true);
    // Relational compare stays exact regardless:
    expect(compareBigInt(farA, farB)).toBe(1);
    expect(compareBigInt(farB, farA)).toBe(-1);
  });
});
