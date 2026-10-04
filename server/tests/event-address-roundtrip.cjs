// From server/: node --experimental-strip-types --test tests/event-address-roundtrip.cjs
// Pure decoder checks: no RPC, wallet, database, or installed SDK is required.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { decodeEvent, canonicalize } = require("../src/services/eventDecoder.ts");

// Independently generated with RFC 4648 base32 and CRC16-XModem (little endian).
// Payloads are 32 bytes of 0, 1 and 2 respectively; these are not signing keys.
const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const BUYER = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";
const CONTRACT = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";

function decodeStrKey(encoded, version) {
  assert.match(encoded, /^[A-Z2-7]{56}$/, "StrKey must retain canonical case");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = [];
  let bits = 0, accumulator = 0;
  for (const char of encoded) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  const decoded = Buffer.from(bytes);
  assert.equal(decoded.length, 35);
  assert.equal(decoded[0], version);
  let checksum = 0;
  for (const byte of decoded.subarray(0, 33)) {
    checksum ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      checksum = ((checksum << 1) ^ (checksum & 0x8000 ? 0x1021 : 0)) & 0xffff;
    }
  }
  assert.equal(decoded.readUInt16LE(33), checksum, "StrKey checksum");
  return decoded.subarray(1, 33);
}

function envelope(lifecycle, schemaVersion) {
  return {
    schemaVersion,
    lifecycle,
    topics: { prompt_id: 42 },
    value: {
      creator: ACCOUNT, buyer: BUYER, asset: CONTRACT,
      price_stroops: 10000000, referrer: ACCOUNT,
    },
  };
}

for (const version of [1, 2]) {
  for (const lifecycle of ["publish", "purchase", "unlock"]) {
    test(`${lifecycle} v${version}: account and contract bytes survive decoding`, () => {
      const input = envelope(lifecycle, version);
      const snapshot = structuredClone(input);
      const result = decodeEvent(input);
      assert.equal(result.ok, true);
      for (const [key, encoded, versionByte, fill] of [
        ["creator", ACCOUNT, 6 << 3, 0], ["buyer", BUYER, 6 << 3, 1],
        ["asset", CONTRACT, 2 << 3, 2], ["referrer", ACCOUNT, 6 << 3, 0],
      ]) {
        assert.deepEqual(decodeStrKey(encoded, versionByte), Buffer.alloc(32, fill));
        assert.deepEqual(decodeStrKey(result.event.fields[key], versionByte), Buffer.alloc(32, fill));
        assert.equal(result.event.fields[key], encoded);
      }
      assert.equal(result.event.fields.price_stroops, "10000000");
      assert.equal(result.event.promptId, "42");
      assert.equal(canonicalize(result.event), canonicalize(decodeEvent(input).event));
      assert.deepEqual(input, snapshot);
    });

    test(`${lifecycle} v${version}: existing golden fixture`, () => {
      const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/events", `${lifecycle}.v${version}.json`), "utf8"));
      const result = decodeEvent(fixture);
      assert.equal(result.ok, true);
      assert.deepEqual(result.event.fields, fixture.expected.fields);
    });
  }
}

test("optional referrer stays null, whether absent or explicit", () => {
  for (const absent of [false, true]) {
    const input = envelope("purchase", 1);
    input.value.referrer = null;
    if (absent) delete input.value.referrer;
    assert.equal(decodeEvent(input).event.fields.referrer, null);
  }
});

test("topics still override values, without case-folding either source", () => {
  const input = envelope("publish", 2);
  input.topics.creator = BUYER;
  assert.equal(decodeEvent(input).event.fields.creator, BUYER);
});

test("strings are preserved, not silently repaired or rejected", () => {
  const input = envelope("publish", 2);
  input.value.creator = "mixedCaseAddressLabel";
  input.value.metadata_uri = "ipfs://MixedCase";
  const result = decodeEvent(input);
  assert.equal(result.ok, true);
  assert.equal(result.event.fields.creator, input.value.creator);
  assert.equal(result.event.fields.metadata_uri, input.value.metadata_uri);
});

test("unsupported versions and invalid required values keep their dead letters", () => {
  const input = envelope("publish", 99);
  input.value.creator = {};
  const now = new Date("2026-10-04T08:00:00.000Z");
  for (const [version, reason] of [[99, "UNSUPPORTED_VERSION"], [1, "SCHEMA_VALIDATION_FAILED"]]) {
    input.schemaVersion = version;
    const result = decodeEvent(input, { now });
    assert.equal(result.ok, false);
    assert.equal(result.deadLetter.reason, reason);
    assert.equal(result.deadLetter.raw, input);
    assert.equal(result.deadLetter.receivedAt, now.toISOString());
  }
});
