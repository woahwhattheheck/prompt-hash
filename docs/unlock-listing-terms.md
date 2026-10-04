# Unlock listing terms binding

Issue: [#239](https://github.com/Prompt-Hash-Stellar/prompt-hash/issues/239)

## Purpose

Unlock challenges bind an immutable **listing quote** so a buyer cannot sign after the creator changes price, payment asset, seller, prompt version, or availability.

## Flow

1. `POST /api/auth/challenge` resolves the live listing quote and embeds `termsHash` (+ quote fields) into the signed challenge payload and human-readable message.
2. Client re-fetches `GET /api/prompts/version?promptId=&quote=1` **before** wallet `signMessage`. Any drift throws `TERMS_CHANGED` and blocks signing. Immediately before signing, it also checks challenge expiry using the same `expiresAt < Date.now()` rule as the server. An expired response or a quote refresh that outlives the challenge reports the existing expired-session retry message without calling the wallet or posting an unlock request.
3. `POST /api/prompts/unlock` re-resolves the quote and refuses with `409 TERMS_CHANGED` (plus refreshed `quote` + `changes`) if terms no longer match.

## Quote fields

| Field          | Meaning                        |
| -------------- | ------------------------------ |
| `promptId`     | Listing id                     |
| `versionIndex` | Current prompt version         |
| `priceStroops` | Price in stroops (string)      |
| `asset`        | Payment asset contract id      |
| `seller`       | Creator wallet                 |
| `active`       | Listing availability           |
| `termsHash`    | SHA-256 of the canonical tuple |

## UI

- `StaleListingBanner` on the purchase modal shows which fields changed and the refreshed quote; decrypt stays disabled until the buyer confirms updated terms.
- Prompt detail shows the live quote version used for challenge binding.

## Code map

- `src/lib/auth/listingTermsShared.ts` — dependency-free types, comparison and display errors for the browser/server
- `src/lib/auth/listingTerms.ts` — server hashing and compatible re-exports
- `src/lib/auth/resolveListingQuote.ts` — DB-backed quote load
- `src/lib/auth/challenge.ts` — terms in payload + message
- `api/auth/challenge.ts`, `api/prompts/version.ts`, `api/prompts/unlock.ts`
- `src/lib/prompts/unlock.ts` — pre-sign gate
- `src/components/prompts/StaleListingBanner.tsx`

## Tests

```bash
npm run test:listing-terms
```

The existing client tests cover expiry while receiving the challenge and while
refreshing an unchanged quote: neither path may sign or post to the unlock API.
The matching-quote control remains valid one millisecond before expiry. Server
verification remains authoritative if the challenge expires later while the user
interacts with the wallet; its expiry policy and signed message are unchanged.

## Client module loading (2026-10-04)

The unlock client imports comparison and error values from
`listingTermsShared.ts`. That module has no Node imports.
`listingTerms.ts` retains synchronous server hashing and re-exports the shared
values, preserving existing server imports and the error constructor used by
`instanceof`. Canonical quote hashing, resolver behavior, signed bytes, and the
pre-sign expiry guard are unchanged.

Previously the client imported `listingTerms.ts`, which statically imported
`crypto.createHash`. The repository's Vite configuration polyfills only Buffer.
An actual Vite 8.3.2 development server therefore served the browser-external
crypto module; evaluating the complete served terms module failed with
`Cannot access "crypto.createHash" in client code` before a comparison could run.

### Executed validation

- Node 24.19.0 / Vite 8.3.2: the retained reproduction selects the terms module
  from the actual unlock client's import, fetches Vite's client output over
  loopback HTTP, and instantiates that output with the native VM ESM linker.
  Before: terms plus browser-external crypto are loaded, then evaluation fails.
  After: the shared terms module loads alone and reports the expected price
  change. A real browser executable was unavailable; this is a served-module
  execution result, not a browser, wallet, whole-application or deployed test.
- Vitest 4.1.10: the existing `src/lib/auth/listingTerms.test.ts` file passes
  **15/15** with a temporary Node configuration selecting that file and one
  worker. The 14 existing hashing/comparison/resolver cases remain, plus one
  compatibility case proving the shared error is the same server-visible
  constructor. The resolver still uses its existing database fixtures.
- Reused dependency directories were read only. No new dependency, crypto
  polyfill, application configuration or lockfile change was required. The
  complete listing-terms suite, full application build/lint and hosted CI were
  not run for this module split. Earlier expiry evidence belongs to its earlier
  source and is not added to these 15 cases.

| Source | Executed blob |
| --- | --- |
| Prior client `unlock.ts` | `8a1387d5210ca28e661b9263d467c5ebd076438e` |
| Prior `listingTerms.ts` | `956c060350bc3c07493886fdfe14662f4895d5c8` |
| Current client `unlock.ts` | `913834b30a8bf110c9411ab7813cc75c5b5ea914` |
| Current shared terms | `67a3dcf4b2b9c863df05413389a924e0a9f24bba` |
| Current server terms | `351011031195720c7f0b362cd4d772df43ac94f9` |
| Maintained terms test | `744f1ae936016dbca9ba00c685aa8880c2909660` |

Run the focused import reproduction after installing the existing dependencies:

```sh
node --experimental-vm-modules docs/validation/listing-terms-client-import.mjs .
```

Its optional root argument can point to a checkout of the preceding source to
reproduce the failure. The script uses a temporary Vite cache and removes it
when complete; it prints exact source blobs and the module result.
