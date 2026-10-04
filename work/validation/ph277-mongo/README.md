# PH277 disposable Mongo comparison

This validation branch runs one source-pinned comparison of the original and
batched `aggregateSellerStatementFromDb`. It does not modify the submitted
product branch. The workflow adapts the existing PH263 public-fork fixture,
retaining Mongo 7.0.14, Node 24.19.0, Mongoose 9.9.2, Vitest 4.1.10 and Vite 8.3.2.

The recorded original service file is copied unchanged beside the candidate
module only inside the runner. Both modules import the same real models and fee
implementation. Git blob hashes in `source-pins.json` are verified before the
run. The test has no model/query mocks and retains the actual unique indexes.

The builder's synthetic fixtures cover 0, 100 and 1000 refunds plus mixed
prompt-case, repeated logical pair, historical purchase, and missing purchase
controls. The mixed-case legacy Fulfillment rows use validated raw insertion
to preserve stored casing; all other fixture documents use real Mongoose
models. Explicit BSON dates preserve the original historical/period split.

Only `crypto.randomUUID` and no-argument `Date` construction are controlled so
complete statements, signatures, CSV and JSON can be compared literally.
`Date.now`, monotonic timing, HMAC, Mongo operations and Mongoose remain real.
There is one untimed warmup per variant and three alternating-order paired
measurements for each representative size. Controls run once per variant.
Mongo command monitoring reports `find` and `getMore` separately, identifying
the unbounded-date historical purchase lookups and actual batch sizes.

Timings describe this synthetic local-service run, including command-monitoring
overhead. They are not production latency, concurrency or throughput claims.
The job log contains every paired timing, query count, source pin and statement
hash. Complete statement/CSV/JSON equality is asserted during execution. The
raw metrics and execution receipt are retained on the validation branch after
the run, without an uploaded artifact. The workflow only triggers when its own
file changes on the named branch; receipt-only updates do not queue another job.
