/**
 * Versioned event fixture + decoder tests (issue #246).
 *
 * Acceptance:
 * - Supported fixtures decode deterministically
 * - Unsupported versions fail safely (dead-letter, no throw)
 */

import * as fs from "fs";
import * as path from "path";
import {
  canonicalize,
  decodeEvent,
  EventEnvelope,
  LIFECYCLE_TO_CONTRACT_EVENT,
  SUPPORTED_SCHEMA_VERSIONS,
} from "../services/eventDecoder";
import {
  InMemoryEventDeadLetter,
  routeToDeadLetter,
} from "../services/eventDeadLetter";

const FIXTURES_DIR = path.resolve(__dirname, "../../tests/fixtures/events");

function loadFixture(name: string): EventEnvelope {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
  return JSON.parse(raw) as EventEnvelope;
}

const SUPPORTED_FIXTURES = [
  "publish.v1.json",
  "purchase.v1.json",
  "unlock.v1.json",
  "publish.v2.json",
  "purchase.v2.json",
  "unlock.v2.json",
] as const;

describe("event lifecycle mapping matches contracts/prompt-hash/src/events.rs", () => {
  it("maps publish/purchase/unlock to real contract event names", () => {
    expect(LIFECYCLE_TO_CONTRACT_EVENT.publish).toBe("PromptCreated");
    expect(LIFECYCLE_TO_CONTRACT_EVENT.purchase).toBe("PromptPurchased");
    expect(LIFECYCLE_TO_CONTRACT_EVENT.unlock).toBe("EscrowReleased");
  });

  it("exposes supported schema versions 1 and 2", () => {
    expect([...SUPPORTED_SCHEMA_VERSIONS]).toEqual([1, 2]);
  });
});

describe("supported event fixtures decode deterministically", () => {
  for (const file of SUPPORTED_FIXTURES) {
    describe(file, () => {
      const fixture = loadFixture(file);

      it("decodes without throwing and returns ok", () => {
        expect(() => decodeEvent(fixture)).not.toThrow();
        const result = decodeEvent(fixture);
        expect(result.ok).toBe(true);
      });

      it("matches expected canonical fields from the fixture", () => {
        const result = decodeEvent(fixture);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.event.lifecycle).toBe(fixture.expected?.lifecycle);
        expect(result.event.contractEvent).toBe(fixture.expected?.contractEvent);
        expect(result.event.schemaVersion).toBe(fixture.expected?.schemaVersion);
        expect(result.event.promptId).toBe(fixture.expected?.promptId);
        expect(result.event.fields).toEqual(fixture.expected?.fields);
      });

      it("is deterministic across repeated decodes", () => {
        const a = decodeEvent(fixture);
        const b = decodeEvent(fixture);
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        expect(canonicalize(a.event)).toBe(canonicalize(b.event));
        expect(a.event).toEqual(b.event);
      });
    });
  }

  it("manifest lists every supported fixture file on disk", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf8"),
    ) as { fixtures: { supported: string[] } };
    for (const name of manifest.fixtures.supported) {
      expect(fs.existsSync(path.join(FIXTURES_DIR, name))).toBe(true);
    }
    expect(manifest.fixtures.supported.sort()).toEqual([...SUPPORTED_FIXTURES].sort());
  });
});

describe("unsupported versions fail safely (dead-letter)", () => {
  const fixedNow = new Date("2026-09-25T12:00:00.000Z");

  it("schema v99 → UNSUPPORTED_VERSION, does not throw", () => {
    const fixture = loadFixture("unsupported.schema_v99.json");
    expect(() => decodeEvent(fixture, { now: fixedNow })).not.toThrow();
    const result = decodeEvent(fixture, { now: fixedNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deadLetter.reason).toBe("UNSUPPORTED_VERSION");
    expect(result.deadLetter.schemaVersion).toBe(99);
    expect(result.deadLetter.raw).toEqual(fixture);
    expect(result.deadLetter.receivedAt).toBe(fixedNow.toISOString());
  });

  it("unknown lifecycle → UNKNOWN_EVENT_TYPE", () => {
    const fixture = loadFixture("unsupported.unknown_type.json");
    const result = decodeEvent(fixture, { now: fixedNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deadLetter.reason).toBe("UNKNOWN_EVENT_TYPE");
  });

  it("missing required fields → SCHEMA_VALIDATION_FAILED", () => {
    const fixture = loadFixture("unsupported.missing_fields.json");
    const result = decodeEvent(fixture, { now: fixedNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deadLetter.reason).toBe("SCHEMA_VALIDATION_FAILED");
    expect(result.deadLetter.message).toMatch(/buyer/);
  });

  it("routes decode failures into the dead-letter sink without crashing", () => {
    const sink = new InMemoryEventDeadLetter();
    const fixture = loadFixture("unsupported.schema_v99.json");
    const result = decodeEvent(fixture, { now: fixedNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(() => routeToDeadLetter(result.deadLetter, sink)).not.toThrow();
    expect(sink.size()).toBe(1);
    expect(sink.byReason("UNSUPPORTED_VERSION")).toHaveLength(1);
    expect(sink.list()[0].raw.schemaVersion).toBe(99);
  });

  it("corrupt envelope (non-number schemaVersion) dead-letters as CORRUPT_PAYLOAD", () => {
    const result = decodeEvent(
      { schemaVersion: "nope" as unknown as number, lifecycle: "publish" },
      { now: fixedNow },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deadLetter.reason).toBe("CORRUPT_PAYLOAD");
  });
});
