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
| `src/lib/marketplace/productionMarketplaceAdapter.ts` | Live wallet → ledger path |
| `src/lib/marketplace/marketplaceTx.ts` | Facade selecting demo vs production |
| `Sell.tsx` / `Marketplace.tsx` / `PurchaseProgress.tsx` / `PromptModal.tsx` | UI wired through the facade |
| `PromptHashClient.purchasePrompt` | Mock disabled in production; demo-only deterministic hash |

## Guards & tests

```bash
npm run guard:marketplace-stochastic
npm run test:marketplace-release-safety
```

The guard fails if cited production sources regain `Math.random()` in
executable code (comments mentioning the ban are ignored).
