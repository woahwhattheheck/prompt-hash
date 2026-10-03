# Event versioning

How PromptHash contract event consumers stay compatible when on-chain event
shapes evolve.

Issue: [#246](https://github.com/Prompt-Hash-Stellar/prompt-hash/issues/246)

## Lifecycle ↔ contract events

Consumer-facing **lifecycle** names map to the real Soroban events defined in
`contracts/prompt-hash/src/events.rs`:

| Lifecycle  | Contract event    | Meaning                                     |
| ---------- | ----------------- | ------------------------------------------- |
| `publish`  | `PromptCreated`   | Listing published / created on-chain        |
| `purchase` | `PromptPurchased` | Buyer purchased a license                   |
| `unlock`   | `EscrowReleased`  | Escrow funds released (post-dispute unlock) |

There is **no** `PromptUnlocked` event in the current contract. Unlock
consumers must subscribe to `EscrowReleased`.

## Schema lifecycle

Event **schema versions** live on the consumer envelope (fixtures / indexer
input), not as a field inside every Soroban topic today. Supported versions:

| Version | Status    | Notes                                                                                             |
| ------- | --------- | ------------------------------------------------------------------------------------------------- |
| `1`     | Supported | Exact field set from `events.rs` for publish / purchase / unlock                                  |
| `2`     | Supported | Additive optional fields only (`content_hash`, `metadata_uri`, `license_id`, `release_reason`, …) |
| other   | Rejected  | Routed to the dead-letter queue (DLQ) — never crashes the consumer                                |

### Upgrade steps (adding schema `N+1`)

1. **Design** — document additive vs breaking changes. Prefer additive optional
   fields so older indexers can keep reading `N` while `N+1` rolls out.
2. **Fixtures** — add `server/tests/fixtures/events/{publish,purchase,unlock}.v{N+1}.json`
   with an `expected` canonical block. Update `manifest.json`.
3. **Decoder** — append `N+1` to `SUPPORTED_SCHEMA_VERSIONS` in
   `server/src/services/eventDecoder.ts`. Keep required-field checks for the
   lifecycle; optional keys are projected in sorted order for determinism.
4. **Tests** — extend `server/src/tests/eventDecoder.test.ts` so the new
   fixtures decode twice to the same canonical JSON, and keep at least one
   unsupported-version DLQ case (e.g. `v99`).
5. **Roll out** — deploy indexer build that understands `N+1` **before** any
   producer starts emitting `N+1` envelopes in production.
6. **Deprecate** — after all live consumers support `N+1`, mark `N` deprecated
   in this doc. Remove `N` from `SUPPORTED_SCHEMA_VERSIONS` only after a
   quarantine window and a DLQ triage that shows zero remaining `N` traffic
   (or after a deliberate cutover with reindex).

### Deprecation policy

- Overlap window: keep at least one prior schema version supported during
  upgrades.
- Removal requires: updated fixtures, green decoder tests, and an ops note in
  the PR that removes the version.
- Breaking contract changes (renamed/removed required fields) require a new
  schema version — do not silently reinterpret old payloads.

## Dead-letter (DLQ) triage

Decoder entrypoint: `decodeEvent()` in `server/src/services/eventDecoder.ts`.

| Reason                     | When                                              | Action                                                              |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| `UNSUPPORTED_VERSION`      | `schemaVersion` not in supported set              | Hold; ship decoder support or backfill rewrite                      |
| `UNKNOWN_EVENT_TYPE`       | lifecycle / contract event not mapped             | Confirm event name against `events.rs`; ignore noise or add mapping |
| `SCHEMA_VALIDATION_FAILED` | Supported version but missing required fields     | Inspect producer / RPC decoding bugs                                |
| `CORRUPT_PAYLOAD`          | Envelope not an object / bad `schemaVersion` type | Drop or repair upstream serialization                               |

In-process sink: `InMemoryEventDeadLetter` + `routeToDeadLetter()` in
`server/src/services/eventDeadLetter.ts`. The routing helper logs synchronous
sink errors and rejected persistence promises without interrupting the indexer
loop. Routing still returns immediately; it does not confirm durable storage
completion or retry a failed write. Persist to durable storage later by
implementing `EventDeadLetterSink`.

Event-name diagnostics preserve primitive labels and describe nonprimitive
values by type without invoking their conversion methods. For example, parsed
JSON with `contractEvent: {"toString": null}` remains an `UNKNOWN_EVENT_TYPE`
failure and can reach the sink. The original envelope stays in `raw`; the
dead-letter `contractEvent` and `lifecycle` metadata remain strings or null.
This also applies to failures returned before event-name resolution, such as
unsupported versions and corrupt schema-version values. Existing valid
lifecycle precedence and contract-event fallback remain available.

## Fixtures & tests

- Fixtures: `server/tests/fixtures/events/`
- Decoder tests (Jest): `server/src/tests/eventDecoder.test.ts`

```bash
cd server && npm test -- --testPathPatterns=eventDecoder
```

Supported fixtures must decode deterministically (identical canonical JSON on
repeated runs). Unsupported fixtures must return `{ ok: false, deadLetter }`
without throwing.

## Related code

- Contract events: `contracts/prompt-hash/src/events.rs`
- Live indexer switch (topic routing): `server/src/services/indexer.ts`
- Pipeline quarantine hook: `server/src/services/indexerPipeline.ts` (`quarantine`)

## Malformed event-name continuation

The continuation from `4507ff9b0e4865b8851c5a43f207b1c4f4ad6dbc` on PR #276
repairs a failure before dead-letter routing. Ordinary parsed JSON could
provide an object with a non-callable `toString` as either event-name field.
The unknown-event diagnostic attempted to convert that object to a string,
throwing `TypeError: Cannot convert object to primitive value`. An array
containing the same object triggered the same failure.

The decoder now formats those diagnostics without object coercion and keeps
non-string event names out of the string/null dead-letter metadata. Original
raw objects, error classifications and controlled receive times are retained.
The earlier own-key map protection and asynchronous sink handling remain
unchanged. No fixture, contract, schema-version or dependency change is needed.

### Regression and native consumer evidence

The maintained decoder suite passes **45 tests**. The same final selection
against the preceding decoder produces **8 failures and 37 passes**. Ten new
cases cover both event-name fields with object/array values, metadata on the
unsupported-version and corrupt-schema paths, valid contract-event fallback,
and valid lifecycle precedence. All 35 earlier fixture, determinism, map and
synchronous/asynchronous sink cases remain present and pass.

Eight actual Node 24.19.0 consumer processes exercised the source decoder and
in-memory sink before and after the repair:

| Input                                                                                     | Preceding source                                | Repaired source                                             |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Object/array containing `toString: null` in either unresolved name field (four processes) | Exit 1 before consumer continuation             | Exit 0; one `UNKNOWN_EVENT_TYPE` record; consumer continues |
| Unknown string name                                                                       | Exit 0; one unknown-event record                | Same behavior and diagnostic                                |
| Unsupported version with object-valued contract event                                     | Exit 0; metadata incorrectly contains an object | Exit 0; metadata is null; original object retained in `raw` |
| Valid contract fallback with malformed lifecycle                                          | Successful canonical publish event              | Identical canonical event                                   |
| Valid lifecycle with malformed contract event                                             | Successful canonical purchase event             | Identical canonical event                                   |

All repaired failure records retained the original raw-object identity and
the supplied receive time. Valid controls did not enter the sink. No getters,
proxies or executable input properties were needed for these reproductions.

This compact reproduction runs from the repository root with Node 24:

```js
// Save as an .mjs file at the repository root, then run node <file>.mjs.
import { setImmediate as nextTurn } from "node:timers/promises";
import { decodeEvent } from "./server/src/services/eventDecoder.ts";
import {
  InMemoryEventDeadLetter,
  routeToDeadLetter,
} from "./server/src/services/eventDeadLetter.ts";

const raw = JSON.parse('{"schemaVersion":1,"contractEvent":{"toString":null}}');
const sink = new InMemoryEventDeadLetter();
const result = decodeEvent(raw, { now: new Date("2026-10-03T15:00:00.000Z") });
if (result.ok) throw new Error("Expected a malformed-event failure");
routeToDeadLetter(result.deadLetter, sink);
await nextTurn();
console.log(
  JSON.stringify({
    reason: sink.list()[0].reason,
    size: sink.size(),
    rawSame: sink.list()[0].raw === raw,
    continued: true,
  }),
);
```

The preceding source exits at `decodeEvent`. The repair prints
`{"reason":"UNKNOWN_EVENT_TYPE","size":1,"rawSame":true,"continued":true}`.

### Checks and limits

The maintained command is
`npm test -- --testPathPatterns=eventDecoder --runInBand --no-cache` from
`server`. The strict TypeScript check follows imports from the decoder and
its regression file:

```sh
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict \
  --target ES2022 --module Node16 --moduleResolution Node16 \
  --esModuleInterop --skipLibCheck --types jest,node \
  src/services/eventDecoder.ts src/tests/eventDecoder.test.ts
```

Scoped project ESLint passes with no source errors or warnings; Node still
reports the existing module-type warning for the ESLint configuration.

Validation reuses Jest 30.2.0, ts-jest 29.4.12 with its retained TypeScript 5.9.3,
standalone TypeScript 6.0.3, ESLint 10.8.1,
typescript-eslint 8.67.0, globals 17.5.0, Jest types 29.5.14, Node types 25.3.0
and Prettier 3.8.1. These retained tools are not an exact locked installation;
dependency files are unchanged. The previous runtime-version limitations
remain applicable.

Prettier passes the changed tests and documentation. The full decoder file
continues to report pre-existing formatting differences, reproduced on the
exact preceding source; unrelated formatting was left out of this repair.
The source diff passes whitespace checks.

These runs establish local decoder-to-sink behavior. They do not establish
durable queue persistence, live indexer/RPC behavior, frontend execution or a
full server build/suite. The earlier recorded broader validation and its two
baseline webhook-auth failures were not rerun for this continuation. Hosted
workflow approval and maintainer acceptance remain pending.
