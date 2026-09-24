# Unlock listing terms binding

Issue: [#239](https://github.com/Prompt-Hash-Stellar/prompt-hash/issues/239)

## Purpose

Unlock challenges bind an immutable **listing quote** so a buyer cannot sign after the creator changes price, payment asset, seller, prompt version, or availability.

## Flow

1. `POST /api/auth/challenge` resolves the live listing quote and embeds `termsHash` (+ quote fields) into the signed challenge payload and human-readable message.
2. Client re-fetches `GET /api/prompts/version?promptId=&quote=1` **before** wallet `signMessage`. Any drift throws `TERMS_CHANGED` and blocks signing.
3. `POST /api/prompts/unlock` re-resolves the quote and refuses with `409 TERMS_CHANGED` (plus refreshed `quote` + `changes`) if terms no longer match.

## Quote fields

| Field | Meaning |
| --- | --- |
| `promptId` | Listing id |
| `versionIndex` | Current prompt version |
| `priceStroops` | Price in stroops (string) |
| `asset` | Payment asset contract id |
| `seller` | Creator wallet |
| `active` | Listing availability |
| `termsHash` | SHA-256 of the canonical tuple |

## UI

- `StaleListingBanner` on the purchase modal shows which fields changed and the refreshed quote; decrypt stays disabled until the buyer confirms updated terms.
- Prompt detail shows the live quote version used for challenge binding.

## Code map

- `src/lib/auth/listingTerms.ts` — hash / diff / errors
- `src/lib/auth/resolveListingQuote.ts` — DB-backed quote load
- `src/lib/auth/challenge.ts` — terms in payload + message
- `api/auth/challenge.ts`, `api/prompts/version.ts`, `api/prompts/unlock.ts`
- `src/lib/prompts/unlock.ts` — pre-sign gate
- `src/components/prompts/StaleListingBanner.tsx`

## Tests

```bash
npm run test:listing-terms
```
