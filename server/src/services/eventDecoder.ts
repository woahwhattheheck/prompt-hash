/**
 * Deterministic decoder for PromptHash contract lifecycle events.
 *
 * Maps consumer-facing lifecycle names to real Soroban events from
 * `contracts/prompt-hash/src/events.rs`:
 *   publish  → PromptCreated
 *   purchase → PromptPurchased
 *   unlock   → EscrowReleased
 *
 * Supported schema versions decode to a stable canonical projection.
 * Unsupported versions (and corrupt payloads) return a dead-letter
 * record instead of throwing, so indexers can quarantine safely.
 */

export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2] as const);
export type SupportedSchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

export type LifecycleEvent = "publish" | "purchase" | "unlock";

export const LIFECYCLE_TO_CONTRACT_EVENT: Record<LifecycleEvent, string> = {
  publish: "PromptCreated",
  purchase: "PromptPurchased",
  unlock: "EscrowReleased",
};

export const CONTRACT_EVENT_TO_LIFECYCLE: Record<string, LifecycleEvent> = {
  PromptCreated: "publish",
  PromptPurchased: "purchase",
  EscrowReleased: "unlock",
};

export type DeadLetterReason =
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_EVENT_TYPE"
  | "SCHEMA_VALIDATION_FAILED"
  | "CORRUPT_PAYLOAD";

export interface EventEnvelope {
  schemaVersion: number;
  /** Preferred: lifecycle name. Falls back to contractEvent. */
  lifecycle?: LifecycleEvent | string;
  /** Real Soroban event name from events.rs */
  contractEvent?: string;
  envelope?: {
    ledger?: number;
    txHash?: string;
    eventIndex?: number;
    contractId?: string;
  };
  /** Topic fields (#[topic] in the contract event). */
  topics?: Record<string, unknown>;
  /** Non-topic value payload. */
  value?: Record<string, unknown>;
  /** Optional expected canonical form (fixtures only). */
  expected?: Record<string, unknown>;
  description?: string;
}

export interface CanonicalLifecycleEvent {
  lifecycle: LifecycleEvent;
  contractEvent: string;
  schemaVersion: SupportedSchemaVersion;
  promptId: string;
  ledger: number | null;
  txHash: string | null;
  eventIndex: number | null;
  contractId: string | null;
  /** Normalized payload fields (strings preserved, integers as strings). */
  fields: Record<string, string | null>;
}

export interface DeadLetterRecord {
  reason: DeadLetterReason;
  message: string;
  schemaVersion: number | null;
  contractEvent: string | null;
  lifecycle: string | null;
  raw: EventEnvelope;
  receivedAt: string;
}

export type DecodeSuccess = {
  ok: true;
  event: CanonicalLifecycleEvent;
};

export type DecodeFailure = {
  ok: false;
  deadLetter: DeadLetterRecord;
};

export type DecodeResult = DecodeSuccess | DecodeFailure;

function isSupportedVersion(v: number): v is SupportedSchemaVersion {
  return (SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(v);
}

const U64_MAX = (1n << 64n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

/** Admit exact contract integers without changing their serialized representation. */
function isContractInteger(value: unknown, min: bigint, max: bigint): boolean {
  let integer: bigint;
  if (typeof value === "bigint") {
    integer = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return false;
    integer = BigInt(value);
  } else if (typeof value === "string") {
    const negative = value.startsWith("-");
    const digits = negative ? value.slice(1) : value;
    if (digits.length === 0 || /[^0-9]/.test(digits)) return false;
    // Leading zeros are valid and stay unchanged in the eventual projection.
    // Bound BigInt parsing to the widest contract integer, not the raw input.
    const significant = digits.replace(/^0+/, "") || "0";
    if (significant.length > 39) return false;
    integer = BigInt((negative ? "-" : "") + significant);
  } else {
    return false;
  }
  return integer >= min && integer <= max;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // Stellar StrKeys are case-sensitive; never case-fold address strings.
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

function eventNameForMessage(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  // Parsed JSON can contain an object whose toString is not callable.
  return asString(value) ?? `[${typeof value}]`;
}

function resolveLifecycle(raw: EventEnvelope): {
  lifecycle: LifecycleEvent | null;
  contractEvent: string | null;
} {
  const fromLifecycle =
    typeof raw.lifecycle === "string" &&
    Object.prototype.hasOwnProperty.call(LIFECYCLE_TO_CONTRACT_EVENT, raw.lifecycle)
      ? (LIFECYCLE_TO_CONTRACT_EVENT[raw.lifecycle as LifecycleEvent] ?? null)
      : null;

  if (raw.lifecycle && fromLifecycle) {
    return {
      lifecycle: raw.lifecycle as LifecycleEvent,
      contractEvent: fromLifecycle,
    };
  }

  if (
    typeof raw.contractEvent === "string" &&
    Object.prototype.hasOwnProperty.call(CONTRACT_EVENT_TO_LIFECYCLE, raw.contractEvent)
  ) {
    return {
      lifecycle: CONTRACT_EVENT_TO_LIFECYCLE[raw.contractEvent],
      contractEvent: raw.contractEvent,
    };
  }

  if (typeof raw.lifecycle === "string") {
    return { lifecycle: null, contractEvent: raw.contractEvent ?? null };
  }

  return {
    lifecycle: null,
    contractEvent: raw.contractEvent ?? null,
  };
}

function requiredFieldsFor(lifecycle: LifecycleEvent): string[] {
  switch (lifecycle) {
    case "publish":
      return ["prompt_id", "creator", "price_stroops", "asset"];
    case "purchase":
      return ["prompt_id", "buyer", "creator", "price_stroops"];
    case "unlock":
      return ["prompt_id", "buyer"];
  }
}

function mergePayload(raw: EventEnvelope): Record<string, unknown> {
  return {
    ...(raw.value ?? {}),
    ...(raw.topics ?? {}),
  };
}

function deadLetter(
  reason: DeadLetterReason,
  message: string,
  raw: EventEnvelope,
  extras: Partial<Pick<DeadLetterRecord, "schemaVersion" | "contractEvent" | "lifecycle">> = {},
): DecodeFailure {
  return {
    ok: false,
    deadLetter: {
      reason,
      message,
      schemaVersion: extras.schemaVersion ?? (typeof raw.schemaVersion === "number" ? raw.schemaVersion : null),
      contractEvent:
        extras.contractEvent ??
        (typeof raw.contractEvent === "string" ? raw.contractEvent : null),
      lifecycle: extras.lifecycle ?? (typeof raw.lifecycle === "string" ? raw.lifecycle : null),
      raw,
      receivedAt: new Date(0).toISOString(), // overwritten by decodeEvent for clock control
    },
  };
}

/**
 * Decode a versioned event fixture / envelope into a canonical form.
 * Never throws for unsupported or malformed input — returns dead-letter instead.
 */
export function decodeEvent(
  raw: EventEnvelope,
  options: { now?: Date } = {},
): DecodeResult {
  const nowIso = (options.now ?? new Date()).toISOString();

  const finish = (result: DecodeResult): DecodeResult => {
    if (!result.ok) {
      result.deadLetter.receivedAt = nowIso;
    }
    return result;
  };

  if (!raw || typeof raw !== "object") {
    return finish(
      deadLetter("CORRUPT_PAYLOAD", "Event envelope is not an object", (raw as EventEnvelope) ?? {}),
    );
  }

  if (typeof raw.schemaVersion !== "number" || !Number.isFinite(raw.schemaVersion)) {
    return finish(
      deadLetter("CORRUPT_PAYLOAD", "schemaVersion must be a finite number", raw),
    );
  }

  if (!isSupportedVersion(raw.schemaVersion)) {
    return finish(
      deadLetter(
        "UNSUPPORTED_VERSION",
        `Unsupported schemaVersion ${raw.schemaVersion}; supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
        raw,
        { schemaVersion: raw.schemaVersion },
      ),
    );
  }

  const resolved = resolveLifecycle(raw);
  if (!resolved.lifecycle || !resolved.contractEvent) {
    return finish(
      deadLetter(
        "UNKNOWN_EVENT_TYPE",
        `Unable to resolve lifecycle from lifecycle=${eventNameForMessage(raw.lifecycle)} contractEvent=${eventNameForMessage(raw.contractEvent)}`,
        raw,
      ),
    );
  }

  const merged = mergePayload(raw);
  const required = requiredFieldsFor(resolved.lifecycle);
  const missing = required.filter(
    (key) => merged[key] === undefined || merged[key] === null,
  );
  if (missing.length > 0) {
    return finish(
      deadLetter(
        "SCHEMA_VALIDATION_FAILED",
        `Missing required fields for ${resolved.lifecycle}: ${missing.join(", ")}`,
        raw,
        { lifecycle: resolved.lifecycle, contractEvent: resolved.contractEvent },
      ),
    );
  }

  // Required values must remain present after primitive normalization.
  // Contract IDs (u64) and stroop amounts (i128) are integers. JSON Numbers
  // outside the safe integer range may already be rounded; use strings or
  // bigint for larger exact values rather than canonicalizing corrupted data.
  const invalidRequired = required.filter(
    (key) =>
      asString(merged[key]) === null ||
      (key === "prompt_id" && !isContractInteger(merged[key], 0n, U64_MAX)) ||
      (key === "price_stroops" && !isContractInteger(merged[key], I128_MIN, I128_MAX)),
  );
  if (invalidRequired.length > 0) {
    return finish(
      deadLetter(
        "SCHEMA_VALIDATION_FAILED",
        `Invalid required fields for ${resolved.lifecycle}: ${invalidRequired.join(", ")}`,
        raw,
        { lifecycle: resolved.lifecycle, contractEvent: resolved.contractEvent },
      ),
    );
  }

  // Normalize the optional referrer before sorting so absent and explicit
  // null values have the same canonical key order alongside additive fields.
  if (resolved.lifecycle === "purchase" && !("referrer" in merged)) {
    merged.referrer = null;
  }

  // Deterministic field projection: required keys first (stable order), then
  // optional additive keys sorted alphabetically (v2+).
  const optionalKeys = Object.keys(merged)
    .filter((k) => !required.includes(k))
    .sort();

  const fields: Record<string, string | null> = {};
  for (const key of [...required, ...optionalKeys]) {
    fields[key] = asString(merged[key]);
  }

  const event: CanonicalLifecycleEvent = {
    lifecycle: resolved.lifecycle,
    contractEvent: resolved.contractEvent,
    schemaVersion: raw.schemaVersion,
    promptId: fields.prompt_id as string,
    ledger: raw.envelope?.ledger ?? null,
    txHash: raw.envelope?.txHash ?? null,
    eventIndex: raw.envelope?.eventIndex ?? null,
    contractId: raw.envelope?.contractId ?? null,
    fields,
  };

  return { ok: true, event };
}

/** Decode and assert success; useful in tests and strict call sites. */
export function decodeEventOrThrow(raw: EventEnvelope): CanonicalLifecycleEvent {
  const result = decodeEvent(raw);
  if (!result.ok) {
    throw new Error(`${result.deadLetter.reason}: ${result.deadLetter.message}`);
  }
  return result.event;
}

/** Stable JSON serialization for golden/determinism checks. */
export function canonicalize(event: CanonicalLifecycleEvent): string {
  return JSON.stringify(event);
}
