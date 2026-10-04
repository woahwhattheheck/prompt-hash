# Unlock fail-closed policy (#166)

Before decrypting prompt content, unlock evaluates refund / dispute-hold state from `FulfillmentRecord` and key retention / delisting via `validateKeyPolicy`.

## Rules

- **Allow** — no blocking fulfillment status (or no record) and key policy active.
- **Deny (403 `ACCESS_NOT_PURCHASED`)** — `refund_requested` (open dispute) or `refunded`.
- **Unavailable (503 `TEMPORARY_FAILURE`)** — Mongo timeout, connection error, or any lookup failure. Client may retry. Response message is generic; no DB or policy internals are returned.

Lookup failures **never** continue to decryption (fail closed).

## Signed policy snapshot

After a successful live evaluation, an HMAC-signed snapshot is cached (~30s TTL) using the challenge token secret. During a brief outage, only a **fresh, validly signed** snapshot may satisfy the gate. Missing, stale, tampered, or malformed cache → unavailable. A signed `decision: "deny"` snapshot must include `denyReason: "refund_requested"` or `denyReason: "refunded"`. A missing or unsupported denial reason invalidates and evicts that snapshot; it cannot become an allow result. Signing alone does not establish a valid negative snapshot. Valid allow snapshots and supported denial messages are unchanged.

### Concurrent lookups

For each prompt and buyer, a successful lookup cannot replace a snapshot written by a later-started successful lookup. This prevents a delayed allow result from overwriting a newer refund or dispute denial, and also preserves newer recovery decisions. Ordering uses the lookup's invocation order, so identical timestamps do not permit a rollback. A later failed lookup does not prevent an earlier successful lookup from caching its result.

This ordering applies to snapshot publication within one cache instance. Each live evaluation still returns its own lookup result. The signed freshness timestamp remains the lookup start time, and freshness is checked after a failed lookup completes.

Explicit cache `set`, `delete`, and `clear` operations invalidate writes from lookups already pending for the affected entries. Ordering metadata is released when those lookups finish or time out.

## Non-goals

Dispute outcome semantics are unchanged; this only closes the bypass path when policy cannot be evaluated.
