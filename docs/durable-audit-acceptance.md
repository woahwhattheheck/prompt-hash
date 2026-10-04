# Durable unlock audit acceptance (#167)

Critical unlock audit events are **accepted into a durable outbox before** sensitive unlock outcomes complete. Acceptance returns an ID. A drain path writes accepted rows into the append-only `AuditLog` with retry and dead-letter.

## Critical events

- `unlock_success`
- `unlock_no_access`
- `unlock_integrity_failure`
- `unlock_invalid_signature`
- `unlock_replay_detected`
- `unlock_rate_limited`
- `unlock_expired_challenge`

Non-critical events still use fire-and-forget `recordAuditEvent`.

## Accept-before-complete

`acceptCriticalUnlockAudit` persists a **redacted** payload to `AuditOutbox` (`status=accepted`) and returns `acceptanceId` before unlock returns plaintext or a security denial. Successful unlocks set `X-Audit-Acceptance-Id`. The ID confirms outbox acceptance; it does not confirm that an `AuditLog` row has already been written.

Redaction: wallet and client IP are stored as SHA-256 hashes. Plaintext, keys, signatures, and challenge secrets are never stored.

## Outage policy (default: fail closed)

If accept fails (Mongo/queue outage or backlog saturation), unlock returns retryable `TEMPORARY_FAILURE` / 503 and **does not** release plaintext.

Optional degraded mode — set `AUDIT_DEGRADED_MODE=1`. Unlock may complete without an acceptance ID; ops must opt in. Metrics record `degraded`.

## Drain / retry / DLQ / backpressure

The current unlock handler starts `drainCriticalAuditOutbox(5)` without awaiting it after acceptance. This is a best-effort request-triggered drain. The adapter exports a drain function with a default limit of 50, but `server/src/server.ts` and the package scripts do not start a periodic outbox worker. Restarting that server alone does not invoke the drain. A completed response does not guarantee completion of its detached work, especially when a serverless invocation ends.

- A drain claims one due `accepted` row at a time, marks it `draining`, writes to `AuditLog`, then marks it `drained`.
- A failed write is scheduled for a later drain call. The Mongo adapter uses an initial backoff of 250 ms, doubled after each failure. There is no retry timer inside the queue; a later invocation must occur after `nextAttemptAt`.
- `AUDIT_OUTBOX_MAX_RETRIES` counts retries **after the initial attempt**. The default 5 permits up to 6 drain attempts ending in failure before `dlq`; 0 sends the first failed attempt to `dlq`.
- The backlog check counts `accepted` and `draining` rows, excluding `drained` and `dlq`. At the configured threshold, a new acceptance fails closed unless degraded mode is enabled. This count-then-insert check is not an atomic capacity reservation across concurrent acceptances.
- `getCriticalAuditMetrics()` returns the current queue instance's `accepted`, `drained`, `retried`, `dlq`, `dropped`, `degraded` and `acceptFailures` counters. These are process-local counters that reset with the instance; they are not persisted backlog totals or a supplied monitoring endpoint.

## Idempotency & crash recovery

Delivery key = hash(action|result|promptId|walletHash|requestId|reason). Duplicate accepts return the same acceptance ID. The `AuditOutbox` schema declares unique indexes for the delivery key and acceptance ID.

Recovery depends on the stored state:

| Interruption point | Retained state and current behavior |
| --- | --- |
| After acceptance, before a drain claims the row | The row remains `accepted` and can be claimed by a later drain invocation when due. Persistence survives a process restart, but drain execution must still resume. |
| After the claim, before completion or retry is recorded | The row can remain `draining`. `claimNext` selects only `accepted` rows; the current adapter has no lease expiry or automatic reclaim path for an abandoned claim. |
| After an `AuditLog` write, before `markDrained` completes | The destination write and outbox update are separate. A retry can write another log row because `persistToAuditLog` uses `AuditLog.create` without an acceptance-ID uniqueness guard. |

Acceptance deduplication therefore does not establish exactly-once destination delivery or complete crash recovery. Keep the acceptance ID and inspect the outbox and corresponding log state before any manual recovery. Automatic reclamation, destination deduplication and a scheduled worker require an explicit implementation and operational verification; this guide supplies no delete/reset/requeue command.

## Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `AUDIT_DEGRADED_MODE` | off | Exact `1`, `true` or `yes` enables completion without an acceptance ID when acceptance fails |
| `AUDIT_OUTBOX_MAX_BACKLOG` | 1000 | Open-row threshold; configure a positive integer |
| `AUDIT_OUTBOX_MAX_RETRIES` | 5 | Retries after the initial persistence attempt; configure a nonnegative integer |

Set these in the server environment. Backlog and retry settings are read when the shared queue is first created, so restart the process to apply changes. Each accepted row retains its own retry limit; changing the setting does not rewrite older rows. The degraded flag is read on each critical acceptance call. The current numeric readers use base-10 `parseInt` with the defaults above as fallbacks, rather than a strict configuration-schema check.

For a local maintainer check, `npm run test:durable-audit` runs only `src/lib/audit/durableAudit.test.ts`; its dedicated configuration does not include the unlock handler test file. Live Mongo durability, destination-write interruptions, abandoned claims and worker restart behavior also need integration verification before relying on a deployment's recovery guarantees.

## Non-goals

Hash-chain redesign (tracked separately).
