# Unlock fail-closed policy (#166)

Before decrypting prompt content, unlock evaluates refund / dispute-hold state from `FulfillmentRecord` and key retention / delisting via `validateKeyPolicy`.

## Rules

- **Allow** — no blocking fulfillment status (or no record) and key policy active.
- **Deny (403 `ACCESS_NOT_PURCHASED`)** — `refund_requested` (open dispute) or `refunded`.
- **Unavailable (503 `TEMPORARY_FAILURE`)** — Mongo timeout, connection error, or any lookup failure. Client may retry. Response message is generic; no DB or policy internals are returned.

Lookup failures **never** continue to decryption (fail closed).

## Signed policy snapshot

After a successful live evaluation, an HMAC-signed snapshot is cached (~30s TTL) using the challenge token secret. During a brief outage, only a **fresh, validly signed** snapshot may satisfy the gate. Missing, stale, tampered, or malformed cache → unavailable. A signed `decision: "deny"` snapshot must include `denyReason: "refund_requested"` or `denyReason: "refunded"`. A missing or unsupported denial reason invalidates and evicts that snapshot; it cannot become an allow result. Signing alone does not establish a valid negative snapshot. Valid allow snapshots and supported denial messages are unchanged.

A freshness timestamp must be finite and no later than the time the failed lookup completes. A clock rollback therefore makes a future-dated snapshot unavailable and evicts it; waiting for the clock to catch up cannot revive that snapshot. A new successful live lookup can publish a replacement. The existing inclusive TTL boundary is preserved.

### Concurrent lookups

For each prompt and buyer, a successful lookup cannot replace a snapshot written by a later-started successful lookup. This prevents a delayed allow result from overwriting a newer refund or dispute denial, and also preserves newer recovery decisions. Ordering uses the lookup's invocation order, so identical timestamps do not permit a rollback. A later failed lookup does not prevent an earlier successful lookup from caching its result.

This ordering applies to snapshot publication within one cache instance. Each live evaluation still returns its own lookup result. The signed freshness timestamp remains the lookup start time, and freshness is checked after a failed lookup completes.

Explicit cache `set`, `delete`, and `clear` operations invalidate writes from lookups already pending for the affected entries. Ordering metadata is released when those lookups finish or time out.

## Timestamp validation evidence (October 4, 2026)

The exact exported policy helper was executed with Node 24.19.0, local synthetic identities, an injected finder, and its explicit `now` option. Seven focused observations changed from 3 passing controls / 4 failures on the parent source to 7 passing on this correction: future allow and refund snapshots are evicted and stay unavailable after the clock catches up; correctly signed JSON timestamps `1e309` and `-1e309` are rejected; ages 0 ms, 30,000 ms and 30,001 ms retain their existing boundary outcomes. This is policy-helper execution, not a live Mongo or full unlock HTTP result.

The corresponding seven cases are added to the existing test file. Run just those cases with:

```sh
npm run test:unlock-policy -- src/lib/unlock/unlockPolicy.test.ts -t 'future-dated|nonfinite timestamp|freshness boundary' --maxWorkers=1 --no-file-parallelism
```

The Vitest command was not run for this continuation; the focused native helper execution above completed. Earlier ordering and denial-shape evidence remains attached to its original source revisions.

## Non-goals

Dispute outcome semantics are unchanged; this only closes the bypass path when policy cannot be evaluated.
