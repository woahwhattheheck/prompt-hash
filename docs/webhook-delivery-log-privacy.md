# Webhook Delivery Log Privacy

**Issue:** [#176](https://github.com/Prompt-Hash-Stellar/prompt-hash/issues/176)

## Summary

Webhook delivery records must never expose subscriber URL credentials, sensitive
query values, or raw network/provider error detail. Logs are retained for a
bounded window and then removed.

## What is stored

| Field | Contents |
|---|---|
| `endpointIdentity` | Redacted identity: `scheme://host[:port]/path` with userinfo stripped and sensitive query values replaced by `[REDACTED]` |
| `url` | Legacy alias of `endpointIdentity` (never credentials) |
| `encryptedDestination` | Optional AES-256-GCM ciphertext of the original URL for operational recovery (`select: false`) |
| `encryptionKeyVersion` | Key version used for `encryptedDestination` |
| `errorCode` | Closed set (`http_client_error`, `http_server_error`, `http_rate_limited`, `timeout`, `ssrf_blocked`, `dns_failed`, `redirect_error`, `network_error`, `unknown`) |
| `lastError` | Capped (≤200 chars), sanitized summary — never raw exception text |
| `expiresAt` | Retention deadline (Mongo TTL index) |

## Redaction rules

1. **Userinfo** — always stripped (`https://user:pass@host/...` → `https://host/...`).
2. **Sensitive query keys** — values replaced with `[REDACTED]` for keys such as
   `token`, `api_key`, `secret`, `password`, `auth`, `access_token`, `signature`,
   and common `*_token` / `*_secret` / `*_key` patterns. Harmless params (e.g. `ref`)
   are kept.
3. **Malformed URLs** — stored as `[invalid-url]` (never echo the raw input).

## Encryption (optional)

Set `WEBHOOK_DESTINATION_ENCRYPTION_KEY` to a 32-byte key (64-char hex or base64).
Optionally set `WEBHOOK_DESTINATION_ENCRYPTION_KEY_VERSION` (default `1`).

For rotation:

1. Move the current key to `WEBHOOK_DESTINATION_ENCRYPTION_KEY_PREVIOUS` (+ `_PREVIOUS_VERSION`).
2. Set the new key as `WEBHOOK_DESTINATION_ENCRYPTION_KEY` with an incremented version.
3. New logs encrypt with the new version; decrypt still accepts the previous key.

If no key is configured, `encryptedDestination` is left null — plaintext destinations
are **never** written to the log.

## Error normalization

Delivery failures persist an `errorCode` from the closed set above plus a short
`lastError`. HTTP statuses become `HTTP <n>`. Timeouts, SSRF blocks, DNS failures,
and network errors use stable messages. Unknown errors are sanitized (URLs/IPs
stripped) and capped at 200 characters.

## Retention policy

- Default TTL: **30 days** from create (`expiresAt`).
- Override with `WEBHOOK_DELIVERY_LOG_TTL_DAYS` (positive integer; capped at 3650).
- MongoDB TTL index on `expiresAt` (`expireAfterSeconds: 0`) removes expired documents.
- Ops may also call `purgeExpiredDeliveryLogs()` for an explicit synchronous purge.

## Surfaces that must stay safe

- `WebhookDeliveryLog` documents and any API that returns them
- Reconciliation mismatch `details` (uses `publicDeliveryLogEndpoint`)
- Application logs that reference delivery endpoints

Retry timing, backoff, and disable-after-N-failures are **unchanged**.

## Tests

```bash
npm --prefix server run test:webhook-log-privacy
```
