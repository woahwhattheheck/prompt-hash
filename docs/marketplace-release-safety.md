# Marketplace release safety — no stochastic mocks (#154)

## Problem

Several marketplace UI paths previously used `Math.random()` to simulate
payment/listing failures and invented synthetic `tx_*` hashes. Users could see
random failures or apparent success unrelated to Stellar ledger state.

## Policy

1. **Production** marketplace flows never use stochastic transaction outcomes
   or client-synthesized random hashes.
2. **Success UI** is shown only after an authoritative adapter result
   (wallet submission → ledger confirmation → fulfillment / purchase result).
3. **Demo fixtures** are deterministic and **opt-in**:
   - `?demo=1` or `?e2e=1` in development
   - `VITE_ENABLE_DEMO_MARKETPLACE=1` in development
   - Vitest `MODE=test`
4. `VITE_ENABLE_DEMO_MARKETPLACE=1` is **forbidden** in production builds
   (startup + guard script).

## Code map

| Area | Role |
| --- | --- |
| `src/lib/marketplace/demoMode.ts` | Opt-in gate + startup assert |
| `src/lib/marketplace/demo/demoMarketplaceAdapter.ts` | Deterministic fixtures |
| `src/lib/marketplace/productionMarketplaceAdapter.ts` | Production entry points; live integration still required |
| `src/lib/marketplace/marketplaceTx.ts` | Facade selecting demo vs production |
| `Sell.tsx` / `Marketplace.tsx` / `PurchaseProgress.tsx` / `PromptModal.tsx` | UI wired through the facade |
| `PromptHashClient.purchasePrompt` | Mock disabled in production; demo-only deterministic hash |

## Current production integration boundary

The current marketplace facade rejects production listing and purchase calls.
Live wallet submission, ledger confirmation and fulfillment still need to be
connected for these flows:

| Entry point | Current production behavior |
| --- | --- |
| `listAsset` | Routes to `productionListAsset`, which always throws; the live wallet / `createPrompt` path is still required. |
| `buyAsset` / `runPurchaseFlow` | Use `productionBuyAsset`, which calls `PromptHashClient.purchasePrompt`; that client method throws when `import.meta.env.PROD` is true. |

See the [production adapter](../src/lib/marketplace/productionMarketplaceAdapter.ts)
and the [client purchase method](../src/lib/stellar/promptHashClient.ts).

The adapter emits `signature` and `network` pending events before calling the
purchase method. Those labels do not establish wallet submission or ledger
confirmation; the current production rejection prevents its later `confirming`
and `success` events.

Use the explicit development/test demo gates for deterministic fixtures. A
passing source or bundle guard does not demonstrate live wallet, ledger or
fulfillment integration. Before releasing live transactions, connect these entry
points to the authoritative wallet/ledger/fulfillment path and verify its success
and failure behavior end to end.

## Guards & tests

```bash
npm run guard:marketplace-stochastic
npm run test:marketplace-guard
npm run test:marketplace-release-safety
```

The guard fails if cited production sources regain `Math.random()` in
executable code (comments mentioning the ban are ignored).

Demo imports in the facade and `PromptHashClient` are behind compile-time
`import.meta.env.PROD` branches, so the production marketplace bundle omits
the demo adapter and its deterministic transaction hashes entirely. The release
safety suite checks the actual minified marketplace entry (with the Stellar SDK
external) and preserves the existing deterministic demo/UI cases.

Without arguments, the guard checks sources only and remains safe to run before
a build. After building, run
`node scripts/guard-no-stochastic-marketplace.mjs --bundle dist` to check emitted
artifacts, including reserved `tx_demo_` fixtures. The bundle directory may be an
absolute path or a path relative to the current repository root. An explicit
`--bundle` requires exactly one directory argument and at least one nonempty
`.js`, `.mjs`, or `.cjs` file, including nested assets. Missing directories,
files in place of directories, and output containing only empty JavaScript,
whitespace, CSS, or source maps fail instead of reporting a clean scan.

`npm run test:marketplace-guard` runs the actual CLI against temporary artifacts
using only Node's standard library; no dependency install or build is needed.
It covers invalid arguments and paths, absent JavaScript, valid relative and
absolute output, and the existing forbidden-content rules. The broader release
safety command also runs these CLI checks after the marketplace/UI suite.
