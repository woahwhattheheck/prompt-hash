# PH277 real Mongo performance receipt

**One run passed.** The original and batched aggregation produced identical complete signed statements, CSV and JSON against the same synthetic Mongo data.

- [Successful run 37190015734](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37190015734), [job 111400056875](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37190015734/job/111400056875).
- [Measured harness c196cd0b](https://github.com/woahwhattheheck/prompt-hash/tree/c196cd0b81d1dfe0dff108176d6b659ffebad8c8/work/validation/ph277-mongo).
- Baseline: `a9c7d579d5737456ec96064ea9a2796f56834bcf`, service blob `b41e983f78d79080acdded85b185b42fecb0c5c1`.
- Published candidate: `6b0b8f70c18be2b89c6e7691f07983883dd389a7`, service blob `3d249b8648de4e52dc4512ceca8bed85bd445ee5`.
- [Raw structured measurements](metrics.json), [timestamped measurement log excerpt](measurement.log), [exact file pins](source-pins.json).

## Measured results

The representative sizes each used one untimed warmup per variant followed by three paired measurements with alternating execution order. The table reports the median of each variant's three samples.

| Refund rows | Historical Purchase finds before | After | All find commands before | After | Median before (ms) | After (ms) | Ratio of medians |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 100 | 1 | 104 | 5 | 74.359647 | 10.625831 | 6.998× |
| 1000 | 1000 | 10 | 1004 | 14 | 535.698841 | 58.441158 | 9.166× |

At 1000 rows both variants also issued two `getMore` commands. Those cursor reads are recorded separately rather than hidden in the `find` counts. Each batch contained 100 exact prompt/buyer pairs.

### Every measured timing

| Refund rows | Pair | Execution order | Before (ms) | After (ms) |
| ---: | ---: | --- | ---: | ---: |
| 100 | 1 | Before, after | 83.674508 | 10.625831 |
| 100 | 2 | After, before | 74.359647 | 11.490799 |
| 100 | 3 | Before, after | 71.915354 | 10.324641 |
| 1000 | 1 | Before, after | 538.404314 | 59.558183 |
| 1000 | 2 | After, before | 535.698841 | 58.441158 |
| 1000 | 3 | Before, after | 517.818571 | 54.937098 |

The empty control retained four `find` commands and no historical purchase lookup in both variants. The mixed control retained five refund rows over four logical pairs, with total `find` commands reduced from nine to five. Its duplicate logical pair, distinct prompt casing, uppercase legacy buyer, missing-purchase fallback and historical clawbacks all passed. Control timings remain in the raw JSON but are not treated as representative performance estimates.

## What was executed

[The runnable test](https://github.com/woahwhattheheck/prompt-hash/blob/c196cd0b81d1dfe0dff108176d6b659ffebad8c8/tests/ph277-mongo-performance.test.mjs) imports complete original service bytes and the published candidate, sharing the real unchanged Purchase, FulfillmentRecord, Prompt, User and fee modules. The original service is copied beside the candidate during preparation so imports resolve to the same model instances. Source hashes are checked before execution.

MongoDB 7.0.14 ran as a disposable service on the public Ubuntu 24.04 runner. Runtime versions were Node 24.19.0, Mongoose 9.9.2, Vitest 4.1.10 and Vite 8.3.2. The actual Purchase and FulfillmentRecord unique compound indexes stayed enabled. Ordinary fixtures passed through real Mongoose models. The two uppercase mixed-fixture rows used validated raw insertion to retain legacy stored casing and BSON dates.

Only `crypto.randomUUID` and no-argument `Date` construction were controlled for deterministic generated metadata. `Date.now`, monotonic timing, database operations, model casting and HMAC signing stayed real. Complete statement objects, signatures, CSV and JSON were compared on every pair; no result fields were excluded.

Mongo driver command monitoring counted actual wire operations. Timing covered the actual `aggregateSellerStatementFromDb` call, including database reads, reconciliation and command-monitoring overhead. No query/model mock or canned database response was used.

## Resource cost and interpretation

The single job completed successfully from 08:46:40 to 08:47:18 UTC on 2026-10-04: **38 seconds** including container and dependency setup. Vitest reported one benchmark test/file passed in **3.88 seconds** overall, with **3.43 seconds** in the test. Measured worker peak RSS was **189157376 bytes**; this excludes the Mongo service and setup processes. The disposable service was stopped and removed after the run.

These are synthetic same-host, warmed-service measurements from one job. They demonstrate fewer real queries and lower aggregation time for these fixtures; they do not establish production latency, concurrent throughput or an SLA. There was no full project suite, deployment, paid runner, secret access, repeated run or artifact upload.

The [pinned workflow](https://github.com/woahwhattheheck/prompt-hash/blob/c196cd0b81d1dfe0dff108176d6b659ffebad8c8/.github/workflows/ph277-mongo-once.yml) records the complete source verification, baseline preparation, dependency versions and execution command. This receipt-only successor does not alter any measured source, model, harness or workflow bytes.
