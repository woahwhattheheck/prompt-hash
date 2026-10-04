# Exact numeric event inputs

The contract declares `prompt_id` as `u64` and `price_stroops` as `i128` in `contracts/prompt-hash/src/events.rs`. JavaScript Numbers cannot represent every value in either domain exactly. The decoder must not manufacture an exact-looking decimal string from an already rounded Number.

## Reproduction and repair

On parent `b5960ddf829d5dbf01fb94cd1b85c5b89079c389`, JSON containing the numeric token `9007199254740993` is parsed as `9007199254740992`. The decoder accepted that rounded value for both the prompt ID and purchase price and emitted it in its canonical success output.

Source repair `ecbea4cab36d6db02e6e23b845dae8b747e0b2d1` rejects unsafe, fractional, and non-finite Number values in the required `prompt_id` and `price_stroops` fields through the existing `SCHEMA_VALIDATION_FAILED` result. It does not guess the original value. Upstream adapters should supply larger integers as exact decimal strings, or bigint before JSON serialization.

Exact strings, bigint, safe integers, optional metadata conversion, supported schema versions, required-field ordering, address case, and the existing dead-letter representation remain unchanged. This is a Number-representation admission check, not a new validation of address syntax, decimal-string syntax, or every contract integer bound.

## Executed result

One dependency-free invocation of both complete decoder files on Node v22.16.0 with `--experimental-strip-types` completed 98 controlled comparisons: 61 inputs accepted by the original decoder now return the intended schema error, and 37 controls retain identical canonical/error output. No provider request, dependency install, contract execution, or full repository suite was involved.

The rejected matrix covers both schema versions, all three lifecycle types, required IDs and prices where applicable, unsafe positive/negative integers, fractions, NaN, and both infinities. The additional parsed-JSON case demonstrates the one-unit corruption directly. Controls cover safe boundaries, exact large strings/bigint, case-sensitive addresses, optional fractional metadata, earlier malformed/unsupported errors, and exact u64/i128 maximum strings. The retained raw object and supplied observation clock are preserved for rejected events.

Executed blob identities:

- Original: `b5f4f64e3a5501128f35b2fdf1fd727a4de252bf` (9,638 bytes).
- Repaired: `cc71cb23037152a1fee5667afce9e36c55c76113` (10,024 bytes).

## Minimal independent check

Run from a checkout containing both commits with Node 22.16 or newer. This copies the complete modules to a temporary directory; it does not modify the checkout or call a provider.

```bash
scratch=$(mktemp -d)
git show b5960ddf829d5dbf01fb94cd1b85c5b89079c389:server/src/services/eventDecoder.ts > "$scratch/before.ts"
git show ecbea4cab36d6db02e6e23b845dae8b747e0b2d1:server/src/services/eventDecoder.ts > "$scratch/after.ts"
cat > "$scratch/check.mjs" <<'JS'
import assert from 'node:assert/strict';
import * as before from './before.ts';
import * as after from './after.ts';
const raw = JSON.parse('{"schemaVersion":1,"lifecycle":"purchase","topics":{"prompt_id":9007199254740993},"value":{"buyer":"GBuyer","creator":"GCreator","price_stroops":9007199254740993}}');
const prior = before.decodeEvent(raw);
assert.equal(prior.ok, true);
assert.equal(prior.event.promptId, '9007199254740992');
assert.equal(prior.event.fields.price_stroops, '9007199254740992');
const repaired = after.decodeEvent(raw);
assert.equal(repaired.ok, false);
assert.equal(repaired.deadLetter.reason, 'SCHEMA_VALIDATION_FAILED');
raw.topics.prompt_id = '9007199254740993';
raw.value.price_stroops = '9007199254740993';
const exact = after.decodeEvent(raw);
assert.equal(exact.ok, true);
assert.equal(exact.event.promptId, '9007199254740993');
assert.equal(exact.event.fields.price_stroops, '9007199254740993');
assert.equal(exact.event.fields.buyer, 'GBuyer');
console.log('rounded Number refused; exact string and address case preserved');
JS
node --experimental-strip-types "$scratch/check.mjs"
rm -f "$scratch/check.mjs" "$scratch/before.ts" "$scratch/after.ts"
rmdir "$scratch"
```

The minimal check illustrates the central failure; it is not presented as the full 98-comparison run. This change continues the original PR276 and does not establish sponsor acceptance or payment.
