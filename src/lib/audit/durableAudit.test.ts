/**
 * Durable audit acceptance tests (#167).
 *
 * Covers: DB/queue outage, process crash, duplicate delivery,
 * backlog saturation, and recovery after drain resumes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  AuditAcceptError,
  DurableAuditQueue,
  acceptCriticalOrThrow,
  buildDeliveryKey,
  createInMemoryOutboxStore,
  hashClientIp,
  hashWalletAddress,
  redactAcceptInput,
  type OutboxStore,
  type RedactedAuditPayload,
} from "./durableAudit";

describe("redaction", () => {
  it("hashes wallet and IP; never keeps raw values", () => {
    const payload = redactAcceptInput({
      action: "unlock_success",
      result: "success",
      promptId: "42",
      walletAddress: "GABCDE",
      requestId: "req-1",
      clientIp: "203.0.113.9",
      reason: null,
    });

    expect(payload.walletHash).toBe(hashWalletAddress("GABCDE"));
    expect(payload.clientIpHash).toBe(hashClientIp("203.0.113.9"));
    expect(JSON.stringify(payload)).not.toContain("GABCDE");
    expect(JSON.stringify(payload)).not.toContain("203.0.113.9");
    expect(payload).not.toHaveProperty("plaintext");
    expect(payload).not.toHaveProperty("signedMessage");
    expect(payload).not.toHaveProperty("privateKey");
  });

  it("builds stable delivery keys for idempotency", () => {
    const a = redactAcceptInput({
      action: "unlock_success",
      result: "success",
      promptId: "1",
      walletAddress: "GX",
      requestId: "r",
      reason: null,
    });
    const b = redactAcceptInput({
      action: "unlock_success",
      result: "success",
      promptId: "1",
      walletAddress: "gx",
      requestId: "r",
      reason: null,
    });
    expect(buildDeliveryKey(a)).toBe(buildDeliveryKey(b));
  });
});

describe("accept-before-complete", () => {
  let store: OutboxStore;
  let queue: DurableAuditQueue;

  beforeEach(() => {
    store = createInMemoryOutboxStore();
    queue = new DurableAuditQueue(store, {
      maxBacklog: 3,
      maxRetries: 2,
      baseBackoffMs: 10,
      idFactory: () => `id-${Math.random().toString(16).slice(2)}`,
    });
  });

  it("returns a durable acceptance ID on success", async () => {
    const { acceptanceId, duplicate } = await queue.accept({
      action: "unlock_success",
      result: "success",
      promptId: "7",
      walletAddress: "GWALLET",
      requestId: "req-ok",
    });

    expect(acceptanceId).toMatch(/^id-/);
    expect(duplicate).toBe(false);
    const row = await store.getById(acceptanceId);
    expect(row?.status).toBe("accepted");
    expect(queue.getMetrics().accepted).toBe(1);
  });

  it("deduplicates identical deliveries", async () => {
    const first = await queue.accept({
      action: "unlock_no_access",
      result: "failure",
      promptId: "7",
      walletAddress: "GW",
      requestId: "req-dup",
      reason: "no_access",
    });
    const second = await queue.accept({
      action: "unlock_no_access",
      result: "failure",
      promptId: "7",
      walletAddress: "GW",
      requestId: "req-dup",
      reason: "no_access",
    });

    expect(second.acceptanceId).toBe(first.acceptanceId);
    expect(second.duplicate).toBe(true);
    expect(queue.getMetrics().accepted).toBe(1);
  });

  it("rejects when backlog is saturated (fail closed)", async () => {
    for (let i = 0; i < 3; i += 1) {
      await queue.accept({
        action: "unlock_success",
        result: "success",
        promptId: String(i),
        requestId: `req-${i}`,
      });
    }

    await expect(
      queue.accept({
        action: "unlock_success",
        result: "success",
        promptId: "overflow",
        requestId: "req-overflow",
      }),
    ).rejects.toBeInstanceOf(AuditAcceptError);

    expect(queue.getMetrics().dropped).toBe(1);
    expect(queue.getMetrics().acceptFailures).toBe(1);
  });

  it("fails closed on store outage", async () => {
    const failing: OutboxStore = {
      ...store,
      async insert() {
        throw new Error("DB down");
      },
      async findByDeliveryKey() {
        return null;
      },
      async countOpen() {
        return 0;
      },
    };
    const q = new DurableAuditQueue(failing);

    await expect(
      q.accept({
        action: "unlock_success",
        result: "success",
        promptId: "1",
        requestId: "req-db",
      }),
    ).rejects.toMatchObject({ code: "AUDIT_ACCEPT_FAILED" });

    expect(q.getMetrics().acceptFailures).toBe(1);
  });
});

describe("drain / crash recovery / DLQ", () => {
  let store: OutboxStore;
  let queue: DurableAuditQueue;
  let clock: number;

  beforeEach(() => {
    clock = 1_000_000;
    store = createInMemoryOutboxStore();
    queue = new DurableAuditQueue(store, {
      maxBacklog: 100,
      maxRetries: 2,
      baseBackoffMs: 50,
      now: () => clock,
      idFactory: () => `id-${clock++}`,
    });
  });

  it("recovers accepted-but-not-drained rows after process crash", async () => {
    const { acceptanceId } = await queue.accept({
      action: "unlock_success",
      result: "success",
      promptId: "9",
      requestId: "req-crash",
    });

    const recovered = new DurableAuditQueue(store, {
      maxRetries: 2,
      baseBackoffMs: 50,
      now: () => clock,
    });

    const persisted: string[] = [];
    const result = await recovered.drainOnce(async (payload, id) => {
      persisted.push(`${id}:${payload.action}`);
    });

    expect(result).toBe("drained");
    expect(persisted).toEqual([`${acceptanceId}:unlock_success`]);
    expect((await store.getById(acceptanceId))?.status).toBe("drained");
    expect(recovered.getMetrics().drained).toBe(1);
  });

  it("retries on persist failure then dead-letters", async () => {
    const { acceptanceId } = await queue.accept({
      action: "unlock_integrity_failure",
      result: "failure",
      promptId: "3",
      requestId: "req-dlq",
      reason: "integrity_failure",
    });

    const boom = async () => {
      throw new Error("AuditLog write failed");
    };

    expect(await queue.drainOnce(boom)).toBe("retried");
    expect((await store.getById(acceptanceId))?.status).toBe("accepted");
    expect(queue.getMetrics().retried).toBe(1);

    clock += 1_000;
    expect(await queue.drainOnce(boom)).toBe("retried");

    clock += 1_000;
    expect(await queue.drainOnce(boom)).toBe("dlq");
    expect((await store.getById(acceptanceId))?.status).toBe("dlq");
    expect(queue.getMetrics().dlq).toBe(1);
  });

  it("drains successfully after transient outage recovers", async () => {
    await queue.accept({
      action: "unlock_invalid_signature",
      result: "failure",
      promptId: "2",
      requestId: "req-rec",
      reason: "invalid_signature",
    });

    let calls = 0;
    const flaky = async (_p: RedactedAuditPayload, _id: string) => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
    };

    expect(await queue.drainOnce(flaky)).toBe("retried");
    clock += 1_000;
    expect(await queue.drainOnce(flaky)).toBe("drained");
    expect(queue.getMetrics().drained).toBe(1);
    expect(queue.getMetrics().retried).toBe(1);
  });
});

describe("degraded policy adapter", () => {
  it("returns degraded=true instead of throwing when opted in", async () => {
    const store = createInMemoryOutboxStore();
    const queue = new DurableAuditQueue(store, { maxBacklog: 0 });

    const result = await acceptCriticalOrThrow(
      queue,
      {
        action: "unlock_success",
        result: "success",
        promptId: "1",
        requestId: "req-deg",
      },
      true,
    );

    expect(result.degraded).toBe(true);
    expect(result.acceptanceId).toBeNull();
    expect(queue.getMetrics().degraded).toBe(1);
  });

  it("rethrows when degraded mode is off", async () => {
    const store = createInMemoryOutboxStore();
    const queue = new DurableAuditQueue(store, { maxBacklog: 0 });

    await expect(
      acceptCriticalOrThrow(
        queue,
        {
          action: "unlock_success",
          result: "success",
          promptId: "1",
          requestId: "req-strict",
        },
        false,
      ),
    ).rejects.toBeInstanceOf(AuditAcceptError);
  });
});

describe("metrics", () => {
  it("exposes counters for ops dashboards", async () => {
    const store = createInMemoryOutboxStore();
    const queue = new DurableAuditQueue(store, {
      maxBacklog: 1,
      maxRetries: 0,
    });

    await queue.accept({
      action: "unlock_rate_limited",
      result: "blocked",
      requestId: "m1",
      reason: "ip_rate_limit_exceeded",
    });

    await expect(
      queue.accept({
        action: "unlock_rate_limited",
        result: "blocked",
        requestId: "m2",
        reason: "ip_rate_limit_exceeded",
      }),
    ).rejects.toBeInstanceOf(AuditAcceptError);

    await queue.drainOnce(async () => {
      throw new Error("sink down");
    });

    const m = queue.getMetrics();
    expect(m.accepted).toBe(1);
    expect(m.dropped).toBe(1);
    expect(m.dlq).toBe(1);
  });
});
