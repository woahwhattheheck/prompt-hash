# Creator privacy — owned prompts, drafts, and version writes (#142)

## Problem

Private creator data was selected by wallet address in the URL or request body
without proving control of that wallet:

- `GET /api/prompts/buyer/:walletAddress/owned`
- `GET /api/prompts/creator/:walletAddress/drafts`
- `POST /api/versions/update` and `POST /api/prompts/version`

An unauthenticated caller who knew a creator address could enumerate drafts /
owned records or post a new version as that creator.

## Signed creator session

Private reads and version writes require a **signed creator session**:

1. Client calls `POST /api/prompts/creator-session` with:
   - `{ address, action: "creator_owned_read" | "creator_drafts_read" }` for reads
   - `{ address, action: "creator_version_write", promptId, content }` for writes
2. Server returns an HMAC session token bound to `address`, `action`,
   `network`, `nonce`, expiry, and (for writes) `promptId` + SHA-256
   `contentDigest`, plus a canonical `challenge` string.
3. Client signs `challenge` with the Stellar wallet and submits credentials:
   - **GET** owned/drafts: `Authorization: Bearer <sessionToken>` and
     `X-Wallet-Signature: <base64>`
   - **POST** version: `{ sessionToken, signature, promptId, content, … }`

Creator identity is taken **only** from the verified session address. Any
`walletAddress` body field on version writes is ignored. The URL wallet on
owned/drafts must match the session address or the request is denied (`403
wallet_mismatch`) and audited.

### Request digest (version writes)

Version-write sessions bind `SHA-256(content)`. Mutating the body content after
the session is issued yields `403 digest_mismatch`. This binds creator, prompt,
and request digest together.

### Replay

Each session `nonce` may be consumed once (in-process ledger). Replaying a
spent session → `409 replay`.

### Public vs private projections

| Surface | Auth | Content |
| --- | --- | --- |
| `GET /api/prompts` (public listing) | none | published only; drafts filtered out |
| `GET /api/versions/:id/history` | none | metadata only (`-content`) |
| Owned / drafts GETs | creator session | private projection includes content |
| Version POST | creator session | write path |

Denied cross-wallet and unauthenticated private attempts emit structured audit
events with wallet **hashes** only (no plaintext, no tokens).

## Configuration

| Variable | Purpose |
| --- | --- |
| `CHALLENGE_TOKEN_SECRET` | HMAC secret for session tokens (≥32 chars; shared family with unlock challenges) |
| `PUBLIC_STELLAR_NETWORK_PASSPHRASE` | Expected network bound into every session |

## Non-goals

Changing version entitlement / buyer unlock rules.
