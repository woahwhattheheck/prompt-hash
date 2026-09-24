/**
 * Webhook delivery-log privacy helpers (issue #176).
 *
 * - Redact endpoint credentials and sensitive query values into a safe identity
 * - Optionally encrypt the full destination for operational recovery
 * - Normalize/cap delivery errors so raw network detail never persists
 * - Bound retention via expiresAt (+ Mongo TTL index on the model)
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "crypto";

/** Default retention for delivery logs (30 days). */
export const DEFAULT_DELIVERY_LOG_TTL_DAYS = 30;

/** Hard cap on persisted lastError text. */
export const MAX_ERROR_TEXT_LENGTH = 200;

/** Closed set of safe error codes persisted on delivery logs. */
export const WEBHOOK_ERROR_CODES = [
  "http_client_error",
  "http_server_error",
  "http_rate_limited",
  "timeout",
  "ssrf_blocked",
  "dns_failed",
  "redirect_error",
  "network_error",
  "unknown",
] as const;

export type WebhookErrorCode = (typeof WEBHOOK_ERROR_CODES)[number];

export interface NormalizedDeliveryError {
  errorCode: WebhookErrorCode;
  lastError: string;
}

export interface EncryptedDestination {
  ciphertext: string;
  keyVersion: number;
}

const SENSITIVE_QUERY_KEYS = new Set(
  [
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "api_key",
    "apikey",
    "key",
    "secret",
    "client_secret",
    "password",
    "passwd",
    "pwd",
    "auth",
    "authorization",
    "signature",
    "sig",
    "hmac",
    "private_key",
    "privatekey",
    "session",
    "sessionid",
    "session_id",
    "jwt",
    "bearer",
    "code",
    "otp",
  ].map((k) => k.toLowerCase()),
);

function parseTtlDays(): number {
  const raw = process.env.WEBHOOK_DELIVERY_LOG_TTL_DAYS;
  if (raw == null || raw === "") return DEFAULT_DELIVERY_LOG_TTL_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DELIVERY_LOG_TTL_DAYS;
  return Math.min(Math.floor(n), 3650);
}

/** Compute expiresAt for a new delivery log entry. */
export function computeDeliveryLogExpiresAt(from: Date = new Date()): Date {
  const days = parseTtlDays();
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function isSensitiveQueryKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_QUERY_KEYS.has(lower)) return true;
  return /(?:^|[_-])(token|secret|password|passwd|auth|key|sig|signature)(?:$|[_-])/i.test(
    lower,
  );
}

/**
 * Build a redacted endpoint identity safe for logs/APIs.
 * Strips userinfo; redacts sensitive query values; preserves host (incl. IPv6),
 * port, and path. Returns a stable placeholder for unparseable input.
 */
export function redactEndpointUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return "[invalid-url]";

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Avoid echoing credentials that may sit before '@' in malformed input.
    return "[invalid-url]";
  }

  parsed.username = "";
  parsed.password = "";

  const params = new URLSearchParams(parsed.search);
  const redacted = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    redacted.append(key, isSensitiveQueryKey(key) ? "[REDACTED]" : value);
  }
  const search = redacted.toString();
  parsed.search = search ? `?${search}` : "";
  parsed.hash = "";

  return parsed.toString();
}

/** Alias: legacy `url` column always holds the redacted identity. */
export function safeLogUrl(rawUrl: string): string {
  return redactEndpointUrl(rawUrl);
}

function decodeKeyMaterial(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(b64, "base64");
    if (buf.length === 32) return buf;
  } catch {
    // fall through
  }

  // Derive a 32-byte key from arbitrary secret material (still deterministic).
  if (trimmed.length >= 16) {
    return createHash("sha256").update(trimmed).digest();
  }
  return null;
}

function loadKeyRing(): Map<number, Buffer> {
  const ring = new Map<number, Buffer>();
  const primary = process.env.WEBHOOK_DESTINATION_ENCRYPTION_KEY;
  const versionRaw = process.env.WEBHOOK_DESTINATION_ENCRYPTION_KEY_VERSION;
  const version = versionRaw ? Number(versionRaw) : 1;
  const ver = Number.isFinite(version) && version >= 1 ? Math.floor(version) : 1;

  if (primary) {
    const key = decodeKeyMaterial(primary);
    if (key) ring.set(ver, key);
  }

  const previous = process.env.WEBHOOK_DESTINATION_ENCRYPTION_KEY_PREVIOUS;
  if (previous) {
    const prevVerRaw = process.env.WEBHOOK_DESTINATION_ENCRYPTION_KEY_PREVIOUS_VERSION;
    const prevVer = prevVerRaw ? Number(prevVerRaw) : ver - 1;
    const pv =
      Number.isFinite(prevVer) && prevVer >= 1 ? Math.floor(prevVer) : Math.max(1, ver - 1);
    const key = decodeKeyMaterial(previous);
    if (key) ring.set(pv, key);
  }

  return ring;
}

/**
 * Encrypt the full destination URL for operational recovery.
 * Returns null when no encryption key is configured (never stores plaintext).
 */
export function encryptDestination(rawUrl: string): EncryptedDestination | null {
  const ring = loadKeyRing();
  if (ring.size === 0) return null;

  const versionRaw = process.env.WEBHOOK_DESTINATION_ENCRYPTION_KEY_VERSION;
  const preferred = versionRaw ? Number(versionRaw) : 1;
  const version =
    Number.isFinite(preferred) && preferred >= 1 && ring.has(Math.floor(preferred))
      ? Math.floor(preferred)
      : Math.max(...ring.keys());

  const key = ring.get(version);
  if (!key) return null;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(rawUrl, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const packed = `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
  return { ciphertext: packed, keyVersion: version };
}

/**
 * Decrypt a previously encrypted destination. Tries the recorded key version,
 * then any other keys in the ring (rotation).
 */
export function decryptDestination(
  packed: string,
  keyVersion?: number | null,
): string | null {
  if (!packed || typeof packed !== "string") return null;
  const parts = packed.split(".");
  if (parts.length !== 3) return null;

  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(parts[0], "base64");
    tag = Buffer.from(parts[1], "base64");
    ciphertext = Buffer.from(parts[2], "base64");
  } catch {
    return null;
  }
  if (iv.length !== 12 || tag.length !== 16) return null;

  const ring = loadKeyRing();
  if (ring.size === 0) return null;

  const tryOrder: number[] = [];
  if (keyVersion != null && ring.has(keyVersion)) tryOrder.push(keyVersion);
  for (const v of ring.keys()) {
    if (!tryOrder.includes(v)) tryOrder.push(v);
  }

  for (const v of tryOrder) {
    const key = ring.get(v);
    if (!key) continue;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plain.toString("utf8");
    } catch {
      // try next key
    }
  }
  return null;
}

function capErrorText(text: string): string {
  if (text.length <= MAX_ERROR_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_ERROR_TEXT_LENGTH - 1)}…`;
}

/**
 * Strip hostnames, IPv4/IPv6 literals, and URL-looking fragments from error text
 * so persisted messages cannot re-introduce network detail.
 */
export function sanitizeErrorText(raw: string): string {
  let text = String(raw ?? "");
  text = text.replace(/https?:\/\/[^\s)'"`]+/gi, "[redacted-url]");
  text = text.replace(/\b[^\s/@]+@[^\s/@]+\b/g, "[redacted-cred]");
  text = text.replace(
    /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g,
    "[redacted-ip]",
  );
  text = text.replace(/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, "[redacted-ip]");
  return capErrorText(text.replace(/\s+/g, " ").trim());
}

/** Normalize an HTTP status into a safe code + capped message. */
export function normalizeHttpError(status: number): NormalizedDeliveryError {
  if (status === 429) {
    return { errorCode: "http_rate_limited", lastError: "HTTP 429" };
  }
  if (status >= 400 && status < 500) {
    return { errorCode: "http_client_error", lastError: `HTTP ${status}` };
  }
  if (status >= 500) {
    return { errorCode: "http_server_error", lastError: `HTTP ${status}` };
  }
  return { errorCode: "unknown", lastError: `HTTP ${status}` };
}

/**
 * Normalize a thrown delivery error into a closed errorCode + capped message.
 * Never persists the raw exception text verbatim.
 */
export function normalizeDeliveryError(err: unknown): NormalizedDeliveryError {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  const name = err instanceof Error ? err.name : "";
  const lower = message.toLowerCase();

  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("aborted")
  ) {
    return { errorCode: "timeout", lastError: "Delivery timed out" };
  }

  if (lower.includes("ssrf")) {
    return { errorCode: "ssrf_blocked", lastError: "Destination blocked by SSRF policy" };
  }

  if (
    lower.includes("dns") ||
    lower.includes("enotfound") ||
    lower.includes("getaddrinfo") ||
    lower.includes("could not resolve")
  ) {
    return { errorCode: "dns_failed", lastError: "DNS resolution failed" };
  }

  if (lower.includes("redirect")) {
    return { errorCode: "redirect_error", lastError: "Redirect handling failed" };
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("ehostunreach") ||
    lower.includes("enetunreach") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("socket")
  ) {
    return { errorCode: "network_error", lastError: "Network error" };
  }

  const sanitized = sanitizeErrorText(message);
  return {
    errorCode: "unknown",
    lastError: sanitized ? capErrorText(`Delivery failed: ${sanitized}`) : "Delivery failed",
  };
}

/** Fields written when creating a delivery log from a raw subscriber URL. */
export function buildDeliveryLogEndpointFields(rawUrl: string): {
  url: string;
  endpointIdentity: string;
  encryptedDestination: string | null;
  encryptionKeyVersion: number | null;
} {
  const endpointIdentity = redactEndpointUrl(rawUrl);
  const encrypted = encryptDestination(rawUrl);
  return {
    // Legacy `url` column always holds the redacted identity — never credentials.
    url: endpointIdentity,
    endpointIdentity,
    encryptedDestination: encrypted?.ciphertext ?? null,
    encryptionKeyVersion: encrypted?.keyVersion ?? null,
  };
}

/**
 * Safe projection for APIs / reconciliation mismatch details.
 * Never includes encryptedDestination or credential-bearing URLs.
 */
export function publicDeliveryLogEndpoint(log: {
  endpointIdentity?: string | null;
  url?: string | null;
  errorCode?: string | null;
  lastError?: string | null;
  deliveryId?: string;
}): {
  deliveryId?: string;
  endpointIdentity: string;
  errorCode: string | null;
  lastError: string | null;
} {
  const identity =
    (log.endpointIdentity && String(log.endpointIdentity)) ||
    (log.url ? redactEndpointUrl(String(log.url)) : "[unknown]");
  return {
    ...(log.deliveryId != null ? { deliveryId: String(log.deliveryId) } : {}),
    endpointIdentity: identity,
    errorCode: log.errorCode != null ? String(log.errorCode) : null,
    lastError: log.lastError != null ? sanitizeErrorText(String(log.lastError)) : null,
  };
}

/**
 * Explicit cleanup helper for expired logs (complements Mongo TTL index).
 * Useful for tests and ops runbooks that want synchronous purge.
 */
export async function purgeExpiredDeliveryLogs(
  model: { deleteMany: (filter: object) => Promise<{ deletedCount?: number }> },
  now: Date = new Date(),
): Promise<number> {
  const result = await model.deleteMany({ expiresAt: { $lte: now } });
  return result.deletedCount ?? 0;
}

/** Test helper — constant-time string equality. */
export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
