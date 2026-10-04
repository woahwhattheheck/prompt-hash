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

The unlock handler retains its best-effort `drainCriticalAuditOutbox(5)` call after acceptance. The long-lived `server/src/server.ts` process also starts an independent recovery worker when its HTTP listener starts. The worker connects through the existing Mongo helper, immediately drains up to 50 due rows, then waits one second after that call settles before polling again. Accepted rows and due retries therefore resume after a server restart without requiring another unlock request. A standalone serverless unlock invocation still does not guarantee completion of detached work; run the long-lived server against the same outbox for independent recovery.

- A drain atomically claims one due `accepted` row or an abandoned `draining` row. It sets a fresh lease token and deadline, writes to `AuditLog`, then marks the row `drained`. A live, unexpired claim is excluded from other drainers.
- An expired claim can be reclaimed by a later drain call. A completion, retry or dead-letter update must match the current claim token; a superseded worker cannot alter the replacement claim or increment its own completion counters. The default lease is 30 seconds, configurable with `AUDIT_OUTBOX_LEASE_MS`.
- A failed write is scheduled for a later drain call. The Mongo adapter uses an initial backoff of 250 ms, doubled after each failure and measured from the failed write's completion, so time spent awaiting persistence does not consume the retry delay. There is no retry timer inside the queue; a later invocation must occur after `nextAttemptAt`.
- `AUDIT_OUTBOX_MAX_RETRIES` counts retries **after the initial attempt**. The default 5 permits up to 6 drain attempts ending in failure before `dlq`; 0 sends the first failed attempt to `dlq`.
- The backlog check counts `accepted` and `draining` rows, excluding `drained` and `dlq`. At the configured threshold, a new acceptance fails closed unless degraded mode is enabled. This count-then-insert check is not an atomic capacity reservation across concurrent acceptances.
- `getCriticalAuditMetrics()` returns the current queue instance's `accepted`, `drained`, `retried`, `dlq`, `dropped`, `degraded` and `acceptFailures` counters. These are process-local counters that reset with the instance; they are not persisted backlog totals or a supplied monitoring endpoint.

## Idempotency & crash recovery

Delivery key = hash(action|result|promptId|walletHash|requestId|reason). Duplicate accepts return the same acceptance ID. The `AuditOutbox` schema declares unique indexes for the delivery key and acceptance ID.

Recovery depends on the stored state:

| Interruption point                                        | Retained state and current behavior                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After acceptance, before a drain claims the row           | The row remains `accepted` and can be claimed by a later drain invocation when due. Persistence survives a process restart, but drain execution must still resume.                                                                                                                                                                                                  |
| After the claim, before completion or retry is recorded   | The row remains `draining` until a later drain reclaims its expired lease with a new token. A delayed older worker cannot acknowledge, retry or dead-letter the replacement claim.                                                                                                                                                                                  |
| After an `AuditLog` write, before `markDrained` completes | The row retains its lease; an acknowledgement failure does not consume persistence retries or send a successfully written event to DLQ. After reclamation, the destination insert uses the same acceptance ID. Its unique index rejects a second row; delivery succeeds only after the existing acceptance ID is confirmed, then the current claim is acknowledged. |

`AuditLog` declares a unique partial index on string `acceptanceId` values. Existing audit records without that field remain valid. Delivery continues through `AuditLog.create` and its save middleware, preserving the existing immutable-record and hash-chain behavior. An unrelated duplicate-key error is not acknowledged. This is deduplication of the destination row; a persistence callback can still be invoked again after an interrupted acknowledgement.

Before deploying recovery, ensure the acceptance-ID unique index exists. The adapter awaits model initialization when Mongoose manages indexes; deployments with `autoIndex` disabled must provision the declared index themselves. Stop or finish older workers before relying on token fencing, because their acknowledgement code does not include the token. A legacy `draining` row with missing or null lease metadata is eligible for reclamation. If an older worker had already written a destination record without an acceptance ID, the new index cannot identify that historical delivery; inspect those legacy states before rollout to avoid a duplicate historical log.

Lease expiry makes a row eligible for a later drain; the server recovery worker supplies those invocations while it is running. Each process runs only one worker drain at a time, and existing Mongo claims coordinate separate processes and request-triggered drains. This does not serialize concurrent hash-chain appends or change the count-then-insert capacity check.

## Recovery worker lifecycle

Connection and drain failures leave polling active. The worker logs an outage once and retries through the existing connection helper, which clears failed connection promises. A slow call settles before the next one starts; the one-second interval is not an individual Mongo-operation timeout. Existing row retry deadlines and lease expiry remain authoritative.

On `SIGINT` or `SIGTERM`, the server stops new polls and closes its HTTP listener. It waits for active requests and the current drain before disconnecting the shared Mongo connection. A forced process termination can still interrupt a claim; the next process recovers it through the existing lease mechanism. Closing the HTTP server programmatically also stops the worker and closes the connection.

A focused local lifecycle check on Node 24.19.0 loaded the real worker and queue with an in-memory store, controlled timers/clock and a controlled persistence callback. One initial connection failure, one failed persistence attempt and a held successful retry produced `accepted -> retry -> drained` across three polls. Maximum concurrent worker calls was one; stop waited for the held write and left no timer. This was not an HTTP shutdown, real Mongo, deployed restart or full-suite execution.

## Env

| Variable                   | Default | Meaning                                                                                      |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `AUDIT_DEGRADED_MODE`      | off     | Exact `1`, `true` or `yes` enables completion without an acceptance ID when acceptance fails |
| `AUDIT_OUTBOX_MAX_BACKLOG` | 1000    | Open-row threshold; configure a positive integer                                             |
| `AUDIT_OUTBOX_MAX_RETRIES` | 5       | Retries after the initial persistence attempt; configure a nonnegative integer               |
| `AUDIT_OUTBOX_LEASE_MS`    | 30000   | Claim duration in milliseconds; a finite positive number, otherwise the default is used      |

Set these in the server environment. Backlog, retry and lease settings are read when the shared queue is first created, so restart the process to apply changes. Each accepted row retains its own retry limit; changing the setting does not rewrite older rows. The degraded flag is read on each critical acceptance call. Backlog and retry readers use base-10 `parseInt` with the defaults above as fallbacks; the lease reader requires a finite positive number.

For a local maintainer check, `npm run test:durable-audit` runs the queue and destination-adapter cases. These cover abandoned leases, stale success/retry/DLQ transitions, and a successful destination insertion followed by an acknowledgement outage with zero persistence retries. Adapter fault injection controls the database boundary; it does not establish live Mongo durability or index installation.

Set `AUDIT_TEST_MONGODB_URI` to a disposable Mongo endpoint to also run the three Mongo integration cases with the same command. Each run creates and removes its own uniquely named test database. They exercise competing atomic claims, stale transitions, unique destination insertion after an acknowledgement interruption, and compatibility with legacy records. Without this variable those cases are explicitly skipped. The dedicated configuration still excludes the unlock handler tests. The deployed server lifecycle and actual Mongo integration must still be verified in the target environment before relying on its recovery guarantees.

### Recovery continuation validation (2026-10-04)

The focused command passed 25 queue and destination-adapter cases with Vitest 4.1.10 and Node 24.19.0; the three opt-in Mongo cases were skipped. Strict TypeScript 6.0.3 checking covered the changed queue, adapter, models and tests. Formatting checks passed with Prettier 3.8.3.

A controlled native comparison against parent source `3d777ee8b45eeb4cb781a40cdf71acceabe58c4f` reproduced two failures: an abandoned claim remained `draining` and a later drain returned `idle`; a successful persistence callback followed by acknowledgement failure entered DLQ when `maxRetries=0`. With this change, the expired claim drained, and acknowledgement failure retained a recoverable claim without consuming retries or DLQ. These executions used the real queue with controlled store and destination boundaries, not a killed Mongo process.

An isolated local MongoDB 7.0.14 startup attempt exited with code 100 and `open: Operation not permitted`. The native run therefore skipped the three opt-in database cases. Those same cases were subsequently executed against a disposable MongoDB 7.0.14 service in the public fork.

### Hosted Mongo validation (2026-10-04)

[Run 37186271164](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37186271164) completed successfully and explicitly checked out published source `f863e3f33b4d35edd4a91395934c975cd29f58eb`. Only `tests/durableAuditQueue.mongo.test.ts` was selected through the existing dedicated configuration: **3 passed, 0 skipped**, with Vitest duration 595 ms. The recorded runtime was Node 24.19.0, Vitest 4.1.10, Mongoose 9.9.2 and Vite 8.3.2.

The live Mongo cases confirmed that competing reclaimers obtain only one claim, every stale-token transition fails to match, replay after an acknowledgement interruption leaves exactly one unchanged destination row, and the partial unique index coexists with legacy records lacking acceptance IDs. The cases awaited model/index initialization and used a uniquely named disposable database, which was removed afterward. The job's Mongo service and all steps completed successfully.

This result establishes those database operations on the published source with injected worker-abandonment and acknowledgement failures. It does not establish a killed application process, deployment restart scheduling, target-environment index provisioning or production rollout. The rollout conditions above still apply. The validation workflow lives only on `validation/ph263-mongo-2050-20261004`, outside the bounty PR branch.

## Non-goals

Hash-chain redesign (tracked separately).
