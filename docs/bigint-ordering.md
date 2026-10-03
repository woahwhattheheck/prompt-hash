# Bigint-safe prompt ordering

On-chain prompt IDs and prices are `bigint` (stroops). Client sort paths must **not** subtract bigints and coerce the difference with `Number(...)` — values above `Number.MAX_SAFE_INTEGER` lose precision or become `Infinity`, which reshuffles order and pagination.

## Helpers

- `src/lib/stellar/bigintOrder.ts` — relational `compareBigInt` / `compareBigIntDesc` (`-1 | 0 | 1`).
- `src/lib/prompts/promptOrdering.ts` — prompt sorts (id / price / sales) with deterministic id tie-breaks, plus `priceStroopsWithinXlmBounds` for exact XLM→stroop filter bounds via `xlmToStroops`.

## Call sites

Browse (`FetchAllPrompts`), search fallback (`useSearchPrompts`), buyer library (`librarySearch`), and creator analytics all use these helpers.

XLM **display** formatting is unchanged (`format.ts`).

## Indexed API prices

Successful search and featured responses also convert numeric XLM prices
through the existing fixed-seven-decimal `xlmBoundToStroops` helper, preserving
the API mapping's existing numeric coercion for decimal strings.
Multiplying a JavaScript number by 10,000,000 and flooring can remove a
stroop even from an ordinary price: 2.01 XLM previously became 20,099,999
stroops instead of 20,100,000. The same price now stays consistent with
exact inclusive search bounds and contract results.

The fallback still converts each configured bound once per query. Its
bigint comparisons, stable ordering and pagination are unchanged.
