/**
 * Server adapter: durable critical unlock audit acceptance (#167).
 *
 * Wires DurableAuditQueue to Mongo AuditOutbox + AuditLog drain.
 * Unlock awaits acceptCriticalUnlockAudit before completing sensitive outcomes.
 */

import { randomUUID } from "crypto";
import { AuditLog } from "../models/AuditLog";
import { AuditOutbox } from "../models/AuditOutbox";
import {
  AuditAcceptError,
  DurableAuditQueue,
  acceptCriticalOrThrow,
  createInMemoryOutboxStore,
  isCriticalAuditAction,
  type AcceptInput,
  type OutboxRecord,
  type OutboxStore,
  type RedactedAuditPayload,
} from "../../../src/lib/audit/durableAudit";

export { AuditAcceptError, isCriticalAuditAction };
export type { AcceptInput };

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true" || v === "yes";
}

function maxBacklog(): number {
  const n = parseInt(process.env.AUDIT_OUTBOX_MAX_BACKLOG || "1000", 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

function maxRetries(): number {
  const n = parseInt(process.env.AUDIT_OUTBOX_MAX_RETRIES || "5", 10);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

function leaseDurationMs(): number {
  const n = Number(process.env.AUDIT_OUTBOX_LEASE_MS || "30000");
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

export function createMongoOutboxStore(): OutboxStore {
  return {
    async countOpen() {
      return AuditOutbox.countDocuments({
        status: { $in: ["accepted", "draining"] },
      });
    },
    async findByDeliveryKey(deliveryKey) {
      const doc = await AuditOutbox.findOne({ deliveryKey }).lean();
      return doc ? toRecord(doc as Record<string, unknown>) : null;
    },
    async insert(record) {
      try {
        const doc = await AuditOutbox.create({
          acceptanceId: record.acceptanceId,
          deliveryKey: record.deliveryKey,
          payload: record.payload,
          status: "accepted",
          attemptCount: 0,
          maxRetries: record.maxRetries,
          acceptedAt: new Date(record.createdAt),
          nextAttemptAt: new Date(record.nextAttemptAt),
          lastError: null,
        });
        return toRecord(doc.toObject() as Record<string, unknown>);
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code?: number }).code === 11000
        ) {
          const existing = await AuditOutbox.findOne({
            deliveryKey: record.deliveryKey,
          }).lean();
          if (existing) return toRecord(existing as Record<string, unknown>);
        }
        throw err;
      }
    },
    async claimNext(now, leaseDurationMs) {
      const leaseToken = randomUUID();
      const leaseExpiresAt = now + leaseDurationMs;
      const doc = await AuditOutbox.findOneAndUpdate(
        {
          $or: [
            { status: "accepted", nextAttemptAt: { $lte: new Date(now) } },
            { status: "draining", leaseExpiresAt: { $lte: new Date(now) } },
            // Mongo's null equality also matches pre-lease rows with no field.
            { status: "draining", leaseExpiresAt: null },
          ],
        },
        {
          $set: {
            status: "draining",
            leaseToken,
            leaseExpiresAt: new Date(leaseExpiresAt),
          },
        },
        { sort: { acceptedAt: 1 }, new: true },
      ).lean();
      return doc
        ? {
            ...toRecord(doc as Record<string, unknown>),
            leaseToken,
            leaseExpiresAt,
          }
        : null;
    },
    async markDrained(acceptanceId, leaseToken) {
      const result = await AuditOutbox.updateOne(
        { acceptanceId, status: "draining", leaseToken },
        {
          $set: {
            status: "drained",
            lastError: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        },
      );
      return result.matchedCount === 1;
    },
    async markRetry(
      acceptanceId,
      leaseToken,
      attemptCount,
      nextAttemptAt,
      error,
    ) {
      const result = await AuditOutbox.updateOne(
        { acceptanceId, status: "draining", leaseToken },
        {
          $set: {
            status: "accepted",
            attemptCount,
            nextAttemptAt: new Date(nextAttemptAt),
            lastError: error,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        },
      );
      return result.matchedCount === 1;
    },
    async markDlq(acceptanceId, leaseToken, error) {
      const result = await AuditOutbox.updateOne(
        { acceptanceId, status: "draining", leaseToken },
        {
          $set: {
            status: "dlq",
            lastError: error,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        },
      );
      return result.matchedCount === 1;
    },
    async getById(acceptanceId) {
      const doc = await AuditOutbox.findOne({ acceptanceId }).lean();
      return doc ? toRecord(doc as Record<string, unknown>) : null;
    },
  };
}

function toRecord(doc: Record<string, unknown>): OutboxRecord {
  const payload = doc.payload as RedactedAuditPayload;
  const acceptedAt = doc.acceptedAt
    ? new Date(doc.acceptedAt as string | Date).getTime()
    : Date.now();
  const nextAttemptAt = doc.nextAttemptAt
    ? new Date(doc.nextAttemptAt as string | Date).getTime()
    : acceptedAt;

  return {
    acceptanceId: String(doc.acceptanceId),
    deliveryKey: String(doc.deliveryKey),
    payload: {
      action: payload.action,
      result: payload.result,
      promptId: payload.promptId ?? null,
      walletHash: payload.walletHash ?? null,
      requestId: payload.requestId ?? null,
      clientIpHash: payload.clientIpHash ?? null,
      reason: payload.reason ?? null,
    },
    status: doc.status as OutboxRecord["status"],
    attemptCount: Number(doc.attemptCount ?? 0),
    maxRetries: Number(doc.maxRetries ?? 5),
    createdAt: acceptedAt,
    nextAttemptAt,
    lastError: (doc.lastError as string | null) ?? null,
    leaseToken: (doc.leaseToken as string | null) ?? null,
    leaseExpiresAt: doc.leaseExpiresAt
      ? new Date(doc.leaseExpiresAt as string | Date).getTime()
      : null,
  };
}

let sharedQueue: DurableAuditQueue | null = null;

export function getDurableAuditQueue(): DurableAuditQueue {
  if (!sharedQueue) {
    sharedQueue = new DurableAuditQueue(createMongoOutboxStore(), {
      maxBacklog: maxBacklog(),
      maxRetries: maxRetries(),
      baseBackoffMs: 250,
      leaseDurationMs: leaseDurationMs(),
      idFactory: () => randomUUID(),
    });
  }
  return sharedQueue;
}

export function resetDurableAuditQueueForTests(
  store: OutboxStore = createInMemoryOutboxStore(),
  options: Partial<ConstructorParameters<typeof DurableAuditQueue>[1]> = {},
): DurableAuditQueue {
  sharedQueue = new DurableAuditQueue(store, {
    maxBacklog: maxBacklog(),
    maxRetries: maxRetries(),
    baseBackoffMs: 10,
    leaseDurationMs: leaseDurationMs(),
    idFactory: () => randomUUID(),
    ...options,
  });
  return sharedQueue;
}

async function persistToAuditLog(
  payload: RedactedAuditPayload,
  acceptanceId: string,
): Promise<void> {
  // Wait for the declared unique index when Mongoose manages indexes. Deployments
  // with autoIndex disabled must provision that index before draining the outbox.
  await AuditLog.init();
  try {
    await AuditLog.create({
      acceptanceId,
      action: payload.action,
      result: payload.result,
      promptId: payload.promptId,
      walletAddress: payload.walletHash,
      requestId: payload.requestId ?? acceptanceId,
      clientIp: payload.clientIpHash,
      reason: payload.reason,
    });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000 &&
      (await AuditLog.exists({ acceptanceId }))
    ) {
      return;
    }
    throw err;
  }
}

/**
 * Accept a critical unlock audit event before completing the sensitive action.
 * Returns acceptanceId, or null when degraded mode is enabled and accept fails.
 * Throws AuditAcceptError when fail-closed (default).
 */
export async function acceptCriticalUnlockAudit(input: AcceptInput): Promise<{
  acceptanceId: string | null;
  duplicate: boolean;
  degraded: boolean;
}> {
  if (!isCriticalAuditAction(input.action)) {
    throw new Error(`Not a critical unlock audit action: ${input.action}`);
  }
  return acceptCriticalOrThrow(
    getDurableAuditQueue(),
    input,
    envFlag("AUDIT_DEGRADED_MODE"),
  );
}

export async function drainCriticalAuditOutbox(max = 50): Promise<{
  drained: number;
  retried: number;
  dlq: number;
}> {
  return getDurableAuditQueue().drainAll(persistToAuditLog, max);
}

export function getCriticalAuditMetrics() {
  return getDurableAuditQueue().getMetrics();
}
