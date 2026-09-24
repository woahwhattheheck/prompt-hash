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

`acceptCriticalUnlockAudit` persists a **redacted** payload to `AuditOutbox` (`status=accepted`) and returns `acceptanceId` before unlock returns plaintext or a security denial. Successful unlocks set `X-Audit-Acceptance-Id`.

Redaction: wallet and client IP are stored as SHA-256 hashes. Plaintext, keys, signatures, and challenge secrets are never stored.

## Outage policy (default: fail closed)

If accept fails (Mongo/queue outage or backlog saturation), unlock returns retryable `TEMPORARY_FAILURE` / 503 and **does not** release plaintext.

Optional degraded mode — set `AUDIT_DEGRADED_MODE=1`. Unlock may complete without an acceptance ID; ops must opt in. Metrics record `degraded`.

## Drain / retry / DLQ / backpressure

- Drain writes accepted rows to `AuditLog`.
- Exponential backoff retry, then `dlq`.
- Metrics: `accepted`, `drained`, `retried`, `dlq`, `dropped`, `degraded`, `acceptFailures`.
- Backlog cap (`AUDIT_OUTBOX_MAX_BACKLOG`, default 1000) rejects new accepts when saturated.

## Idempotency & crash recovery

Delivery key = hash(action|result|promptId|walletHash|requestId|reason). Duplicate accepts return the same acceptance ID. Process crash after accept, before drain: outbox still holds the event; drain recovers on restart.

## Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `AUDIT_DEGRADED_MODE` | off | Opt-in: allow unlock without acceptance ID |
| `AUDIT_OUTBOX_MAX_BACKLOG` | 1000 | Fail closed when open outbox ≥ this |
| `AUDIT_OUTBOX_MAX_RETRIES` | 5 | Attempts before DLQ |

## Non-goals

Hash-chain redesign (tracked separately).
