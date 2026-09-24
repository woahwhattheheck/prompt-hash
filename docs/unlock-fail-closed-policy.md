# Unlock fail-closed policy (#166)

Before decrypting prompt content, unlock evaluates refund / dispute-hold state from `FulfillmentRecord` and key retention / delisting via `validateKeyPolicy`.

## Rules

- **Allow** — no blocking fulfillment status (or no record) and key policy active.
- **Deny (403 `ACCESS_NOT_PURCHASED`)** — `refund_requested` (open dispute) or `refunded`.
- **Unavailable (503 `TEMPORARY_FAILURE`)** — Mongo timeout, connection error, or any lookup failure. Client may retry. Response message is generic; no DB or policy internals are returned.

Lookup failures **never** continue to decryption (fail closed).

## Signed policy snapshot

After a successful live evaluation, an HMAC-signed snapshot is cached (~30s TTL) using the challenge token secret. During a brief outage, only a **fresh, validly signed** snapshot may satisfy the gate. Missing, stale, or tampered cache → unavailable.

## Non-goals

Dispute outcome semantics are unchanged; this only closes the bypass path when policy cannot be evaluated.
