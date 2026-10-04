# Server Runtime Config & Graceful Shutdown

**Issue:** [#171](https://github.com/Prompt-Hash-Stellar/prompt-hash/issues/171)

## Summary

The auxiliary Express server reads a validated runtime config at boot, retains the
`http.Server` handle, and installs a bounded `SIGTERM` / `SIGINT` shutdown path.
In-flight requests are drained, tracked timers are cleared, and the MongoDB
connection pool is closed. No interval or DB connection should survive a clean
test or container stop.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `5000` | Integer 1–65535. Deployment-provided port is honored. |
| `HOST` | `0.0.0.0` | Bind address. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Max time to drain + disconnect before forced exit (100–300000). |
| `ENABLE_INPROCESS_SCHEDULER` | `false` | Optional tick registry only. **Backups stay cron-only** (`backup.crontab`). |
| `SCHEDULER_TICK_MS` | `60000` | Integer 100–86400000 when the in-process scheduler is enabled; ignored when disabled. |

Invalid values for active runtime settings fail fast at boot with
`Invalid runtime configuration: …`. When `ENABLE_INPROCESS_SCHEDULER` is false
(the default), `SCHEDULER_TICK_MS` is not parsed and the returned runtime config
uses `60000` ms. An unused tick value therefore cannot block startup. Enabling
the scheduler restores validation of the configured interval; `PORT`, `HOST`,
`SHUTDOWN_TIMEOUT_MS` and the scheduler boolean are validated in either mode.

## Shutdown sequence

1. First `SIGTERM` / `SIGINT` (or explicit `lifecycle.shutdown()`) begins shutdown.
2. `server.close()` stops accepting new connections and drains in-flight requests.
3. Tracked timers (`setInterval` / `setTimeout` registered via `trackTimer`) are cleared.
4. `disconnectDb()` closes mongoose and clears the connection cache.
5. If steps 2–4 exceed `SHUTDOWN_TIMEOUT_MS`, the process force-exits (`exit code 1`).
6. Repeated signals are idempotent — they share the in-flight shutdown promise.

## Non-goals

- Backup content/format is unchanged.
- In-process backup loops are **not** reintroduced; use `server/backup.crontab`.

## Tests

```bash
npm --prefix server run test:server-lifecycle
```

Covers invalid config, SIGTERM during an in-flight request, timer cleanup,
forced timeout, and repeated shutdown signals.
