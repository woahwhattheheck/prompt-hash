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
  /** Normalized payload fields (addresses lowercased, integers as strings). */
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

const ADDRESS_KEYS = new Set([
  "creator",
  "buyer",
  "seller",
  "asset",
  "referrer",
  "submitter",
  "reviewer",
  "admin",
  "signer",
  "caller",
  "proposer",
  "new_fee_wallet",
]);

function isSupportedVersion(v: number): v is SupportedSchemaVersion {
  return (SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(v);
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

function normalizeField(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = asString(value);
  if (str === null) return null;
  if (ADDRESS_KEYS.has(key)) return str.toLowerCase();
  return str;
}

function resolveLifecycle(raw: EventEnvelope): {
  lifecycle: LifecycleEvent | null;
  contractEvent: string | null;
} {
  const fromLifecycle =
    typeof raw.lifecycle === "string"
      ? (LIFECYCLE_TO_CONTRACT_EVENT[raw.lifecycle as LifecycleEvent] ?? null)
      : null;

  if (raw.lifecycle && fromLifecycle) {
    return {
      lifecycle: raw.lifecycle as LifecycleEvent,
      contractEvent: fromLifecycle,
    };
  }

  if (raw.contractEvent && CONTRACT_EVENT_TO_LIFECYCLE[raw.contractEvent]) {
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
      contractEvent: extras.contractEvent ?? raw.contractEvent ?? null,
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
        `Unable to resolve lifecycle from lifecycle=${String(raw.lifecycle)} contractEvent=${String(raw.contractEvent)}`,
        raw,
      ),
    );
  }

  const merged = mergePayload(raw);
  const missing = requiredFieldsFor(resolved.lifecycle).filter(
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

  // Deterministic field projection: required keys first (stable order), then
  // optional additive keys sorted alphabetically (v2+).
  const required = requiredFieldsFor(resolved.lifecycle);
  const optionalKeys = Object.keys(merged)
    .filter((k) => !required.includes(k))
    .sort();

  const fields: Record<string, string | null> = {};
  for (const key of [...required, ...optionalKeys]) {
    fields[key] = normalizeField(key, merged[key]);
  }

  // referrer is Optional<Address> on PromptPurchased — keep explicit null.
  if (resolved.lifecycle === "purchase" && !("referrer" in fields)) {
    fields.referrer = null;
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
