/**
 * Abuse-report evidence validation and moderation status machine (Issue #241).
 *
 * Evidence is reference-only: hashes, CIDs, https URL refs, and tx hashes.
 * Raw prompt bodies, data URIs, credentials, and oversized blobs are rejected.
 */

export type ReportStatus =
  | "pending"
  | "investigating"
  | "resolved"
  | "dismissed";

export type EvidenceKind =
  | "content_hash"
  | "ipfs_cid"
  | "url_ref"
  | "tx_hash"
  | "screenshot_hash";

export interface EvidenceRef {
  kind: EvidenceKind;
  /** Immutable reference (hash, CID, https URL, or Stellar tx hash). */
  ref: string;
  /** Optional short note — never a dump of sensitive content. */
  note?: string;
}

export interface StatusTransition {
  from: ReportStatus;
  to: ReportStatus;
  actor: string;
  notes?: string;
  at: string;
}

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "content_hash",
  "ipfs_cid",
  "url_ref",
  "tx_hash",
  "screenshot_hash",
] as const;

export const REPORT_STATUSES: readonly ReportStatus[] = [
  "pending",
  "investigating",
  "resolved",
  "dismissed",
] as const;

export const OPEN_REPORT_STATUSES: readonly ReportStatus[] = [
  "pending",
  "investigating",
] as const;

export const MAX_EVIDENCE_ITEMS = 5;
export const MAX_EVIDENCE_REF_LENGTH = 512;
export const MAX_EVIDENCE_NOTE_LENGTH = 200;

const ALLOWED_TRANSITIONS: Record<ReportStatus, readonly ReportStatus[]> = {
  pending: ["investigating", "resolved", "dismissed"],
  investigating: ["resolved", "dismissed", "pending"],
  resolved: ["investigating"],
  dismissed: ["investigating"],
};

const HEX_HASH_RE = /^(0x)?[a-fA-F0-9]{32,128}$/;
const IPFS_CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{50,}|bafk[a-z2-7]{50,})$/;
const TX_HASH_RE = /^(0x)?[a-fA-F0-9]{64}$/;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PRIVATE_KEY_RE =
  /\b(S[A-Z0-9]{55}|0x[a-fA-F0-9]{64}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)\b/;
const BASE64_BLOB_RE = /^(?:[A-Za-z0-9+/]{4}){20,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

export class StatusTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusTransitionError";
  }
}

export function isOpenReportStatus(status: ReportStatus): boolean {
  return (OPEN_REPORT_STATUSES as readonly string[]).includes(status);
}

export function canTransition(
  from: ReportStatus,
  to: ReportStatus,
): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: ReportStatus,
  to: ReportStatus,
): void {
  if (!REPORT_STATUSES.includes(to)) {
    throw new StatusTransitionError(`Invalid status: ${to}`);
  }
  if (!canTransition(from, to)) {
    throw new StatusTransitionError(
      `Illegal status transition: ${from} → ${to}`,
    );
  }
}

export function buildStatusTransition(input: {
  from: ReportStatus;
  to: ReportStatus;
  actor: string;
  notes?: string;
  at?: Date | string;
}): StatusTransition {
  assertTransition(input.from, input.to);
  const actor = String(input.actor || "").trim();
  if (!actor) {
    throw new StatusTransitionError("actor is required for status transitions");
  }
  const at =
    input.at instanceof Date
      ? input.at.toISOString()
      : input.at || new Date().toISOString();
  return {
    from: input.from,
    to: input.to,
    actor: actor.toLowerCase(),
    notes: input.notes?.slice(0, 500) || undefined,
    at,
  };
}

function looksUnsafeRef(ref: string): string | null {
  const trimmed = ref.trim();
  const lower = trimmed.toLowerCase();

  if (!trimmed) return "Evidence ref must not be empty";
  if (trimmed.length > MAX_EVIDENCE_REF_LENGTH) {
    return `Evidence ref exceeds ${MAX_EVIDENCE_REF_LENGTH} characters`;
  }
  if (lower.startsWith("data:") || lower.startsWith("javascript:")) {
    return "Unsafe evidence scheme rejected";
  }
  if (lower.includes("://") && /\/\/[^/]*:/.test(trimmed)) {
    // user:pass@host
    return "Evidence URLs must not include credentials";
  }
  if (EMAIL_RE.test(trimmed)) {
    return "Evidence ref must not contain email addresses";
  }
  if (PRIVATE_KEY_RE.test(trimmed)) {
    return "Evidence ref must not contain private keys or secrets";
  }
  if (BASE64_BLOB_RE.test(trimmed.replace(/\s/g, ""))) {
    return "Raw base64 blobs are not accepted as evidence refs";
  }
  // Reject obvious plaintext dumps (spaces + long free text without URL/hash shape)
  if (trimmed.length > 120 && /\s/.test(trimmed) && !/^https:\/\//i.test(trimmed)) {
    return "Evidence ref looks like a free-text dump; use a hash or URL reference";
  }
  return null;
}

function validateKindRef(kind: EvidenceKind, ref: string): string | null {
  switch (kind) {
    case "content_hash":
    case "screenshot_hash":
      if (!HEX_HASH_RE.test(ref)) {
        return `${kind} must be a hex digest (32–128 chars)`;
      }
      return null;
    case "ipfs_cid":
      if (!IPFS_CID_RE.test(ref)) {
        return "ipfs_cid must be a CIDv0 (Qm…) or CIDv1 (bafy…/bafk…)";
      }
      return null;
    case "tx_hash":
      if (!TX_HASH_RE.test(ref)) {
        return "tx_hash must be a 64-character hex digest";
      }
      return null;
    case "url_ref": {
      let url: URL;
      try {
        url = new URL(ref);
      } catch {
        return "url_ref must be a valid absolute URL";
      }
      if (url.protocol !== "https:") {
        return "url_ref must use https";
      }
      if (url.username || url.password) {
        return "Evidence URLs must not include credentials";
      }
      return null;
    }
    default:
      return `Unsupported evidence kind: ${kind}`;
  }
}

/**
 * Normalize and validate evidence refs. Throws EvidenceValidationError on unsafe input.
 */
export function normalizeEvidence(
  input: unknown,
): EvidenceRef[] {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new EvidenceValidationError("evidence must be an array");
  }
  if (input.length > MAX_EVIDENCE_ITEMS) {
    throw new EvidenceValidationError(
      `At most ${MAX_EVIDENCE_ITEMS} evidence items are allowed`,
    );
  }

  const normalized: EvidenceRef[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      throw new EvidenceValidationError("Each evidence item must be an object");
    }
    const item = raw as Record<string, unknown>;
    const kind = String(item.kind || "") as EvidenceKind;
    if (!EVIDENCE_KINDS.includes(kind)) {
      throw new EvidenceValidationError(
        `Invalid evidence kind: ${item.kind}. Allowed: ${EVIDENCE_KINDS.join(", ")}`,
      );
    }
    const ref = String(item.ref ?? "").trim();
    const unsafe = looksUnsafeRef(ref);
    if (unsafe) {
      throw new EvidenceValidationError(unsafe);
    }
    const kindErr = validateKindRef(kind, ref);
    if (kindErr) {
      throw new EvidenceValidationError(kindErr);
    }

    let note: string | undefined;
    if (item.note !== undefined && item.note !== null && item.note !== "") {
      note = String(item.note).trim();
      if (note.length > MAX_EVIDENCE_NOTE_LENGTH) {
        throw new EvidenceValidationError(
          `Evidence note exceeds ${MAX_EVIDENCE_NOTE_LENGTH} characters`,
        );
      }
      if (EMAIL_RE.test(note) || PRIVATE_KEY_RE.test(note)) {
        throw new EvidenceValidationError(
          "Evidence note must not contain emails or secrets",
        );
      }
    }

    const dedupeKey = `${kind}:${ref.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push(note ? { kind, ref, note } : { kind, ref });
  }

  return normalized;
}

/** Stable key used to detect duplicate open reports. */
export function duplicateReportKey(
  promptId: string,
  reporterAddress: string,
  reason: string,
): string {
  return `${String(promptId).trim()}:${String(reporterAddress).trim().toLowerCase()}:${String(reason).trim()}`;
}

/** Redact reporter address for non-admin / public-facing payloads. */
export function redactReporterAddress(address: string): string {
  const a = String(address || "");
  if (a.length <= 8) return "***";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function isTerminalStatus(status: ReportStatus): boolean {
  return status === "resolved" || status === "dismissed";
}
