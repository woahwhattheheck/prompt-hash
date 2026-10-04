# Canonical purchase referrer ordering

The purchase decoder normalizes an absent optional `referrer` to `null`.
Previously it added that default after sorting optional fields. An envelope
with an omitted referrer and `z_receipt` therefore serialized fields as
`..., z_receipt, referrer`, while the equivalent explicit-null envelope
serialized as `..., referrer, z_receipt`.

Normalize the default on the copied payload before the existing optional-key
sort. Required-field order, field values, topic precedence, integer validation,
address spelling and schema versions remain unchanged. Caller objects are not
mutated. The changed canonical JSON is limited to purchases with an omitted
referrer and an optional field ordered after it. Consumers comparing persisted
canonical strings for those events should re-decode their retained envelopes;
there is no contract or on-chain event change.

## Reproduction

From `server/`, using Node 22.16.0:

```sh
node --experimental-strip-types --test tests/event-canonical-referrer.cjs
```

The check imports the complete production TypeScript module directly, without
replacement decoder logic, mock dependencies, network calls or a generated
build. It covers both supported versions, absent/null/undefined equivalence,
shuffled field insertion, sorted additive fields, non-null referrer spelling,
topic precedence and frozen caller objects.

Observed on 2026-10-04:

| Source | Passed | Failed | Exit |
| --- | ---: | ---: | ---: |
| `b6697ec346b57433ddd8bdcef55efc0538702c60` | 2 | 2 | 1 |
| Same source plus this default-order change | 4 | 0 | 0 |

Both original failures are canonical JSON byte mismatches, one per supported
schema version. Both non-null/topic-precedence controls already pass before
the repair. No tests are skipped.

Executed source Git blobs:

- Original decoder: `806b439d8ae2925026833bc36eb4e760b3f6f553`
- Repaired decoder: `bae1d2d215642a93b25c59b976b8e996baa071b1`
- Identical before/after check: `8aa98feabcb2fe658ec07d6c0ed9e7c5f98f1f26`

The repaired standalone module also passes TypeScript 5.8.3:

```sh
tsc --strict --target ES2020 --module commonjs --noEmit src/services/eventDecoder.ts
```

This is focused native-module execution, not the full Jest suite, server build,
live indexer, RPC or on-chain validation. Existing fixtures and other maintained
regressions are unchanged. This continues the existing issue #246 / PR #276
contribution; it does not establish campaign acceptance or a monetary award.
