# Distinct critical-event delivery keys

Follow-up to issue #167 and the existing durable-audit PR #263.

## Failure and repair

The previous key hashed six variable fields joined with `|`. With the other fields equal, `requestId=a|b, reason=c` and `requestId=a, reason=b|c` produced the same bytes and the same delivery key. The second call to `accept` therefore returned the first event's acceptance ID as a duplicate instead of retaining the second event. This is an encoding collision, not a SHA-256 collision.

`buildDeliveryKey` now frames tuples containing delimiter-bearing values as a version-prefixed JSON array before hashing. Ordinary tuples retain their existing key bytes. The field set, wallet/IP redaction, null/empty handling, lease ownership, retry rules, AuditLog uniqueness and degraded-mode behavior are unchanged.

On a missing new-format key, acceptance checks the old key only for delimiter-bearing tuples. It reuses a legacy receipt only when the stored payload has the same new-format identity. A legacy record for a different event cannot substitute for the requested one. The usual backlog check still applies to that new event. Ordinary keys require no additional lookup; a failed legacy lookup remains fail-closed.

## Executed reproduction

October 4, 2026; Node.js v22.16.0 on Linux. The complete production TypeScript module was imported by Node's native TypeScript stripping and used its actual in-memory outbox implementation. No extracted replacement implementation or external service was used.

```sh
node --experimental-strip-types --test tests/durableAuditDeliveryKey.node.test.mjs
```

The identical test file can replay an older full source file:

```sh
DURABLE_AUDIT_SOURCE=/absolute/path/to/durableAudit.original.ts \
  node --experimental-strip-types --test tests/durableAuditDeliveryKey.node.test.mjs
```

| Production source | Passed | Failed | Exit |
| --- | ---: | ---: | ---: |
| Parent `649684da482c807ddc0a00fac52515c69fccd04a`, blob `118e61ac6078d3983934c5135e25dc5d6285573c` | 4 | 3 | 1 |
| Repaired blob `d1b4ba14f5fddb5adccac896659655c58472b134` | 7 | 0 | 0 |

The three original failures are distinct-event retention/drain, a collision with an existing legacy record, and backlog enforcement for the falsely deduplicated event. Passing controls cover concurrent exact retries, unchanged ordinary keys and lookup counts, matching legacy receipt reuse, and fail-closed lookup errors. No tests were skipped.

This is source-bound core/outbox evidence, not a MongoDB, HTTP-handler, complete application, hosted CI, performance, or deployment result. No dependencies were installed and no live credentials or provider requests were used.

## Rollout limits

No existing outbox record is rewritten or deleted. Upgrade all accepting writers before relying on collision-safe admission; an old writer still uses the ambiguous encoding. The existing unique delivery-key index remains required for concurrent MongoDB insertion. This repair cannot reconstruct events that older code already discarded as duplicates; retained upstream request/audit evidence must be considered separately. It does not change which fields define an event or promise cross-process atomic backlog admission.
