# Redis cache pattern invalidation

## Why

Prompt mutations invalidate list/search cache prefixes (`prompts:list:*`, `prompts:search:*`) via `cacheDelPattern`. Redis `KEYS` blocks the server while walking the entire keyspace, so large deployments can see latency spikes on unrelated GETs/SETs during invalidation.

## Behavior

`cacheDelPattern(pattern)`:

1. Marks matching in-flight `cacheGetOrLoad` work invalid so those loaders cannot later populate the cache with their old results.
2. Walks matching keys with cursor `SCAN MATCH <pattern> COUNT 100` (see `SCAN_BATCH_SIZE`).
3. Deletes each hop's matches with a separate bounded `DEL` (`DELETE_BATCH_SIZE`).
4. Logs `[cache] invalidate` with `{ pattern, durationMs, scannedKeys, deletedKeys, scanBatches, failures }` — never key values or secrets.

Individual SCAN/DEL hops still use the 250ms command timeout. A stalled hop destroys the client and marks the cache unavailable briefly (same reliability path as other commands). A soft delete-batch failure increments `failures` and continues remaining hops.

## In-flight bookkeeping

Invalidation state belongs to outstanding loads. Exact-key invalidation marks the current load for each key; pattern invalidation compiles its matcher once and visits the current in-flight keys. Finished keys and old patterns are not retained for the process lifetime. A replaced load keeps its own invalid flag until it settles, so completing an older load cannot restore its permission to write or remove a newer shared load.

The pending entry is registered before invoking the loader, including a loader that invalidates synchronously. Rejected loads release their entry for a later retry. The current application uses the two fixed list/search patterns above; exact-key invalidation can see a new detail key for every prompt ID.

This is an in-process loader fence. It does not make Redis invalidation and population an atomic transaction or change the handling of a read that already returned a cached value.

## Repeatable bookkeeping benchmark

From `server/`, after installing the committed dependencies:

```bash
node --expose-gc -r ts-node/register scripts/benchmarkCacheInvalidation.cjs
```

Optional positional arguments set distinct-key history and load counts, for example `100000 20000`. Run the same script in separate baseline and candidate processes. It invokes the actual cache service and deliberately unsets `REDIS_URL` in that process: these measurements isolate in-process bookkeeping and do not measure Redis or HTTP latency. Keys are generated during the loop rather than retained by a fixture. The script warms the service, collects garbage before and after history creation, verifies the load-result checksum, and reports the actual source SHA-256.

Observed on Node 24.19.0 on October 3, 2026, medians of three fresh processes with 100,000 distinct prompt-detail invalidations, the two production patterns, and 20,000 completed loads:

| Measurement | Baseline `1df7748` | In-flight tracking |
| --- | ---: | ---: |
| Retained heap after invalidation history | 9,255,992 bytes | -10,504 bytes (GC noise around zero) |
| Time for 20,000 fallback loads | 106.33 ms | 47.95 ms |
| Pattern invalidation with 1,000 pending loads | 0.034 ms | 0.387 ms |

The pending-load sample has equal numbers of matching list keys and unrelated detail keys. The measured load loop was 2.22 times faster, while pattern work moved into the invalidation call and scales with current pending loads. The removal of lifetime history does not bound the number of requests an application may leave outstanding. These are local component observations; deployed latency and hosted CI remain separate.

Baseline cache source SHA-256: `f421f3870ac8ce4135899df7cd48381c32f2d50d4156dd7453fc3cddbb04bcb3`. Candidate cache source SHA-256: `6ae2758971d0cea9f6546e2fad67bb7013295dc25f8688be4b049fa7eaeef16e`.

## Non-goals

- Cached JSON payload shapes are unchanged.
- Key naming / `CACHE_KEYS` prefixes are unchanged (no namespace versioning in this change).

## Ops notes

- Prefer watching `[cache] invalidate` duration and `failures` under write-heavy load.
- If `failures` is consistently non-zero, inspect Redis role (e.g. replica READONLY) and connectivity.
