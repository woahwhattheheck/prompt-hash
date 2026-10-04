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

## Bounded snapshot retention (October 4, 2026)

Each cache now retains at most **10,000 snapshots** by default. An injected cache may use `new UnlockPolicyCache(maxEntries)` with a positive safe integer. This limit is per process and covers cached snapshots; pending lookup ordering state continues to be released when those lookups finish or time out.

Publishing a new snapshot updates its retention order. At capacity, publication evicts the oldest published snapshot in constant time using linked entries, without scanning all keys. Reads do not extend retention order or the signed TTL. An evicted snapshot cannot authorize an outage fallback: that lookup returns unavailable until live policy evaluation succeeds. This trades some outage-cache coverage for bounded memory.

Expired snapshots encountered during outage fallback are now released. Routine eviction preserves pending lookup ordering, so a healthy in-flight refresh can still publish, and a delayed older result cannot resurrect an evicted newer decision. Explicit `set`, `delete`, and `clear` retain their prior invalidation semantics.

### Measured retention and execution

The parent source `fe98ff2ac2538886c5814f88b5a4a6249dff674d` and this source were executed as actual TypeScript modules on Node v24.19.0. Three alternating-order pairs each evaluated **100,000 distinct prompt/buyer keys**, after 2,000-key warmups, with a synthetic successful finder, real HMAC signing, and explicit GC around retained-heap measurement.

| Pair | Parent retained heap (bytes) | Bounded retained heap (bytes) | Parent loop (ms) | Bounded loop (ms) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 42,957,432 | 5,732,632 | 869.74 | 957.88 |
| 2 | 42,943,112 | 5,695,168 | 606.14 | 903.82 |
| 3 | 42,948,088 | 5,712,864 | 607.59 | 984.98 |

Every parent sample retained 100,000 snapshots; every bounded sample retained exactly 10,000. Median retained heap fell from **42,948,088 to 5,712,864 bytes**, leaving **13.30%** of the previous retained heap for this workload. Median loop time increased from **607.59 to 957.88 ms** (about 57.7%, or 3.50 microseconds per lookup). This is a memory bound with a per-lookup CPU cost, not a measured throughput speedup. Heap and timing values are specific to this synthetic same-host run; no Mongo, HTTP, or concurrent-production benchmark is claimed.

Five focused cases were added to the existing Vitest file, and the existing stale-cache case now asserts eviction. Equivalent native assertions against the exported helper changed from **1/7 groups passing on the parent to 7/7 passing**: six capacity/expiry scenarios plus a control group covering the original no-record, refund, dispute, timeout, connection, stale, and recovery behavior. The native run includes pending-refresh preservation and old-result publication ordering. The maintained Vitest command was not run in this continuation; no dependency install or full application build was performed.

Run the maintained capacity/expiry selection in a checkout with the existing dependencies:

```sh
npm run test:unlock-policy -- src/lib/unlock/unlockPolicy.test.ts -t 'bounds snapshot|newly published|evicted newer|bounded retention|in-flight refresh|rejects stale cache' --maxWorkers=1 --no-file-parallelism
```

Reproduce the paired retention measurement from the repository root with Node 24:

```sh
export PH262_BASELINE_FILE="$(mktemp /tmp/ph262-before-XXXXXX.ts)"
git show fe98ff2ac2538886c5814f88b5a4a6249dff674d:src/lib/unlock/unlockPolicy.ts > "$PH262_BASELINE_FILE"
node --expose-gc --input-type=module <<'JS'
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { unlinkSync } from 'node:fs';
const before = await import(pathToFileURL(process.env.PH262_BASELINE_FILE));
const after = await import('./src/lib/unlock/unlockPolicy.ts');
async function measure(mod, count) {
  global.gc();
  const heapStart = process.memoryUsage().heapUsed;
  const cache = new mod.UnlockPolicyCache();
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    await mod.evaluateUnlockFulfillmentPolicy({
      promptId: String(i), buyerWallet: 'GLOCALBUYER',
      signingSecret: 'local-measurement-key', cache, now: 1000,
      findFulfillment: async () => null,
    });
  }
  const elapsedMs = performance.now() - start;
  global.gc();
  const retainedHeapBytes = process.memoryUsage().heapUsed - heapStart;
  let retainedEntries = 0;
  for (let i = 0; i < count; i++) {
    if (cache.get(String(i), 'GLOCALBUYER')) retainedEntries++;
  }
  return { retainedHeapBytes, retainedEntries, elapsedMs };
}
await measure(before, 2000); await measure(after, 2000);
const pairs = [];
for (let i = 0; i < 3; i++) {
  let b, a;
  if (i % 2 === 0) {
    b = await measure(before, 100000); a = await measure(after, 100000);
  } else {
    a = await measure(after, 100000); b = await measure(before, 100000);
  }
  pairs.push({ before: b, after: a });
}
console.log(JSON.stringify({ node: process.version, count: 100000, pairs }, null, 2));
unlinkSync(process.env.PH262_BASELINE_FILE);
JS
unset PH262_BASELINE_FILE
```


## Non-goals

Dispute outcome semantics are unchanged; this only closes the bypass path when policy cannot be evaluated.
