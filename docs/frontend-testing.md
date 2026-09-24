# Frontend Testing Guide

PromptHash Stellar uses Vitest + jsdom + React Testing Library for frontend integration coverage.

## Run The Suite

```bash
yarn test:frontend
```

Watch mode:

```bash
yarn test:frontend:watch
```

Run the deterministic browser-level buyer journey:

```bash
corepack yarn playwright install chromium # first run only
yarn test:e2e
```

The Playwright suite starts Vite locally and uses the `?e2e=1` development-only
wallet adapter. It mocks challenge, signing, purchase, unlock, and network
boundaries, so it never requires an extension, testnet RPC, or real funds. The
adapter is excluded from production behavior through Vite's `DEV` guard.

## What To Cover

Prefer real user journeys at the component or page-flow level:

- wallet connection or disconnection state
- wrong-network handling
- create listing validation and submission guards
- purchase and unlock flows
- failure recovery after async errors
- React Query refresh behavior after mutations

## Recommended Pattern

1. Render the real flow component with [`src/test/render.tsx`](../src/test/render.tsx).
2. Reuse realistic prompt fixtures from [`src/test/fixtures/prompts.ts`](../src/test/fixtures/prompts.ts).
3. Mock wallet, Soroban client, encryption, unlock, and buyer-library API boundaries at the edge:
   - `@/util/wallet`
   - `@/lib/stellar/promptHashClient`
   - `@/lib/crypto/promptCrypto`
   - `@/lib/prompts/unlock`
   - `@/lib/prompts/library` (saved/owned collection `fetch` calls)
   - draft lifecycle routes (`/api/prompts/creator/:wallet/drafts`, `/:id/publish`)
4. Update mocked in-memory state after mutations, then assert the UI refreshes after React Query invalidation.
5. Assert both happy-path and failure or recovery behavior.

## CI Rules

- Do not depend on live wallet extensions.
- Do not depend on a live Soroban RPC or Horizon server.
- Keep mock responses deterministic.
- Prefer explicit text assertions over snapshots for async marketplace flows.


## Marketplace release safety (#154)

Marketplace list/buy/progress flows must not use `Math.random()` for transaction
outcomes. Production uses the live adapter; deterministic fixtures are opt-in via
`?demo=1` / `?e2e=1` / `VITE_ENABLE_DEMO_MARKETPLACE=1`. See
[marketplace-release-safety.md](./marketplace-release-safety.md).

```bash
npm run test:marketplace-release-safety
```
