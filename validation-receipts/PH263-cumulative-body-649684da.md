## Summary

Closes #167.

Critical unlock outcomes await durable acceptance of redacted audit events before completing. Successful unlocks return `X-Audit-Acceptance-Id`; acceptance failures use the existing retryable 503 policy unless degraded mode is explicitly enabled. Acceptance and delivery to the append-only audit log are separate steps.

## Implemented behavior

- Critical success and denial paths await outbox acceptance. Non-critical events retain their existing best-effort helper.
- Duplicate acceptance returns the original acceptance ID. Wallet and IP values are hashed before persistence.
- Acceptance storage failures, including duplicate and backlog reads, use typed `AuditAcceptError` handling. Strict mode fails safely; explicit degraded mode records its counter and may complete without an ID.
- Drain failures retain the existing retry, exponential backoff and dead-letter behavior.

## Crash-recovery continuation

The original branch at `3d777ee8b45eeb4cb781a40cdf71acceabe58c4f` could permanently strand a claimed row in `draining`. A successful destination insert followed by acknowledgement failure could also consume the persistence retry budget and enter DLQ despite the event already being written.

This continuation adds atomic leases and claim-token fencing to both outbox stores. A later drain can reclaim an expired claim. Success, retry and DLQ transitions must match the current token, and a stale worker cannot alter another worker's claim or increment completion counters. The default lease is 30 seconds, configurable with `AUDIT_OUTBOX_LEASE_MS`.

Destination writes carry the acceptance ID and retain `AuditLog.create` with the existing immutable-record and hash-chain save middleware. A unique partial index prevents duplicate rows for that ID. A duplicate-key error counts as successful delivery only after the exact acceptance ID is found. A failed acknowledgement leaves the claim recoverable and does not consume persistence retries, including when `maxRetries=0`.

The existing operations guide describes these behaviors and their rollout limits. The f863e3f3 recovery continuation preserved the unlock handler, dependency manifests, hash-chain algorithm and request-triggered worker arrangement.

## Unlock test fixture restoration

Commit `649684da482c807ddc0a00fac52515c69fccd04a`, a child of `650ffcac644e57da6280705fb9739842917992b7`, restores 41 deleted lines in `api/prompts/unlock.test.ts`: the original webhook mock, handler import and `setupUnlockFixture` definition. Their deletion left the maintained suite unable to parse. The durable-queue mock and all 11 existing test bodies are preserved.

This restoration changes only the test file. The published queue, Mongo adapter, models, operations guide and production unlock handler retain their prior source.

## Delivery-key identity

Commit `b8c6f1556645d7d4539c567a65453feb8e472ef6` retains distinct delimiter-bearing critical events instead of returning another event's receipt. Ordinary delivery keys and lookup counts are unchanged. Matching legacy records preserve their acceptance ID; an ambiguous legacy key cannot substitute for a different stored payload. Existing lease, retry, backlog and destination-deduplication behavior is retained.

The complete production queue module on Node 22.16.0 passed seven focused cases at that source revision; the same cases on parent `649684da` had four passes and three failures. The selection covered distinct-event retention and drain, exact retries, legacy compatibility, saturation and lookup errors. This was not Mongo, HTTP, full-application or hosted-CI execution. [Source-bound evidence and rollout limits](https://github.com/woahwhattheheck/prompt-hash/blob/b8c6f1556645d7d4539c567a65453feb8e472ef6/docs/durable-audit-delivery-keys.md) are retained on the original branch. All accepting writers must be upgraded; older discarded events cannot be reconstructed by this change.

## Retry timing and server recovery

Current source: `3d38282b53830e978e44b8a9e70594f52f36e12b`, on the original contribution branch.

The retry-clock change at `a7bdbba49ae375e2e8085aca16ab89dbe80621a1` measures backoff after persistence rejects, so time spent awaiting a failed write does not consume its retry delay. That one-line change was source-reviewed; no separate test or build was run.

The following commit starts one audit recovery loop with the long-lived HTTP server. It reuses the existing Mongo connection helper and token-fenced drain, processes up to 50 due rows immediately, then waits one second after each completed call. Connection and drain failures leave polling active. SIGINT/SIGTERM stop new polls, close HTTP, await active requests and the current drain, then disconnect the shared Mongo connection. Existing request-triggered delivery remains.

One focused Node 24.19.0 check loaded the real worker and queue with an in-memory store, controlled timers/clock and controlled persistence. An initial connection failure and one failed write recovered a retained event across three polls and two writes. Maximum concurrent worker calls was one; stop waited for a held successful write and left no timer. This was not a Mongo, HTTP-shutdown, full-suite, build or deployed-restart execution.

The three published files read back exactly: worker `cd69ee8f8371ec5adc29577493d9a73e029687e8`, server `cab33ab4f44ccd926e6dbf434114f85983b32261`, guide `2560fe526d8736260e6100d21f953519c43c203f`. No deployment or new automation was created.

## Validation on 2026-10-04

### Queue and Mongo recovery

The following results belong to the recovery implementation published as `f863e3f33b4d35edd4a91395934c975cd29f58eb`. Its guide successor `650ffcac` records the hosted Mongo result. These queue and Mongo selections were not rerun on the fixture-only successor `649684da`.

- `npm run test:durable-audit -- --maxWorkers=1 --no-file-parallelism`: **25 passed, 3 live-Mongo cases skipped**, exit 0, total duration 1.02 seconds. Node 24.19.0 and Vitest 4.1.10.
- [Public-fork Mongo run 37186271164](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37186271164): **3 passed, 0 skipped**, Vitest duration 595 ms. The job checked out published source `f863e3f33b4d35edd4a91395934c975cd29f58eb` and selected only the three existing Mongo cases against a disposable MongoDB 7.0.14 service. Runtime: Node 24.19.0, Vitest 4.1.10, Mongoose 9.9.2 and Vite 8.3.2.
- Strict TypeScript 6.0.3 checking passed for the changed queue, adapter, models and test files. Prettier 3.8.3 and `git diff --check` passed.
- Controlled native comparison against the parent source reproduced an abandoned claim that remained `draining` with a later drain returning `idle`; the candidate drained the original acceptance ID after expiry.
- The same comparison reproduced a successful persistence callback followed by acknowledgement failure entering DLQ at zero retries; the candidate retained the recoverable claim with no retry or DLQ increment.
- The maintained cases cover stale success/retry/DLQ transitions, legacy claims, and the production destination adapter's duplicate-error and acknowledgement recovery paths. The cross-boundary tests live outside the server's Jest discovery tree and are selected by the dedicated Vitest configuration.

The 25 local cases use the real queue and production adapter with controlled database boundaries. Local MongoDB startup was blocked by the environment, so the same three opt-in database cases subsequently ran in the isolated public-fork job. Those cases awaited index initialization and verified real Mongo concurrent claiming, stale-token fencing, one immutable destination row after acknowledgement failure, and legacy-record compatibility. They created and removed a uniquely named test database. These injected interruption cases do not represent a killed application process or deployment restart. The validation workflow is outside the bounty PR branch.

### Maintained unlock suite at `649684da`

[Public-fork run 37188917329, job 111396773143](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37188917329/job/111396773143) checked out `649684da482c807ddc0a00fac52515c69fccd04a` and executed:

```bash
npm test -- api/prompts/unlock.test.ts --maxWorkers=1 --no-file-parallelism
```

**All 11 existing tests passed**, with 121 ms test execution and 885 ms total Vitest duration, using Node 24.19.0 and Vitest 4.1.10. The canonical test command, Vitest configuration, setup and tracked source were unchanged during execution; the final tracked diff was empty.

The run used real dependencies in a temporary prefix, with direct package versions pinned to this source's lockfile. This isolated install was necessary because the full root manifest and lockfile have pre-existing drift. The result establishes the maintained unlock selection, not a clean install or build of the full root dependency graph. The test's existing mocks remain in place; this run does not add live Mongo, Stellar or deployment coverage.

The combined job is red because its separate PH271 dependency-installation step failed before Jest. The PH263 unlock step succeeded and its log explicitly reports 11/11; the overall workflow status is not being presented as green. The validation workflow remains outside this bounty PR branch.

## Deployment and acceptance limits

- The destination unique index must exist. The adapter waits for model initialization when Mongoose manages indexes; installations with `autoIndex` disabled must provision it before draining.
- Older unfenced workers must finish or stop before relying on token fencing. Legacy destination records without an acceptance ID cannot be retroactively deduplicated after a historical insert-before-ack interruption; inspect those states before rollout.
- Lease expiry makes rows eligible for a later drain. The long-lived server now supplies a bounded recovery worker; serverless-only unlock hosting still needs that server process against the same outbox. Target deployment restart, HTTP shutdown and Mongo-operation timing remain unverified.
- Backpressure remains count-then-insert; metrics remain process-local. Concurrent hash-chain serialization is outside the issue's stated scope.
- These focused runs do not establish target deployment restart behavior, target index provisioning or full upstream CI. Maintainer acceptance remains pending. This remains the existing conditional-reward contribution; no new bounty claim or awarded-payment claim is made.
