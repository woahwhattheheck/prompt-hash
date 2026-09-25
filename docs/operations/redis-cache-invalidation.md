# Redis cache pattern invalidation

## Why

Prompt mutations invalidate list/search cache prefixes (`prompts:list:*`, `prompts:search:*`) via `cacheDelPattern`. Redis `KEYS` blocks the server while walking the entire keyspace, so large deployments can see latency spikes on unrelated GETs/SETs during invalidation.

## Behavior

`cacheDelPattern(pattern)`:

1. Bumps an in-process pattern generation so in-flight `cacheGetOrLoad` work cannot write stale values.
2. Walks matching keys with cursor `SCAN MATCH <pattern> COUNT 100` (see `SCAN_BATCH_SIZE`).
3. Deletes each hop's matches with a separate bounded `DEL` (`DELETE_BATCH_SIZE`).
4. Logs `[cache] invalidate` with `{ pattern, durationMs, scannedKeys, deletedKeys, scanBatches, failures }` — never key values or secrets.

Individual SCAN/DEL hops still use the 250ms command timeout. A stalled hop destroys the client and marks the cache unavailable briefly (same reliability path as other commands). A soft delete-batch failure increments `failures` and continues remaining hops.

## Non-goals

- Cached JSON payload shapes are unchanged.
- Key naming / `CACHE_KEYS` prefixes are unchanged (no namespace versioning in this change).

## Ops notes

- Prefer watching `[cache] invalidate` duration and `failures` under write-heavy load.
- If `failures` is consistently non-zero, inspect Redis role (e.g. replica READONLY) and connectivity.
