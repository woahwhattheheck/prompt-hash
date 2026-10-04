# Contract integer decoding

The existing versioned decoder now validates the integer types already declared in `contracts/prompt-hash/src/events.rs`: `prompt_id` is `u64`; required `price_stroops` is `i128`. This continues PR #276 without changing contracts, schema versions, lifecycle mapping, or optional fields.

A required integer may be a safe integral JavaScript Number, an in-range bigint, or a decimal integer string. Booleans, empty strings, whitespace, decimal fractions, exponent/hex strings and values outside the corresponding contract range produce the existing `SCHEMA_VALIDATION_FAILED` dead letter. This preserves the prior rejection of imprecise Numbers. No raw value is added to the error message.

Exact valid string bytes, including leading zeros, remain unchanged in the canonical projection. Leading zeros are removed only from the temporary range-check input; BigInt parsing is bounded to 39 significant digits. Both signed 128-bit endpoints remain valid. This is representation/type validation, not a new positive-price business rule or address validator.

## Focused execution

Source parent: `f261979a679ea95feb2dad877596562adb6ab6a4`, decoder blob `cc71cb23037152a1fee5667afce9e36c55c76113`.

The complete exported decoder and `eventDecoder.integerRanges.test.ts` ran under Node 22.16.0 with TypeScript 5.8.3 transpilation. Only test registration used `node:test` instead of Jest; production code, Node assertions, and constructed envelopes were unchanged. Before: 2 passed, 3 failed. After: 5 passed, 0 failed, with no skipped cases. Six full valid-event outputs across the two supported versions and three lifecycle names were byte-identical before/after.

The regression covers malformed scalars, u64/i128 boundaries, long decimal input, preserved address casing/optional fields, deterministic projection, and unsupported-version routing. No live chain, indexer, database, package-wide suite, or production build was run.

For the normal configured checkout:

```sh
cd server
npm test -- --testPathPatterns=eventDecoder.integerRanges
```
