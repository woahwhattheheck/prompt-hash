# Native decoder acceptance — October 4, 2026

## Reconciled expectations

The maintained decoder test file still treated empty-string and boolean-false
`prompt_id` values as valid after the decoder had adopted exact contract-integer
admission. This change updates those two expectations to require
`SCHEMA_VALIDATION_FAILED`, the `prompt_id` field name, and the unchanged raw
envelope. The existing zero-number and bigint controls remain successful.
All four parameter cases remain; no test is removed or skipped. No production
module, fixture, dependency, or Jest configuration changed in this follow-up.

Test publication: `4108b479f4d6147b18bf60181a4337419515552e`.

## Actual execution

[Run 37200309005](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37200309005),
job `111430464047`, succeeded. Its isolated controller commit is
`6bce909dfcb9a537e74ad7a56d7a3ad8856fad98`; the controller branch is not product
source and is not intended for merging.

The job explicitly checked out product
`a0f8305b4e7335014cab9ddcb9580a6fcb58dce6`, installed that source's unchanged
locked server dependencies with `npm ci --no-audit --no-fund`, and ran the
repository's actual Jest file and configuration before and after the exact
expectation patch. The production checkout includes the preceding integer,
canonical-referrer, and circular-retention changes.

Environment recorded by the job: Linux GitHub-hosted runner, Node `v24.21.0`,
npm `11.19.0`. Dependency installation used the network; this is not an offline
or network-denial experiment. No live chain, database, HTTP consumer, or
provider-acceptance result is claimed.

| Maintained selection | Passed | Failed | Pending | Total | Process exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original expectations | 70 | 2 | 0 | 72 | 1 |
| Reconciled expectations | 72 | 0 | 0 | 72 | 0 |

The two original failures were exactly:

```text
unsupported versions fail safely (dead-letter) required prompt_id preserves empty string normalization
unsupported versions fail safely (dead-letter) required prompt_id preserves false boolean normalization
```

Repaired native Jest summary:

```text
Test Suites: 1 passed, 1 total
Tests:       72 passed, 72 total
Snapshots:   0 total
Time:        0.34 s, estimated 1 s
Ran all test suites within paths "src/tests/eventDecoder.test.ts".
```

This is one complete maintained test file, not the full server suite or a
production TypeScript build. Its count overlaps prior decoder checks and must
not be added to those counts. The earlier local retention benchmark remains a
separate workload; this run does not repeat or replace its timing observations.

## Reproduce

From the reconciled repository's `server/` directory:

```bash
npm ci --no-audit --no-fund
./node_modules/.bin/jest --runTestsByPath src/tests/eventDecoder.test.ts \
  --runInBand --json --outputFile=/tmp/event-decoder-result.json
```

The original source pin above reproduces the two stale expectations with the
same command. The validation controller retains the exact before/after patch,
source pin, normal command lines, and result assertions. Its repository
permission is read-only; publication used the original contribution branch.

## Source and retained evidence

- Original test Git blob: `cd89ac9b0e5a52d24073f8a5b1778c91803b050f`.
- Executed/published test Git blob: `1ffea00041aaf241d737620e690d01e4a38dba8e`.
- Artifact: [11302292690](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37200309005/artifacts/11302292690), `ph276-integer-expectations-evidence`.
- Downloaded ZIP: 17,855 bytes, SHA-256 `8f3aee981c5ccfdb5cd2ac03ff6ed868769794a0b39cf6c9051c5126c78187e2`.
- ZIP contents include both complete test files, the exact patch, before/after Jest JSON and logs, exit codes, dependency-install output, source/environment records, and the 70/2-to-72/0 summary. The downloaded ZIP digest and both source blob IDs were independently recomputed before publication.

The artifact uses seven-day retention. The source change, command, result
summary, identities and limitations above remain committed with the original
issue #246 / PR #276 contribution. Sponsor acceptance and any campaign award
are separate from this execution result.
