# Bigint-safe prompt ordering

On-chain prompt IDs and prices are `bigint` (stroops). Client sort paths must **not** subtract bigints and coerce the difference with `Number(...)` — values above `Number.MAX_SAFE_INTEGER` lose precision or become `Infinity`, which reshuffles order and pagination.

## Helpers

- `src/lib/stellar/bigintOrder.ts` — relational `compareBigInt` / `compareBigIntDesc` (`-1 | 0 | 1`).
- `src/lib/prompts/promptOrdering.ts` — prompt sorts (id / price / sales) with deterministic id tie-breaks, plus `priceStroopsWithinXlmBounds` for exact XLM→stroop filter bounds via `xlmToStroops`.

## Call sites

Browse (`FetchAllPrompts`), search fallback (`useSearchPrompts`), buyer library (`librarySearch`), and creator analytics all use these helpers.

XLM **display** formatting is unchanged (`format.ts`).
