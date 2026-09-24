# Governance vote authentication (#147)

## Problem

`POST` / `DELETE /api/governance/vote/:promptId` previously trusted
`req.body.voterWallet` for purchase eligibility and vote mutations. Knowing a
buyer's address was enough to cast or remove that buyer's upvote.

## Authenticated wallet session

Vote mutations require a **signed wallet session**:

1. Client calls `POST /api/governance/session` with `{ address, promptId, action }`
   where `action` is `governance_vote_create` or `governance_vote_delete`.
2. Server returns an HMAC session token bound to `address`, `promptId`,
   `network` (server passphrase), `action`, `nonce`, and expiry, plus a
   canonical `challenge` string.
3. Client signs `challenge` with the Stellar wallet and submits
   `{ sessionToken, signature }` to create or delete the vote.

Voter identity is taken **only** from the verified session address. Any
`voterWallet` (or similar) body field is ignored and has no effect.

### Network binding

Session claims include `PUBLIC_STELLAR_NETWORK_PASSPHRASE`. A token minted for
a different network is rejected (`403 wrong_network`).

### Replay and idempotency

- Each session `nonce` may be consumed once (in-process ledger).
- Replaying a spent session → `409 replay`.
- Duplicate create for the same `(promptId, voterWallet)` → existing unique
  index → `409` ("already voted"). One purchase principal has at most one vote
  per prompt.

### Public reads

`GET /api/governance/votes/:promptId` and `GET /api/governance/top` remain
public aggregate endpoints and do not require a session.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CHALLENGE_TOKEN_SECRET` | HMAC secret for session tokens (≥32 chars; shared family with unlock challenges) |
| `PUBLIC_STELLAR_NETWORK_PASSPHRASE` | Expected network bound into every session |

## Non-goals

Changing governance ranking weights.
