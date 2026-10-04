# Bigint-safe prompt ordering

On-chain prompt IDs and prices are `bigint` (stroops). Client sort paths must **not** subtract bigints and coerce the difference with `Number(...)` — values above `Number.MAX_SAFE_INTEGER` lose precision or become `Infinity`, which reshuffles order and pagination.

## Helpers

- `src/lib/stellar/bigintOrder.ts` — relational `compareBigInt` / `compareBigIntDesc` (`-1 | 0 | 1`).
- `src/lib/prompts/promptOrdering.ts` — prompt sorts (id / price / sales) with deterministic id tie-breaks, plus `priceStroopsWithinXlmBounds` for exact XLM→stroop filter bounds via `xlmToStroops`.

## Call sites

Browse (`FetchAllPrompts`), search fallback (`useSearchPrompts`), buyer library (`librarySearch`), and creator analytics all use these helpers.

XLM **display** formatting is unchanged (`format.ts`).

## Indexed API prices

Successful search and featured responses convert numeric XLM prices through
the existing fixed-seven-decimal `xlmBoundToStroops` helper. Plain decimal
strings with up to seven fractional digits instead use `xlmToStroops` directly,
without an intermediate JavaScript number. This preserves every stroop even
when the string's exact value is not representable as a number. Numeric values
and other legacy-coercible API values retain their previous conversion.
Multiplying a JavaScript number by 10,000,000 and flooring can remove a
stroop even from an ordinary price: 2.01 XLM previously became 20,099,999
stroops instead of 20,100,000. The same price now stays consistent with
exact inclusive search bounds and contract results.

The fallback still converts each configured bound once per query. Its
bigint comparisons, stable ordering and pagination are unchanged.

## Decimal-string precision follow-up

The same numeric conversion that handles ordinary number-valued API prices
rounds some exact strings before the decimal parser can see them. For example,
`"900719925.4740991"` previously became `9007199254740992n` rather than
`9007199254740991n`; `"123456789012.1234567"` became `1234567890121234589n`
rather than `1234567890121234567n`. Both search and featured mappings now use
the shared string-aware conversion in `useSearchPrompts.ts`.

The existing hook test table adds three decimal-string values and exercises
each through both API routes. Run the focused maintained file with:

```sh
npm run test:frontend -- src/hooks/useSearchPrompts.test.ts
```

On the original hook at `75979f97732902fc9d493a2805d76a1f8da34b0f`, the
updated file produced 25 passes and six failures, all at the new string values.
The repaired complete hook produced 31 passes, no failures or skips. Existing
numeric, zero/omitted, exact-bound, deterministic-pagination and constant
fallback-bound parsing checks remain in that same file.

This execution used Node 24.19.0 and retained Vitest 4.1.10 with a focused Node
environment and the repository source alias. The test's existing React Query,
contract-client, browser-config and fetch mocks were preserved. A temporary
resolver supplied identities for the three already-mocked dependencies; its
module bodies throw if loaded without those mocks. The actual hook, sorting
helpers and decimal parser were loaded from the pinned source. This is a
focused hook regression result, not a React Query package integration, full
frontend build, hosted CI, live search provider or wallet result.

Scoped lint also returned zero errors and zero warnings for the two hook files,
using retained ESLint 9.39.5 and TypeScript parser/plugin 8.46.0 with the
repository's recommended rules and explicit rule overrides. Prettier 3.9.6
formatted the three changed files. These retained tool versions differ from
the current package manifest; no dependency or lockfile was changed.
