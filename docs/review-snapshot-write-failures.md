# Review storage failure recovery

The file repository now removes its own temporary snapshot when a write or
atomic rename fails. Cleanup runs only on the failure path and is best-effort:
a cleanup failure does not replace the original storage error. The successful
write/rename path, snapshot format, path lock, and review policies are unchanged.
This does not sweep old temporary files, reclaim locks, or promise cleanup after
a process crash or when the filesystem itself refuses removal.

## Executed checks — 4 October 2026

Complete production `fileReviewRepository.ts`, `pathLock.ts`, and `reviewTypes.ts`
modules were executed on Linux with Node 22.16.0 after TypeScript 5.8.3
transpilation. Filesystem operations and locking were real; no filesystem,
repository, or lock implementations were substituted.

| Failure exercise | Before | After |
| --- | --- | --- |
| Two `clear()` calls whose destination is an existing directory | Both return `EISDIR`; two orphan snapshots remain | Same errors; zero orphan snapshots |
| Two oversized `addReview()` writes with a child-process `RLIMIT_FSIZE` of 1,024 bytes | Both return `EFBIG`; two partial snapshots totaling 2,048 bytes remain | Same errors; zero partial snapshots |

The partial-write exercise starts with a valid existing snapshot and 10,000
characters of review text. The child ignores `SIGXFSZ` so the actual filesystem
error reaches the promise rejection instead of terminating the process. Only
that child has the file-size limit.

Both exercises also verified that an unrelated neighboring temporary file was
preserved and the operation's lock was released. The partial-write exercise
verified that the original snapshot bytes were unchanged. After removing the
directory obstacle or child-only size limit, a normal review write succeeded;
reopening the repository returned the persisted review.

Source before: commit `7d53194b76e428f533494dc88d5e17a31ae94807`, repository blob
`889552299882bb2b9828c3793b3078b9761ad8ab`.
Source after: commit `722d3a4f7d49543d57ab1f9d378b6841bad33121`, repository blob
`ca0a784a5efca8abf0e1909f9f59328fe601ef2a`.
The unchanged lock/type blobs were `9ab7d5a9cdd19e41ce622d4a898ba87516ce3e0f`
and `0da047ce07ae967594353a166aab1799c07f1f16`, respectively.

These are focused filesystem failure/recovery results, not a newly executed
full typecheck, complete durable-review suite, MongoDB, HTTP, CI, or
power-loss durability result. No new test suite or runtime dependency was added.

## Repository initialization recovery

`getReviewRepository()` previously retained its first rejected initialization
promise forever, even though the database connector clears its own failed
connection attempt. It now evicts only the failed promise that is still current.
A later request may retry; there is no automatic retry loop. Pending callers
still share one construction, and a retired rejection cannot evict a replacement.

Three direct complete-`reviewStore.ts` execution scenarios used the same Node
and TypeScript versions, with controlled database-initializer/model/factory
collaborators (not a live MongoDB integration). Failure-then-recovery failed on
baseline blob `40806adaf4fd2a0aab069a4117aa75da16ab48fd` and passed on repaired
blob `4c324ac24b223af670252f1043459883ae0f77f3`, committed at
`12fa154e3cef8ef57f396073a76c5b1c96f586c0`. Two concurrent callers retained one
initialization/factory result, and a late rejection after repository reset did
not clear the newer in-flight initialization. Both controls passed before and
after; the original rejection object was preserved. Mongo query behavior and
configuration loading are unchanged. No live database availability or deployment
result is asserted.
