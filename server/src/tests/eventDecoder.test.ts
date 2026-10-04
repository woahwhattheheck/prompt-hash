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
        expect(result.event.contractEvent).toBe(
          fixture.expected?.contractEvent,
        );
        expect(result.event.schemaVersion).toBe(
          fixture.expected?.schemaVersion,
        );
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
    expect(manifest.fixtures.supported.sort()).toEqual(
      [...SUPPORTED_FIXTURES].sort(),
    );
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

  for (const field of ["lifecycle", "contractEvent"] as const) {
    it.each(["__proto__", "constructor", "toString"])(
      `${field}=%s is dead-lettered instead of resolving an inherited map entry`,
      (value) => {
        const envelope: EventEnvelope = { schemaVersion: 1, [field]: value };
        const result = decodeEvent(envelope, { now: fixedNow });
        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.deadLetter.reason).toBe("UNKNOWN_EVENT_TYPE");
        expect(result.deadLetter.raw).toEqual(envelope);
        expect(result.deadLetter.receivedAt).toBe(fixedNow.toISOString());

        const sink = new InMemoryEventDeadLetter();
        routeToDeadLetter(result.deadLetter, sink);
        expect(sink.byReason("UNKNOWN_EVENT_TYPE")).toHaveLength(1);
      },
    );
  }

  const noncoercibleNames = [
    ["object", '{"toString":null}'],
    ["array", '[{"toString":null}]'],
  ] as const;

  for (const field of ["lifecycle", "contractEvent"] as const) {
    it.each(noncoercibleNames)(
      `${field} parsed JSON %s is dead-lettered without coercing its value`,
      (_shape, json) => {
        const envelope = JSON.parse(
          `{"schemaVersion":1,"${field}":${json}}`,
        ) as EventEnvelope;
        expect(() => decodeEvent(envelope, { now: fixedNow })).not.toThrow();
        const result = decodeEvent(envelope, { now: fixedNow });
        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.deadLetter.reason).toBe("UNKNOWN_EVENT_TYPE");
        expect(typeof result.deadLetter.message).toBe("string");
        expect(result.deadLetter.message.length).toBeGreaterThan(0);
        expect(result.deadLetter.lifecycle).toBeNull();
        expect(result.deadLetter.contractEvent).toBeNull();
        expect(result.deadLetter.raw).toBe(envelope);
        expect(result.deadLetter.receivedAt).toBe(fixedNow.toISOString());

        const sink = new InMemoryEventDeadLetter();
        expect(() => routeToDeadLetter(result.deadLetter, sink)).not.toThrow();
        expect(sink.byReason("UNKNOWN_EVENT_TYPE")).toEqual([
          result.deadLetter,
        ]);
        expect(sink.list()[0].raw).toBe(envelope);
      },
    );
  }

  for (const [schemaVersion, reason] of [
    [99, "UNSUPPORTED_VERSION"],
    ["nope", "CORRUPT_PAYLOAD"],
  ] as const) {
    it.each(noncoercibleNames)(
      `${reason} preserves string/null metadata with a parsed JSON %s contractEvent`,
      (_shape, json) => {
        const envelope = JSON.parse(
          `{"schemaVersion":${JSON.stringify(schemaVersion)},"lifecycle":"publish","contractEvent":${json}}`,
        ) as EventEnvelope;
        expect(() => decodeEvent(envelope, { now: fixedNow })).not.toThrow();
        const result = decodeEvent(envelope, { now: fixedNow });
        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.deadLetter.reason).toBe(reason);
        expect(result.deadLetter.lifecycle).toBe("publish");
        expect(result.deadLetter.contractEvent).toBeNull();
        expect(result.deadLetter.schemaVersion).toBe(
          typeof schemaVersion === "number" ? schemaVersion : null,
        );
        expect(result.deadLetter.raw).toBe(envelope);
        expect(result.deadLetter.receivedAt).toBe(fixedNow.toISOString());

        const sink = new InMemoryEventDeadLetter();
        routeToDeadLetter(result.deadLetter, sink);
        expect(sink.byReason(reason)).toEqual([result.deadLetter]);
        expect(sink.list()[0].raw).toBe(envelope);
      },
    );
  }

  it.each([
    ["lifecycle", '{"toString":null}'],
    ["contractEvent", '[{"toString":null}]'],
  ] as const)(
    "valid event-name resolution survives malformed %s from parsed JSON",
    (field, json) => {
      const fixture = loadFixture("publish.v1.json");
      const envelope = JSON.parse(
        JSON.stringify({ ...fixture, [field]: JSON.parse(json) }),
      ) as EventEnvelope;

      expect(() => decodeEvent(envelope, { now: fixedNow })).not.toThrow();
      const result = decodeEvent(envelope, { now: fixedNow });
      expect(result.ok).toBe(true);
      expect(result).toEqual(decodeEvent(fixture, { now: fixedNow }));
    },
  );

  for (const [file, location, field] of [
    ["publish.v1.json", "topics", "prompt_id"],
    ["publish.v1.json", "value", "creator"],
    ["publish.v1.json", "value", "price_stroops"],
    ["publish.v1.json", "value", "asset"],
    ["purchase.v1.json", "topics", "prompt_id"],
    ["purchase.v1.json", "value", "buyer"],
    ["purchase.v1.json", "value", "creator"],
    ["purchase.v1.json", "value", "price_stroops"],
    ["unlock.v1.json", "topics", "prompt_id"],
    ["unlock.v1.json", "value", "buyer"],
  ] as const) {
    it.each([
      ["object", "{}"],
      ["array", "[]"],
    ] as const)(
      `${file}: required ${field} as %s is a schema failure`,
      (_shape, json) => {
        const fixture = loadFixture(file);
        const payload = fixture[location];
        if (!payload) throw new Error("Fixture is missing its payload");
        payload[field] = JSON.parse(json);

        const result = decodeEvent(fixture, { now: fixedNow });
        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.deadLetter.reason).toBe("SCHEMA_VALIDATION_FAILED");
        expect(result.deadLetter.message).toContain(field);
        expect(result.deadLetter.lifecycle).toBe(fixture.lifecycle);
        expect(result.deadLetter.contractEvent).toBe(fixture.contractEvent);
        expect(result.deadLetter.raw).toBe(fixture);
        expect(result.deadLetter.receivedAt).toBe(fixedNow.toISOString());
      },
    );
  }

  it.each([
    ["publish.v1.json", "creator", 123],
    ["publish.v1.json", "asset", false],
    ["purchase.v1.json", "buyer", 42],
    ["purchase.v1.json", "creator", true],
    ["unlock.v1.json", "buyer", 0],
  ] as const)(
    "%s: required Address field %s rejects non-string primitive",
    (file, field, value) => {
      const fixture = loadFixture(file);
      fixture.value = { ...fixture.value, [field]: value };

      const result = decodeEvent(fixture, { now: fixedNow });
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.deadLetter.reason).toBe("SCHEMA_VALIDATION_FAILED");
      expect(result.deadLetter.message).toContain(field);
      expect(result.deadLetter.lifecycle).toBe(fixture.lifecycle);
      expect(result.deadLetter.contractEvent).toBe(fixture.contractEvent);
      expect(result.deadLetter.raw).toBe(fixture);
    },
  );

  it.each([
    ["empty string", "", null],
    ["zero number", 0, "0"],
    ["bigint", BigInt(42), "42"],
    ["false boolean", false, null],
  ] as const)(
    "required prompt_id enforces exact integer admission for %s",
    (_label, value, expected) => {
      const fixture = loadFixture("publish.v1.json");
      fixture.topics = { ...fixture.topics, prompt_id: value };

      const result = decodeEvent(fixture, { now: fixedNow });
      expect(result.ok).toBe(expected !== null);
      if (!result.ok) {
        expect(expected).toBeNull();
        expect(result.deadLetter.reason).toBe("SCHEMA_VALIDATION_FAILED");
        expect(result.deadLetter.message).toContain("prompt_id");
        expect(result.deadLetter.raw).toBe(fixture);
        return;
      }

      expect(result.event.promptId).toBe(expected);
      expect(result.event.fields.prompt_id).toBe(expected);
    },
  );

  it.each([
    ["object", "{}"],
    ["array", "[]"],
  ] as const)("optional %s values retain null projection", (_shape, json) => {
    const fixture = loadFixture("publish.v2.json");
    fixture.value = { ...fixture.value, metadata_uri: JSON.parse(json) };

    const result = decodeEvent(fixture, { now: fixedNow });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.event.fields.metadata_uri).toBeNull();
    expect(result.event.promptId).toBe(fixture.expected?.promptId);
  });

  it("unsupported version takes precedence over invalid required values", () => {
    const fixture = loadFixture("publish.v1.json");
    fixture.schemaVersion = 99;
    fixture.topics = { ...fixture.topics, prompt_id: {} };

    const result = decodeEvent(fixture, { now: fixedNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.deadLetter.reason).toBe("UNSUPPORTED_VERSION");
    expect(result.deadLetter.raw).toBe(fixture);
    expect(result.deadLetter.receivedAt).toBe(fixedNow.toISOString());
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

  it.each(["synchronous", "asynchronous"])(
    "logs a %s sink failure without interrupting the consumer",
    async (mode) => {
      const result = decodeEvent(loadFixture("unsupported.schema_v99.json"), {
        now: fixedNow,
      });
      if (result.ok) throw new Error("Expected unsupported event");

      const sink = new InMemoryEventDeadLetter();
      const failure = new Error("storage offline");
      const push = jest.spyOn(sink, "push").mockImplementation(() => {
        if (mode === "synchronous") throw failure;
        return Promise.reject(failure);
      });
      const log = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        expect(routeToDeadLetter(result.deadLetter, sink)).toBeUndefined();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(push).toHaveBeenCalledTimes(1);
        expect(push.mock.calls[0][0]).toBe(result.deadLetter);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(
          "[event-dlq] failed to persist dead-letter record",
          failure,
        );
      } finally {
        push.mockRestore();
        log.mockRestore();
      }
    },
  );

  it("routes to an asynchronous sink without logging a successful write", async () => {
    const result = decodeEvent(loadFixture("unsupported.schema_v99.json"), {
      now: fixedNow,
    });
    if (result.ok) throw new Error("Expected unsupported event");

    const sink = new InMemoryEventDeadLetter();
    const store = sink.push.bind(sink);
    const push = jest.spyOn(sink, "push").mockImplementation(async (record) => {
      store(record);
    });
    const log = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      expect(routeToDeadLetter(result.deadLetter, sink)).toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(push).toHaveBeenCalledTimes(1);
      expect(sink.list()).toEqual([result.deadLetter]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      push.mockRestore();
      log.mockRestore();
    }
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
