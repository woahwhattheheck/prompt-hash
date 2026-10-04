# Durable reviews (#179)

Review submission, reports, and moderation no longer use a process-local seeded `Map`. Persistence goes through a durable repository so data survives restart and stays consistent across replicas.

## Backends

| Backend                | When              | Notes                                                                                                             |
| ---------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Mongo (`Review` model) | `MONGODB_URI` set | Unique index on `(promptId, userAddress)`; atomic report/moderate updates                                         |
| File store             | otherwise / tests | JSON file at `REVIEW_STORE_PATH` (default: OS temp `prompt-hash-reviews/reviews.json`); path lock + atomic rename |

## Guarantees

- **Durability:** reviews reload after process restart.
- **Uniqueness:** concurrent duplicate `(promptId, wallet)` submits create **exactly one** review (`DuplicateReviewError` / HTTP 409 / Mongo `E11000`).
- **Atomic transitions:** report appends only if the reporter is new; moderation applies in one update.
- **Moderation preservation:** new reports on a hidden review are recorded without
  making it public. Only explicit `unhide` or `dismiss_reports` moderation restores
  visibility. Mongo resolves the current status and appends the report in one
  atomic update pipeline; report payloads remain literal data.
- **No production seed:** fictional `review_1`…`review_3` rows are never inserted on boot. Migration `003_durable_reviews_remove_seeds.ts` deletes leftovers and backfills `status` / `reports` / `reviewId`.

## File-store recovery

A missing file initializes an empty version-1 snapshot. An existing snapshot must
have `version: 1` and a `reviews` array; incompatible envelopes and invalid JSON
reject reads and mutations, including seed cleanup, without changing the stored
bytes. Restore a compatible snapshot before retrying. The explicit `clear()`
test/reset operation still replaces the snapshot intentionally.

## Local process coordination

The file backend uses an exclusive `reviews.json.lock` sidecar next to the
configured snapshot. Every participating process must use the same resolved
`REVIEW_STORE_PATH` and this locking implementation. The lock covers the existing
snapshot read and, for mutations, the update and atomic replacement. Operations on
different store paths proceed independently.

Lock acquisition has a five-second contention deadline and raises
`ReviewStoreLockTimeoutError` when it expires. A timed-out operation does not invoke its callback
or modify the snapshot. Other filesystem failures propagate normally. Successful
and failed operations release their lock; cleanup verifies the open file's
identity before removing the sidecar, so a replacement owner's lock remains in
place. If both the operation and cleanup fail, the returned `AggregateError`
retains both errors.

The sidecar contains a version, owner PID and creation time for diagnosis. These
fields are not a lease: an old timestamp, a paused owner or a PID lookup never
causes automatic takeover. If a process exits before cleanup, its sidecar can
remain and later calls fail with the bounded timeout.

For recovery, stop competing file-store workers and confirm the recorded owner
has stopped. Then remove only the leftover `.lock` sidecar and restart the
workers. Preserve the review snapshot. Never remove or replace a live owner's
lock. Stop writers before manually restoring an incompatible snapshot as well.

Production continues to use Mongo when `MONGODB_URI` is configured. The original
file-coordination measurements used local Node processes on one local filesystem.
Network filesystems, mixed old/new workers and different path aliases were not
validated.

## Prior file-coordination verification

At `f871a5d44c4e8d3a665fae73c2cfe2f933ce056c`, the maintained
`npm run test:durable-reviews` suite passed **31/31** across its three configured
files. These are retained results for that revision; the complete suite was not
rerun for the hidden-review continuation below. It preserves the previous 22 checks, including public
and legacy Mongo-ID casting, incompatible-envelope byte preservation, API
workflow and report-logging privacy. Nine new checks cover cross-process writes,
duplicate outcomes, report appends, timeout, ownership and cleanup failures, and
independent store paths. With the unchanged parent locking module and the same
tests, **eight fail and 23 pass**.

Native Node 24.19.0 execution imported the actual repository in two ordinary
child processes, with real filesystem operations and no snapshot interception.
The original and corrected runs used the same inputs:

| Scenario                                             | Original result                                            | Corrected result                                                |
| ---------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Two processes submit eight distinct reviews          | Eight successful returns; four persisted                   | Eight successful returns; eight persisted                       |
| Two processes submit the same prompt/wallet          | Two successful returns with different IDs; one overwritten | One success and one duplicate error; the accepted ID persists   |
| Two processes append eight distinct reports          | Eight successful returns; four reports persisted           | Eight successful returns; eight reports and count eight persist |
| Two instances in one process submit distinct reviews | Both accepted reviews persist                              | Both accepted reviews persist                                   |

Scoped ESLint and Prettier checks pass. Strict TypeScript passes the production
file-repository dependency graph with Node types and the ES2022 library under a
128 MiB heap cap. This is not a complete application or test-file typecheck.

Validation reused Vitest 4.1.10, TypeScript 6.0.3, Mongoose 9.10.4, ESLint 10.8.1,
Prettier 3.8.1 and Node type definitions 25.3.0. The 19-package Mongoose dependency
closure was restored from the existing SHA512-verified cache, then removed after
checking. No download or package-manager installation was performed. The
unchanged lock records Mongoose 9.7.3, ESLint 10.6.0, Prettier 3.8.3 and Node types
25.9.4, so this was not an exact locked installation. The manifest's Mongoose
`^9.9.2` range includes the tested 9.10.4.

## Hidden-review report validation (October 4, 2026)

A report previously changed every review to `flagged`, including one explicitly
hidden by a moderator. Since the public reader excludes only `hidden`, a new
report could make the review public again. Both backends now record the report
while preserving a stored `hidden` status. Mongo resolves the status, report append
and count in the same update; `$literal` prevents report text from being interpreted
as an aggregation expression.

The actual file repository was imported with Node 24.19.0 and real filesystem
operations. Add → hide → report → reload produced `flagged` and one public row
on the parent, versus `hidden` and zero public rows with the repair. Both retained
one report and the exact reason `"$status is literal"`.

A separate, single standard Ubuntu job executed the actual Mongo repository,
public facade and production Review model against MongoDB 8.0.32, using Node
24.21.0 and Mongoose 9.10.4. It verified all six imported production source blobs
before execution. The unchanged parent was
`f871a5d44c4e8d3a665fae73c2cfe2f933ce056c`; the source candidate was
`5d42259ff0465e4f6178fb67739c0451877fd46d`.

| Mongo scenario | Parent | Repair |
| --- | --- | --- |
| Visible report flags review and preserves literal text | Pass | Pass |
| Hidden review receives a new report | Fail | Pass |
| Hidden review receives concurrent duplicate and new reports | Fail | Pass |
| Concurrent hide/report, hide completes first | Fail | Pass |
| Concurrent hide/report, report completes first | Pass | Pass |
| Explicit unhide restores public visibility | Pass | Pass |
| Total | 3 pass / 3 fail | 6 pass / 0 fail |

The ordered scenarios put a promise barrier immediately before the real model
update; both repository calls reached that boundary before selecting the order.
Database calls, update payloads and returned documents were not simulated.
The duplicate/new-report case used concurrent requests without that barrier.
Checks also covered normalized reporter addresses, exact report counts, literal
reason text, BSON report dates and the model's `_id: false` report subdocuments.

[Execution run 37202755182](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37202755182),
[scenario artifact 11303711128](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37202755182/artifacts/11303711128)
and the
[reproducible runner](https://github.com/woahwhattheheck/prompt-hash/blob/315f0810861ed3d34c68be82bbdadd8f276065df/scripts/review-moderation-mongo-acceptance.mjs)
retain the evidence. Execution-only workflow and runner files remain on the
separate verification branch.

The existing reporting/moderation test now includes hidden-report persistence,
duplicate rejection and explicit unhide, without adding a new test case. That
extended Vitest case, lint, formatting, full typecheck and application build were
not run in this continuation after the shared command runner disconnected.
The Mongo job used an isolated Mongoose installation, not the complete lockfile
environment. It establishes these repository behaviors, not live HTTP, replica
failover, deployment throughput or sponsor acceptance.

## Public API

`api/reviews/{submit,list,report,moderate}` await the repository. Public list excludes `hidden` and strips report payloads.

## Env

| Variable            | Default  | Meaning                             |
| ------------------- | -------- | ----------------------------------- |
| `MONGODB_URI`       | unset    | Prefer Mongo repository when set    |
| `REVIEW_STORE_PATH` | temp dir | File-store path when Mongo is unset |

## Migration

```bash
MONGODB_URI=... npx ts-node server/src/db/migrations/003_durable_reviews_remove_seeds.ts
```

## Non-goals

Reputation weighting changes.
