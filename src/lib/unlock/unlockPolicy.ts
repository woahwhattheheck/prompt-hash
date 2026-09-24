/**
 * Unlock fulfillment / dispute-hold policy (#166).
 *
 * Mandatory holds (refund, open dispute) must be evaluated before decryption.
 * Database failures fail closed: deny with a stable retryable error and never
 * bypass policy. An optional short-lived HMAC-signed snapshot softens brief
 * outages after a successful live evaluation — stale or unsigned cache never
 * grants access.
 */

import { createHmac, timingSafeEqual } from "crypto";

export const POLICY_UNAVAILABLE_MESSAGE =
  "Access policy could not be verified. Please try again shortly.";

export const DENY_MESSAGES = {
  refund_requested: "Access is temporarily held due to an open dispute.",
  refunded: "Access has been revoked following a refund.",
} as const;

export type DenyReason = keyof typeof DENY_MESSAGES;

export type UnlockPolicyDecision =
  | {
      outcome: "allow";
      status: string | null;
      source: "live" | "cache";
    }
  | {
      outcome: "deny";
      reason: DenyReason;
      message: string;
      status: string;
      source: "live" | "cache";
    }
  | {
      outcome: "unavailable";
      message: string;
      cause?: string;
    };

export interface FulfillmentStatusRow {
  status: string;
}

export type FindFulfillment = (
  promptId: string,
  buyerWallet: string,
) => Promise<FulfillmentStatusRow | null>;

/** Default live-lookup budget; hung Mongo must not hang unlock forever. */
export const DEFAULT_LOOKUP_TIMEOUT_MS = 3_000;

/** Default signed-snapshot freshness window. */
export const DEFAULT_POLICY_CACHE_TTL_MS = 30_000;

export interface PolicySnapshotPayload {
  promptId: string;
  buyerWallet: string;
  decision: "allow" | "deny";
  status: string | null;
  denyReason?: DenyReason;
  evaluatedAt: number;
}

function cacheKey(promptId: string, buyerWallet: string): string {
  return `${promptId}:${buyerWallet.toLowerCase()}`;
}

function canonicalPayload(payload: PolicySnapshotPayload): string {
  return JSON.stringify({
    promptId: payload.promptId,
    buyerWallet: payload.buyerWallet.toLowerCase(),
    decision: payload.decision,
    status: payload.status,
    denyReason: payload.denyReason ?? null,
    evaluatedAt: payload.evaluatedAt,
  });
}

export function signPolicySnapshot(
  payload: PolicySnapshotPayload,
  secret: string,
): string {
  const body = canonicalPayload(payload);
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${Buffer.from(body, "utf8").toString("base64url")}.${sig}`;
}

export function verifyPolicySnapshot(
  token: string,
  secret: string,
): PolicySnapshotPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [bodyB64, sig] = parts;
  let body: string;
  try {
    body = Buffer.from(bodyB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(body) as PolicySnapshotPayload;
    if (
      typeof parsed.promptId !== "string" ||
      typeof parsed.buyerWallet !== "string" ||
      (parsed.decision !== "allow" && parsed.decision !== "deny") ||
      typeof parsed.evaluatedAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export class UnlockPolicyCache {
  private readonly store = new Map<string, string>();

  get(promptId: string, buyerWallet: string): string | undefined {
    return this.store.get(cacheKey(promptId, buyerWallet));
  }

  set(promptId: string, buyerWallet: string, token: string): void {
    this.store.set(cacheKey(promptId, buyerWallet), token);
  }

  clear(): void {
    this.store.clear();
  }

  delete(promptId: string, buyerWallet: string): void {
    this.store.delete(cacheKey(promptId, buyerWallet));
  }
}

/** Process-local default cache (tests can inject their own). */
export const globalUnlockPolicyCache = new UnlockPolicyCache();

function decisionFromSnapshot(
  snapshot: PolicySnapshotPayload,
  source: "live" | "cache",
): UnlockPolicyDecision {
  if (snapshot.decision === "deny" && snapshot.denyReason) {
    return {
      outcome: "deny",
      reason: snapshot.denyReason,
      message: DENY_MESSAGES[snapshot.denyReason],
      status: snapshot.status ?? snapshot.denyReason,
      source,
    };
  }
  return {
    outcome: "allow",
    status: snapshot.status,
    source,
  };
}

function classifyFulfillment(
  row: FulfillmentStatusRow | null,
): { decision: "allow" | "deny"; status: string | null; denyReason?: DenyReason } {
  if (!row) {
    return { decision: "allow", status: null };
  }
  if (row.status === "refund_requested") {
    return {
      decision: "deny",
      status: row.status,
      denyReason: "refund_requested",
    };
  }
  if (row.status === "refunded") {
    return {
      decision: "deny",
      status: row.status,
      denyReason: "refunded",
    };
  }
  return { decision: "allow", status: row.status };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function tryCache(
  promptId: string,
  buyerWallet: string,
  secret: string,
  cache: UnlockPolicyCache,
  now: number,
  ttlMs: number,
): UnlockPolicyDecision | null {
  const token = cache.get(promptId, buyerWallet);
  if (!token) return null;
  const snapshot = verifyPolicySnapshot(token, secret);
  if (!snapshot) {
    cache.delete(promptId, buyerWallet);
    return null;
  }
  if (
    snapshot.promptId !== String(promptId) ||
    snapshot.buyerWallet.toLowerCase() !== buyerWallet.toLowerCase()
  ) {
    cache.delete(promptId, buyerWallet);
    return null;
  }
  if (now - snapshot.evaluatedAt > ttlMs) {
    // Stale — fail closed (caller treats null as unavailable when live failed).
    return null;
  }
  return decisionFromSnapshot(snapshot, "cache");
}

export interface EvaluateUnlockPolicyOptions {
  promptId: string;
  buyerWallet: string;
  findFulfillment: FindFulfillment;
  signingSecret: string;
  cache?: UnlockPolicyCache;
  now?: number;
  ttlMs?: number;
  lookupTimeoutMs?: number;
}

/**
 * Evaluate refund / dispute-hold policy for unlock.
 * Live DB success updates the signed cache. Live failure uses a fresh signed
 * cache entry only; otherwise returns `unavailable` (fail closed).
 */
export async function evaluateUnlockFulfillmentPolicy(
  opts: EvaluateUnlockPolicyOptions,
): Promise<UnlockPolicyDecision> {
  const promptId = String(opts.promptId);
  const buyerWallet = String(opts.buyerWallet).toLowerCase();
  const secret = opts.signingSecret;
  const cache = opts.cache ?? globalUnlockPolicyCache;
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_POLICY_CACHE_TTL_MS;
  const lookupTimeoutMs = opts.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;

  if (!secret) {
    return {
      outcome: "unavailable",
      message: POLICY_UNAVAILABLE_MESSAGE,
      cause: "missing_signing_secret",
    };
  }

  try {
    const row = await withTimeout(
      opts.findFulfillment(promptId, buyerWallet),
      lookupTimeoutMs,
      "Fulfillment policy lookup",
    );
    const classified = classifyFulfillment(row);
    const snapshot: PolicySnapshotPayload = {
      promptId,
      buyerWallet,
      decision: classified.decision,
      status: classified.status,
      denyReason: classified.denyReason,
      evaluatedAt: now,
    };
    cache.set(promptId, buyerWallet, signPolicySnapshot(snapshot, secret));
    return decisionFromSnapshot(snapshot, "live");
  } catch (err) {
    const cached = tryCache(promptId, buyerWallet, secret, cache, now, ttlMs);
    if (cached) return cached;
    const cause = err instanceof Error ? err.message : String(err);
    return {
      outcome: "unavailable",
      message: POLICY_UNAVAILABLE_MESSAGE,
      cause,
    };
  }
}

/**
 * Default Mongo-backed finder used by the unlock API.
 * Isolated for tests to inject failures without mongoose.
 */
export async function findFulfillmentRecord(
  promptId: string,
  buyerWallet: string,
): Promise<FulfillmentStatusRow | null> {
  const FulfillmentRecord = (
    await import("../../../server/src/models/FulfillmentRecord")
  ).default;
  const query = FulfillmentRecord.findOne({
    promptId: String(promptId),
    buyerWallet: String(buyerWallet).toLowerCase(),
  });
  const fulfillment =
    typeof query?.lean === "function" ? await query.lean() : await query;
  if (!fulfillment) return null;
  return { status: String((fulfillment as { status: string }).status) };
}
