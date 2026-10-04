import { strict as assert } from "node:assert";
import { decodeEvent, canonicalize, type EventEnvelope } from "../services/eventDecoder";

const now = new Date("2026-10-04T00:00:00.000Z");
const u64Max = (1n << 64n) - 1n;
const i128Min = -(1n << 127n);
const i128Max = (1n << 127n) - 1n;

// Constructed envelopes exercise the exported decoder, not a live chain feed.
function envelope(schemaVersion = 1, lifecycle = "purchase"): EventEnvelope {
  return {
    schemaVersion,
    lifecycle,
    topics: { prompt_id: "42" },
    value: {
      buyer: "GTESTBuyer",
      creator: "GTESTCreator",
      asset: "GTESTAsset",
      price_stroops: "10000000",
      referrer: null,
      note: "keep CASE",
      enabled: true,
    },
  };
}

function withValue(key: string, value: unknown, schemaVersion = 1, lifecycle = "purchase") {
  const raw = envelope(schemaVersion, lifecycle);
  if (key === "prompt_id") raw.topics![key] = value;
  else raw.value![key] = value;
  return raw;
}

function assertInvalid(raw: EventEnvelope, key: string) {
  const result = decodeEvent(raw, { now });
  assert.equal(result.ok, false, `${key} must not decode as a valid contract integer`);
  if (result.ok) return;
  assert.equal(result.deadLetter.reason, "SCHEMA_VALIDATION_FAILED");
  assert.ok(result.deadLetter.message.includes(key));
  assert.equal(result.deadLetter.receivedAt, now.toISOString());
  assert.strictEqual(result.deadLetter.raw, raw);
}

describe("contract integer ranges", () => {
  it("rejects booleans and non-decimal integer strings in required fields", () => {
    const invalid = [true, false, "", " ", "1.5", "1e3", "+1", "0x10", "Infinity", "NaN", "1\n", "--1", "-"];
    for (const version of [1, 2]) {
      for (const lifecycle of ["publish", "purchase", "unlock"]) {
        for (const value of invalid) {
          assertInvalid(withValue("prompt_id", value, version, lifecycle), "prompt_id");
          if (lifecycle !== "unlock") {
            assertInvalid(withValue("price_stroops", value, version, lifecycle), "price_stroops");
          }
        }
      }
    }
  });

  it("requires prompt IDs to fit unsigned 64-bit range without unsafe Number coercion", () => {
    for (const value of [-1, -1n, "-1", u64Max + 1n, (u64Max + 1n).toString(), "9".repeat(1000), Number.MAX_SAFE_INTEGER + 1, 1.25, NaN, Infinity]) {
      assertInvalid(withValue("prompt_id", value), "prompt_id");
    }
    for (const value of [0, 0n, "0", Number.MAX_SAFE_INTEGER, "00042", "0".repeat(4096) + "42", u64Max, u64Max.toString()]) {
      const result = decodeEvent(withValue("prompt_id", value), { now });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.event.promptId, String(value));
    }
  });

  it("requires amounts to fit signed 128-bit range while retaining both exact endpoints", () => {
    for (const value of [i128Min - 1n, (i128Min - 1n).toString(), i128Max + 1n, (i128Max + 1n).toString(), -Number.MAX_SAFE_INTEGER - 1, "-" + "9".repeat(1000)]) {
      assertInvalid(withValue("price_stroops", value), "price_stroops");
    }
    for (const value of [i128Min, i128Min.toString(), i128Max, i128Max.toString(), -1, "-0001", "-0", 0, 1, "00042"]) {
      const result = decodeEvent(withValue("price_stroops", value), { now });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.event.fields.price_stroops, String(value));
    }
  });

  it("keeps valid field projection deterministic without changing input or address casing", () => {
    for (const version of [1, 2]) {
      for (const lifecycle of ["publish", "purchase", "unlock"]) {
        const raw = envelope(version, lifecycle);
        Object.freeze(raw.topics);
        Object.freeze(raw.value);
        Object.freeze(raw);
        const first = decodeEvent(raw, { now });
        const second = decodeEvent(raw, { now });
        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        if (!first.ok || !second.ok) return;
        assert.equal(canonicalize(first.event), canonicalize(second.event));
        assert.equal(first.event.fields.creator, "GTESTCreator");
        assert.equal(first.event.fields.note, "keep CASE");
        assert.equal(first.event.fields.enabled, "true");
        assert.equal(first.event.fields.referrer, null);
        assert.equal(first.event.promptId, "42");
      }
    }
  });

  it("keeps unsupported schema versions on their existing dead-letter route", () => {
    const raw = envelope(99);
    const result = decodeEvent(raw, { now });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.deadLetter.reason, "UNSUPPORTED_VERSION");
  });
});
