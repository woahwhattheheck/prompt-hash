/**
 * Durable unlock audit acceptance (#167).
 *
 * Critical unlock audit events are accepted into an outbox before sensitive
 * unlock outcomes complete. Acceptance returns an ID. Drain persists to the
 * append-only AuditLog with retry + DLQ.
 *
 * Default outage policy: fail closed. Optional degraded mode is opt-in.
 * Non-goal: hash-chain redesign.
 */

import { createHash, randomUUID } from "crypto";

export const CRITICAL_AUDIT_ACTIONS = [
  "unlock_success",
  "unlock_no_access",
  "unlock_integrity_failure",
  "unlock_invalid_signature",
  "unlock_replay_detected",
  "unlock_rate_limited",
  "unlock_expired_challenge",
] as const;

export type CriticalAuditAction = (typeof CRITICAL_AUDIT_ACTIONS)[number];
export type AuditResult = "success" | "failure" | "blocked";
export type OutboxStatus = "accepted" | "draining" | "drained" | "dlq";

/** Redacted payload — never plaintext, keys, signatures, or challenge secrets. */
export interface RedactedAuditPayload {
  action: CriticalAuditAction;
  result: AuditResult;
  promptId: string | null;
  walletHash: string | null;
  requestId: string | null;
  clientIpHash: string | null;
  reason: string | null;
}

export interface OutboxRecord {
  acceptanceId: string;
  deliveryKey: string;
  payload: RedactedAuditPayload;
  status: OutboxStatus;
  attemptCount: number;
  maxRetries: number;
  createdAt: number;
  nextAttemptAt: number;
  lastError: string | null;
}

export interface OutboxStore {
  countOpen(): Promise<number>;
  findByDeliveryKey(deliveryKey: string): Promise<OutboxRecord | null>;
  insert(record: OutboxRecord): Promise<OutboxRecord>;
  claimNext(now: number): Promise<OutboxRecord | null>;
  markDrained(acceptanceId: string): Promise<void>;
  markRetry(
    acceptanceId: string,
    attemptCount: number,
    nextAttemptAt: number,
    error: string,
  ): Promise<void>;
  markDlq(acceptanceId: string, error: string): Promise<void>;
  getById(acceptanceId: string): Promise<OutboxRecord | null>;
}

export interface DurableAuditMetrics {
  accepted: number;
  drained: number;
  retried: number;
  dlq: number;
  dropped: number;
  degraded: number;
  acceptFailures: number;
}

export interface DurableAuditQueueOptions {
  maxBacklog: number;
  maxRetries: number;
  baseBackoffMs: number;
  now?: () => number;
  idFactory?: () => string;
}

export interface AcceptInput {
  action: CriticalAuditAction;
  result: AuditResult;
  promptId?: string | null;
  walletAddress?: string | null;
  requestId?: string | null;
  clientIp?: string | null;
  reason?: string | null;
}

export class AuditAcceptError extends Error {
  readonly code = "AUDIT_ACCEPT_FAILED" as const;
  readonly causeDetail: string;

  constructor(message: string, causeDetail: string) {
    super(message);
    this.name = "AuditAcceptError";
    this.causeDetail = causeDetail;
  }
}

export function isCriticalAuditAction(
  action: string,
): action is CriticalAuditAction {
  return (CRITICAL_AUDIT_ACTIONS as readonly string[]).includes(action);
}

export function hashWalletAddress(address: string): string {
  return createHash("sha256").update(address.toLowerCase()).digest("hex");
}

export function hashClientIp(ip: string): string {
  return createHash("sha256").update(ip.trim().toLowerCase()).digest("hex");
}

export function buildDeliveryKey(payload: RedactedAuditPayload): string {
  return createHash("sha256")
    .update(
      [
        payload.action,
        payload.result,
        payload.promptId ?? "",
        payload.walletHash ?? "",
        payload.requestId ?? "",
        payload.reason ?? "",
      ].join("|"),
    )
    .digest("hex");
}

export function redactAcceptInput(input: AcceptInput): RedactedAuditPayload {
  return {
    action: input.action,
    result: input.result,
    promptId: input.promptId ?? null,
    walletHash: input.walletAddress
      ? hashWalletAddress(input.walletAddress)
      : null,
    requestId: input.requestId ?? null,
    clientIpHash: input.clientIp ? hashClientIp(input.clientIp) : null,
    reason: input.reason ?? null,
  };
}

export function createInMemoryOutboxStore(): OutboxStore {
  const byId = new Map<string, OutboxRecord>();
  const byKey = new Map<string, string>();

  return {
    async countOpen() {
      let n = 0;
      for (const r of byId.values()) {
        if (r.status === "accepted" || r.status === "draining") n += 1;
      }
      return n;
    },
    async findByDeliveryKey(deliveryKey) {
      const id = byKey.get(deliveryKey);
      return id ? (byId.get(id) ?? null) : null;
    },
    async insert(record) {
      const existing = byKey.get(record.deliveryKey);
      if (existing) return byId.get(existing)!;
      const copy: OutboxRecord = {
        ...record,
        payload: { ...record.payload },
      };
      byId.set(copy.acceptanceId, copy);
      byKey.set(copy.deliveryKey, copy.acceptanceId);
      return copy;
    },
    async claimNext(now) {
      const candidates = [...byId.values()]
        .filter((r) => r.status === "accepted" && r.nextAttemptAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt);
      const next = candidates[0];
      if (!next) return null;
      next.status = "draining";
      return { ...next, payload: { ...next.payload } };
    },
    async markDrained(acceptanceId) {
      const r = byId.get(acceptanceId);
      if (r) {
        r.status = "drained";
        r.lastError = null;
      }
    },
    async markRetry(acceptanceId, attemptCount, nextAttemptAt, error) {
      const r = byId.get(acceptanceId);
      if (r) {
        r.status = "accepted";
        r.attemptCount = attemptCount;
        r.nextAttemptAt = nextAttemptAt;
        r.lastError = error;
      }
    },
    async markDlq(acceptanceId, error) {
      const r = byId.get(acceptanceId);
      if (r) {
        r.status = "dlq";
        r.lastError = error;
      }
    },
    async getById(acceptanceId) {
      const r = byId.get(acceptanceId);
      return r ? { ...r, payload: { ...r.payload } } : null;
    },
  };
}

const DEFAULTS: DurableAuditQueueOptions = {
  maxBacklog: 1_000,
  maxRetries: 5,
  baseBackoffMs: 100,
};

export class DurableAuditQueue {
  private readonly store: OutboxStore;
  private readonly options: DurableAuditQueueOptions;
  private readonly metrics: DurableAuditMetrics = {
    accepted: 0,
    drained: 0,
    retried: 0,
    dlq: 0,
    dropped: 0,
    degraded: 0,
    acceptFailures: 0,
  };

  constructor(
    store: OutboxStore,
    options: Partial<DurableAuditQueueOptions> = {},
  ) {
    this.store = store;
    this.options = { ...DEFAULTS, ...options };
  }

  getMetrics(): DurableAuditMetrics {
    return { ...this.metrics };
  }

  markDegraded(): void {
    this.metrics.degraded += 1;
  }

  async accept(input: AcceptInput): Promise<{
    acceptanceId: string;
    duplicate: boolean;
  }> {
    const payload = redactAcceptInput(input);
    const deliveryKey = buildDeliveryKey(payload);

    const existing = await this.store.findByDeliveryKey(deliveryKey);
    if (existing) {
      return { acceptanceId: existing.acceptanceId, duplicate: true };
    }

    const open = await this.store.countOpen();
    if (open >= this.options.maxBacklog) {
      this.metrics.dropped += 1;
      this.metrics.acceptFailures += 1;
      throw new AuditAcceptError(
        "Audit accept failed; sensitive action must not complete.",
        "backlog_saturated",
      );
    }

    const now = (this.options.now ?? Date.now)();
    const acceptanceId = (this.options.idFactory ?? randomUUID)();

    try {
      const inserted = await this.store.insert({
        acceptanceId,
        deliveryKey,
        payload,
        status: "accepted",
        attemptCount: 0,
        maxRetries: this.options.maxRetries,
        createdAt: now,
        nextAttemptAt: now,
        lastError: null,
      });

      if (inserted.acceptanceId !== acceptanceId) {
        return { acceptanceId: inserted.acceptanceId, duplicate: true };
      }

      this.metrics.accepted += 1;
      return { acceptanceId, duplicate: false };
    } catch (err) {
      if (err instanceof AuditAcceptError) throw err;
      this.metrics.acceptFailures += 1;
      const detail = err instanceof Error ? err.message : String(err);
      throw new AuditAcceptError(
        "Audit accept failed; sensitive action must not complete.",
        `store_error:${detail}`,
      );
    }
  }

  async drainOnce(
    persist: (
      payload: RedactedAuditPayload,
      acceptanceId: string,
    ) => Promise<void>,
  ): Promise<"drained" | "retried" | "dlq" | "idle"> {
    const now = (this.options.now ?? Date.now)();
    const row = await this.store.claimNext(now);
    if (!row) return "idle";

    try {
      await persist(row.payload, row.acceptanceId);
      await this.store.markDrained(row.acceptanceId);
      this.metrics.drained += 1;
      return "drained";
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const nextAttempt = row.attemptCount + 1;
      if (nextAttempt > row.maxRetries) {
        await this.store.markDlq(row.acceptanceId, detail);
        this.metrics.dlq += 1;
        return "dlq";
      }
      const backoff =
        this.options.baseBackoffMs * Math.pow(2, nextAttempt - 1);
      await this.store.markRetry(
        row.acceptanceId,
        nextAttempt,
        now + backoff,
        detail,
      );
      this.metrics.retried += 1;
      return "retried";
    }
  }

  async drainAll(
    persist: (
      payload: RedactedAuditPayload,
      acceptanceId: string,
    ) => Promise<void>,
    max = 100,
  ): Promise<{ drained: number; retried: number; dlq: number }> {
    let drained = 0;
    let retried = 0;
    let dlq = 0;
    for (let i = 0; i < max; i += 1) {
      const result = await this.drainOnce(persist);
      if (result === "idle") break;
      if (result === "drained") drained += 1;
      if (result === "retried") retried += 1;
      if (result === "dlq") dlq += 1;
    }
    return { drained, retried, dlq };
  }
}

export async function acceptCriticalOrThrow(
  queue: DurableAuditQueue,
  input: AcceptInput,
  degradedMode: boolean,
): Promise<{
  acceptanceId: string | null;
  duplicate: boolean;
  degraded: boolean;
}> {
  try {
    const result = await queue.accept(input);
    return {
      acceptanceId: result.acceptanceId,
      duplicate: result.duplicate,
      degraded: false,
    };
  } catch (err) {
    if (err instanceof AuditAcceptError && degradedMode) {
      queue.markDegraded();
      return { acceptanceId: null, duplicate: false, degraded: true };
    }
    throw err;
  }
}
