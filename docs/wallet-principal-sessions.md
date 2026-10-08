# Shared wallet principal sessions (#144, core and adapters)

This contribution provides the common session lifecycle and verified principal
adapters. It stacks on the current creator-privacy work in #266. Existing creator
and purchase authorization remain unchanged; governance vote writes and review
submissions now consume the authenticated wallet principal. Other wallet-bound
routes still require separate migration before #144 is complete; mounting these
session endpoints alone does not authenticate the rest of the API.

Both Express and serverless expose `POST /api/auth/session` with three actions:

1. Send `{ "action": "challenge", "address": "G..." }` with the browser's
   `Origin` header. Sign the returned `challenge` string exactly as returned,
   using the wallet's existing Ed25519 signing capability.
2. Send `{ "action": "exchange", "challengeToken": "...", "signature": "..." }`
   with the same origin. The signature is base64. A valid challenge can be
   exchanged once; the response contains the bearer `sessionToken` and principal.
3. Send `{ "action": "revoke" }` with `Authorization: Bearer <sessionToken>`
   and the same origin. This revokes only that session. Repeated revocation is safe.

Configure `CHALLENGE_TOKEN_SECRET` (at least 32 characters),
`PUBLIC_STELLAR_NETWORK_PASSPHRASE`, and `WALLET_SESSION_ORIGINS` (comma-separated
exact HTTP(S) origins). Missing configuration fails closed. No caller-supplied
network or domain overrides the server configuration. The Origin header must be
present and match an allowed origin literally. Native clients need an approved
origin header; changing client integration is a separate migration task.

Challenges last five minutes; sessions last fifteen minutes. The signed challenge
includes a versioned audience, proof kind, wallet, network, origin, nonce,
issuance and expiry. Session tokens use a separate proof kind, independent ID and
expiry. Existing unlock/creator/governance proofs cannot be exchanged as general
wallet sessions. Invalid proofs never consume the nonce.

Replay protection reuses #266's `CreatorSessionNonce` Mongo collection under a
`wallet:` nonce namespace. Its built-in unique `_id` insert selects one successful
exchange across replicas; there is no third process-local nonce ledger. Session
use and revocation consult the shared Mongo `WalletSession` collection, matching
the complete signed identity. Database failures deny access. A request that
successfully authenticated before a concurrent revocation may finish; subsequent
authentication rejects the revoked session. Challenge consumption precedes
session creation, so a failed database write requires a new challenge rather
than retrying a consumed proof.

Express route migrations add `requireWalletPrincipal` and derive wallet identity
from `res.locals.walletPrincipal.address`. Serverless migrations call
`await readWalletPrincipal(req)` and pass the returned principal to the handler's
ownership checks. Ignore body/URL wallet values as authentication; compare them
only when a route needs to reject an inconsistent request. Signing keys retain
Stellar's case. Existing database lookups may normalize addresses according to
their current storage contract after authentication.


### Authenticated review and governance writes\n
`POST /g/api/reviews/submit`, `POST /api/governance/vote/:promptId` and\n`DELETE /api/governance/vote/:promptId` now require the session bearer and its\nmatching permitted `Origin`. They derive the reviewer/voter wallet from the\nverified principal. Legacy `userAddress` and `voterWallet` body fields are\noptional compatibility selectors only: if supplied, they must match the signed\nwallet or the mutation is rejected with 403. No session is denied with 401;\ninvalid session/configuration is rejected by the common verifier before any\nreview or vote query. Existing purchase eligibility, duplicate-vote, and\nreview rating checks are retained. Public `GET /api/reviews/list`,\n`GET /api/governance/votes/:promptId`, and `GET /api/governance/top` stay open.\n\nClients issuing either write must obtain a wallet session first; a body-only\nwallet address is no longer a valid credential. The focused Jest\n`server/src/routes/walletAuthorizedWrites.test.ts` covers no-session, forged\nwallet, authenticated reviewer/voter writes, and public vote-count access. The\ncryptographic replay/expiry tests for the shared session core remain separate.\n\nMongo retains issuance, last-use/count and revocation timestamps plus public
wallet/network/origin identity. It never stores the bearer token, signature,
challenge text or private key. TTL indexes clean spent nonces and session audit
records (sessions retained for 30 days after expiry); cryptographic expiry and
revocation checks do not wait for cleanup. HTTP failures expose only stable
categories, and lifecycle responses are `Cache-Control: no-store`.

Focused core check on Node 24:

```sh
node --test server/src/auth/walletPrincipal.test.mjs
```

This exercises actual Ed25519 proofs, token/domain/network/expiry boundaries,
concurrent exchange and cross-instance revocation through the production core
with a shared atomic store fixture. It does not start Mongo, HTTP servers or the
Stellar SDK. Production adapter/database/device verification remains separate.
