# Event versioning

How PromptHash contract event consumers stay compatible when on-chain event
shapes evolve.

Issue: [#246](https://github.com/Prompt-Hash-Stellar/prompt-hash/issues/246)

## Lifecycle ↔ contract events

Consumer-facing **lifecycle** names map to the real Soroban events defined in
`contracts/prompt-hash/src/events.rs`:

| Lifecycle | Contract event   | Meaning                                      |
|-----------|------------------|----------------------------------------------|
| `publish` | `PromptCreated`  | Listing published / created on-chain         |
| `purchase`| `PromptPurchased`| Buyer purchased a license                    |
| `unlock`  | `EscrowReleased` | Escrow funds released (post-dispute unlock)  |

There is **no** `PromptUnlocked` event in the current contract. Unlock
consumers must subscribe to `EscrowReleased`.

## Schema lifecycle

Event **schema versions** live on the consumer envelope (fixtures / indexer
input), not as a field inside every Soroban topic today. Supported versions:

| Version | Status    | Notes |
|---------|-----------|-------|
| `1`     | Supported | Exact field set from `events.rs` for publish / purchase / unlock |
| `2`     | Supported | Additive optional fields only (`content_hash`, `metadata_uri`, `license_id`, `release_reason`, …) |
| other   | Rejected  | Routed to the dead-letter queue (DLQ) — never crashes the consumer |

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

| Reason                     | When                                              | Action |
|----------------------------|---------------------------------------------------|--------|
| `UNSUPPORTED_VERSION`      | `schemaVersion` not in supported set              | Hold; ship decoder support or backfill rewrite |
| `UNKNOWN_EVENT_TYPE`       | lifecycle / contract event not mapped             | Confirm event name against `events.rs`; ignore noise or add mapping |
| `SCHEMA_VALIDATION_FAILED` | Supported version but missing required fields     | Inspect producer / RPC decoding bugs |
| `CORRUPT_PAYLOAD`          | Envelope not an object / bad `schemaVersion` type | Drop or repair upstream serialization |

In-process sink: `InMemoryEventDeadLetter` + `routeToDeadLetter()` in
`server/src/services/eventDeadLetter.ts`. The sink never throws into the
indexer loop. Persist to durable storage later by implementing
`EventDeadLetterSink`.

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
