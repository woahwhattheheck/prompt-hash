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

### Expiry

A session is valid only while `now < expiresAt`. At or after that timestamp,
private reads and version writes return `401 expired_token` before looking up
private prompt data or publishing a version. Expiry rejection does not consume
the session nonce.

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

## Unpublished content through version reads (2026-10-04)

Both version GET handlers also check the prompt's listing state before reading
a version body. A prompt in `draft` or `ready` returns `404 Prompt not found.`
and never serializes either a version body or the prompt-content fallback.
Creators continue using the signed owned/draft routes for private content.

The check reorders the existing prompt lookup; it adds no database read. The
existing buyer/purchase rules, archived purchases, published version selection,
and legacy records without a listing state remain as before. The separate
adapter-consolidation contribution in #275 owns buyer authentication and the
shared-domain migration; this correction is the creator-privacy boundary on
the two handlers in this branch.

### Executed source and results

A bounded Node.js 24.19.0 replay executed each complete TypeScript module after
native type stripping. VM module linking supplied explicit database/model
fixtures and an identity observability wrapper; no handler body was extracted
or reimplemented. The request/response objects were recording collaborators.

| Scenario, in each handler | Before | After |
| --- | --- | --- |
| Draft with stored version | 200, private version returned | 404, zero version reads |
| Draft with prompt fallback | 200, draft plaintext returned | 404, zero version reads |
| Ready with stored version | 200, private version returned | 404, zero version reads |
| Published with stored version | Entitled version returned | Same content |
| Archived with stored version | Entitled version returned | Same content |
| Legacy record without listing state | Existing prompt fallback | Same content |

The serverless draft scenarios used no purchase record and an arbitrary
synthetic buyer value. Express scenarios retained its required purchase
fixture. Both handlers made exactly one prompt lookup in every scenario.
Baseline: 6 passing controls and 6 failing privacy cases. Candidate: 12/12
passing; all six private cases returned no content.

| Module | Before blob | Executed candidate blob |
| --- | --- | --- |
| `api/prompts/version.ts` | `a6b26ce88ed6029c201376ad9b7bc0a4efd1ace6` | `8af2df7ae7d40e16b9ac220b1cc57df72a2fc18d` |
| `server/src/controllers/versioningControllers.ts` | `6224309e18fca480278df255d121323c54236f7b` | `698a04ce3fcf7052aee3b09fdd215427ac94b4c7` |

The same six scenarios per adapter are maintained in the existing
`server/src/routes/creatorPrivacyRoutes.test.ts` with Express/Supertest and
explicit model fixtures. The focused maintained command is:

```sh
npm --prefix server test -- src/routes/creatorPrivacyRoutes.test.ts --runInBand
```

That Jest command was not executed in this environment because its dependencies
were unavailable. The executed result above is the direct complete-handler
replay, not a MongoDB integration, real HTTP/hosting, full-suite, lint/build or
hosted-CI result. Earlier creator-session evidence remains tied to its prior
source and is not counted in these 12 cases.
