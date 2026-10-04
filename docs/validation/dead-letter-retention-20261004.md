# Bounded dead-letter retention — October 4, 2026

## Change and compatibility

The original full sink called `splice(0, 1)` for each additional record. The
replacement overwrites one circular-buffer slot and advances the oldest index.
Steady-state insertion is constant work instead of moving the retained window.
Storage grows lazily; no capacity-sized allocation occurs at construction.

`list()` and `byReason()` remain oldest-first, return new arrays, and preserve
record references. `clear()` releases the retained entries and resets ordering.
The default capacity remains 1,000; zero retains nothing. Invalid capacities
(negative, fractional, nonfinite, or unsafe integers) now throw `RangeError` at
construction rather than silently providing an unreliable retention bound.
This is a configuration validation change. It does not alter event decoding,
contract schemas, or the existing synchronous/asynchronous routing boundary.

Reading a wrapped full list uses two slices and concatenation, so this optimizes
a rejection-heavy stream, not a read-only workload. `byReason()` walks the ring
without materializing a second full list. Both read APIs remain linear in the
number of retained records. This is an in-process, nonpersistent sink.

## Focused execution

Six check groups passed against the complete production module: FIFO and reason
filtering through repeated wrap/clear/refill at capacities 0, 1, 3, 31 and 1,000;
array-copy and record-identity behavior; the default retention limit; explicit
invalid-capacity rejection; successful sync/async routing; and contained
sync/async sink failure. The original module separately passed the same
valid-capacity differential check. The routing implementation is unchanged.

Node v22.16.0, Linux x64, cloud host `0ddb4d7e4fa0`.
Node's native type stripping loaded the actual module; no substitute queue
implementation, package installation, network request, full TypeScript build,
Jest suite, database, contract, HTTP consumer, or live indexer was executed.
Earlier decoder validation remains tied to its own recorded source pins.

## Reproduce from the repository root

The standalone check requires Node 22 with native type stripping; it adds no
runtime dependency or package/script changes to the application.

```bash
# Focused behavior check only:
node --experimental-strip-types server/scripts/check-dead-letter-retention.mjs

# Matching before/after workload, using the original checked source:
git show b6697ec346b57433ddd8bdcef55efc0538702c60:server/src/services/eventDeadLetter.ts > /tmp/event-dlq-before.ts
node --experimental-strip-types server/scripts/check-dead-letter-retention.mjs \
  --baseline /tmp/event-dlq-before.ts --json /tmp/event-dlq-results.json
```

## Measured workload and limits

Each sample starts with a full queue, then inserts 200,000 preconstructed records.
Every 10,000 inserts it also calls `list()` and `byReason('UNSUPPORTED_VERSION')`.
Construction/prefill, final output comparison and hashing are outside the timed
region. Each implementation warms once per capacity; five measured pairs
alternate execution order. There is no performance threshold in the check.
Both implementations read the same records; all pairs matched returned row
counts and complete retained-record JSON hashes.

| Retained capacity | Original median wall ms | Replacement median wall ms | Ratio |
| --- | ---: | ---: | ---: |
| 1,000 | 24.544015 | 1.556109 | 15.77x |
| 10,000 | 393.117053 | 3.920486 | 100.27x |

These are local warmed queue observations, not application or chain throughput,
and they do not measure production event rates, memory savings, cold-start
latency, or concurrent producer behavior. Timing varies by host and runtime.

### Raw paired samples

CPU time is process user+system time, so incidental runtime work is included.

| Capacity | Pair | First | Before wall ms | After wall ms | Before CPU ms | After CPU ms |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1000 | 1 | before | 24.578424 | 1.556109 | 33.400 | 1.570 |
| 1000 | 2 | after | 24.544015 | 1.540949 | 24.672 | 1.559 |
| 1000 | 3 | before | 22.140473 | 1.570024 | 22.154 | 1.578 |
| 1000 | 4 | after | 28.414088 | 1.766715 | 28.506 | 1.773 |
| 1000 | 5 | before | 24.424076 | 1.519343 | 24.479 | 1.524 |
| 10000 | 1 | before | 393.117053 | 5.151740 | 393.260 | 5.171 |
| 10000 | 2 | after | 415.530849 | 3.786802 | 415.590 | 3.796 |
| 10000 | 3 | before | 596.188262 | 5.066764 | 596.241 | 5.109 |
| 10000 | 4 | after | 387.953513 | 3.920486 | 387.985 | 3.931 |
| 10000 | 5 | before | 373.504828 | 3.911812 | 373.641 | 3.929 |

### Source and output identities

- Baseline commit: `b6697ec346b57433ddd8bdcef55efc0538702c60`.
- Baseline Git blob: `28084cd1c4c8ff68352bf178ae328c1eac3021a9`.
- Replacement Git blob: `9a925c8df80d879b0a52b5d9a3e4ec70f2aa7983`.
- Baseline SHA-256: `6e05d5100c015a3f6d234128dc9c32739e51082caa6b634cc1a5411405da7ea5`.
- Replacement SHA-256: `95a681e9e2a6ee5c0631a06e3fd3d9422994ec638854dd603f80d5955a4683ed`.
- Capacity 1000: retained JSON SHA-256 `44455d7952f34f5167351a336d7f80c4d0c24c6acb715b119c5a1c7491aaa10b`; accumulated read rows `25000` in every original/replacement sample.
- Capacity 10000: retained JSON SHA-256 `3a504924443bb1fe0cf027a40b4ec5be21c0e863d1a3a57172d1d801373759f2`; accumulated read rows `250000` in every original/replacement sample.
