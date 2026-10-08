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

### Authenticated reporter attribution and private preview analytics

`POST /api/prompts/reports` now uses the verified wallet session to record
the reporter; an optional legacy `reporterAddress` is a selector, not proof.
If it disagrees with the signed principal the server returns 403 without
writing. `GET /api/prompts/preview/stats` now requires that same wallet session
because it returns per-creator aggregate preview and sales context; optional
query `walletAddress` may only name the signer. Missing credentials are
rejected before any database query, while the existing public preview
ingestion/token and public prompt listing endpoints remain open. The existing
moderator report-read path is unchanged and requires a separate admin-auth
review; a signed ordinary wallet is not an admin role.

Focused session-route contract cases are in
`server/src/routes/walletReportPreviewRoutes.test.ts` (auth boundaries
mocked; no integration or Mongo assertions). This source change does not
claim that every wallet-bound family is migrated; fulfillment/admin routes
and front-end bearer adoption remain distinct acceptance tasks.

### Authenticated review and governance writes

`POST /api/reviews/submit`, `POST /api/governance/vote/:promptId` and
`DELETE /api/governance/vote/:promptId` now require the session bearer and its
matching permitted `Origin`. They derive the reviewer/voter wallet from the
verified principal. Legacy `userAddress` and `voterWallet` body fields are
optional compatibility selectors only: if supplied, they must match the signed
wallet or the mutation is rejected with 403. No session is denied with 401;
invalid session/configuration is rejected by the common verifier before any
review or vote query. Existing purchase eligibility, duplicate-vote, and
review rating checks are retained. Public `GET /api/reviews/list`,
`GET /api/governance/votes/:promptId`, and `GET /api/governance/top` stay open.

Clients issuing either write must obtain a wallet session first; a body-only
wallet address is no longer a valid credential. The focused Jest
`server/src/routes/walletAuthorizedWrites.test.ts` covers no-session, forged
wallet, authenticated reviewer/voter writes, and public vote-count access. The
cryptographic replay/expiry tests for the shared session core remain separate.

### Webhook owners and signing-secret rotation

`POST /api/webhooks`, `GET /api/webhooks` and `DELETE /api/webhooks`
now use the same revocable wallet session as other wallet-bound routes.
The bearer token and permitted `Origin` establish the subscription owner.
An optional legacy `walletAddress` in the request body/query may name only
that owner; mismatched selectors fail with 403 before accessing subscriptions.
Old standalone `signedMessage` and `timestamp` parameters are no longer
authorization credentials: callers must migrate to `POST /api/auth/session`.

The existing privileged rotation workflow may still manage a specified
other wallet, but only with the **server-side** `ADMIN_ROTATION_TOKEN`
(minimum 32 UTF-8 bytes). It must not be shipped to browser clients.
A missing, short or incorrect admin token never bypasses the signed
wallet verifier. Admin requests must explicitly supply a target wallet.
Webhook URL SSRF checks and event allowlisting are still enforced; GET never
returns the subscription secret.

On every registration/update the server returns a new 32-byte random
webhook signing secret. **Updates now store this new secret before returning
it** (previously the response promised a rotation that was not actually
persisted). Callers must atomically replace their old secret with this
returned value; signatures produced after rotation use the persisted new
secret. Seven narrow route cases were added at
`server/src/routes/webhookWalletAuth.test.ts` (auth boundary stubbed;
not executed in this source delivery). Live webhook receivers, admin
deployment configuration, and production session integration remain
operational acceptance checks, not claimed here.

### Fulfillment: buyer sessions are not privileged service credentials

A signed wallet session is required for the buyer's
`GET /api/fulfillment/:promptId/:buyerWallet` record lookup and
`POST /api/fulfillment/:promptId/:buyerWallet/request-refund`. The URL
wallet is only a selector and must match the signed session's principal
before database access (no session 401, mismatch 403). Refund eligibility
and the existing pending/failed transitions remain enforced.

Delivery state updates, privileged refund resolutions, pending-refund
enumeration, and the scheduled auto-refund sweep require a **different,
backend-only bearer**. Deployments must provision
`FULFILLMENT_SERVICE_TOKEN` (at least 32 UTF-8 bytes) in the *trusted*
unlock backend, admin/settlement backend and sweep scheduler, sending
`Authorization: Bearer ...` to the service endpoints. The token must
never appear in front-end code, app storage, GitHub files or logs.
An unset/short token yields 503, missing bearer 401, wrong bearer 403.
The check uses constant-time comparison, with `Cache-Control: no-store`.
An ordinary signed wallet cannot update another buyer's delivery status,
resolve a refund, enumerate the queue, or initiate a bulk sweep.
The delivery writer only accepts pending/delivered/failed statuses;
refund transitions go through their dedicated authorized paths.

**Operational deployment dependency:** update the actual unlock service,
admin service, and scheduler configuration before enabling these guards
in production. This branch does not deploy or validate any remote
service secret, wallet device, on-chain refund, or CI workflow.
Seven targeted regression cases were authored (not executed) in
`server/src/routes/fulfillmentAuth.test.ts`. Other privileged
reconciliation/moderation routes remain a separate authorization
boundary; this work does not claim they are complete.

Mongo retains issuance, last-use/count and revocation timestamps plus public
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
