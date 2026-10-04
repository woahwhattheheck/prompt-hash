import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { AuditLog } from "../server/src/models/AuditLog";
import { createInMemoryOutboxStore } from "../src/lib/audit/durableAudit";
import {
  drainCriticalAuditOutbox,
  resetDurableAuditQueueForTests,
} from "../server/src/services/durableAuditQueue";

describe("audit destination recovery", () => {
  beforeEach(() => {
    vi.spyOn(AuditLog, "init").mockResolvedValue(AuditLog);
  });
  afterEach(() => vi.restoreAllMocks());

  it("recovers a successful insert with a failed acknowledgement without retrying to DLQ", async () => {
    const logs = new Map<string, unknown>();
    const duplicate = Object.assign(new Error("duplicate acceptance ID"), {
      code: 11000,
    });
    const create = vi
      .spyOn(AuditLog, "create")
      .mockImplementation(async (doc: any) => {
        if (logs.has(doc.acceptanceId)) throw duplicate;
        logs.set(doc.acceptanceId, doc);
        return doc;
      });
    const exists = vi.spyOn(AuditLog, "exists").mockResolvedValue({
      _id: new Types.ObjectId(),
    });
    const store = createInMemoryOutboxStore();
    let acknowledgementFails = true;
    const interrupted = {
      ...store,
      async markDrained(id: string, token: string) {
        if (acknowledgementFails)
          throw new Error("acknowledgement unavailable");
        return store.markDrained(id, token);
      },
    };
    let clock = 1000;
    const options = { now: () => clock, leaseDurationMs: 100, maxRetries: 0 };
    const original = resetDurableAuditQueueForTests(interrupted, options);
    const { acceptanceId } = await original.accept({
      action: "unlock_success",
      result: "success",
      requestId: "ack-interruption",
    });

    await expect(drainCriticalAuditOutbox(1)).rejects.toThrow(
      "acknowledgement unavailable",
    );
    expect(await store.getById(acceptanceId)).toMatchObject({
      status: "draining",
      attemptCount: 0,
    });
    expect(original.getMetrics()).toMatchObject({
      drained: 0,
      retried: 0,
      dlq: 0,
    });

    acknowledgementFails = false;
    clock += 100;
    resetDurableAuditQueueForTests(store, options);
    expect(await drainCriticalAuditOutbox(1)).toEqual({
      drained: 1,
      retried: 0,
      dlq: 0,
    });
    expect(logs.size).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(exists).toHaveBeenCalledWith({ acceptanceId });
    expect((await store.getById(acceptanceId))?.status).toBe("drained");
  });

  it("does not acknowledge an unrelated duplicate-key error", async () => {
    vi.spyOn(AuditLog, "create").mockRejectedValue(
      Object.assign(new Error("different unique index failed"), {
        code: 11000,
      }),
    );
    vi.spyOn(AuditLog, "exists").mockResolvedValue(null);
    const store = createInMemoryOutboxStore();
    const queue = resetDurableAuditQueueForTests(store, { maxRetries: 0 });
    const { acceptanceId } = await queue.accept({
      action: "unlock_success",
      result: "success",
      requestId: "unrelated-duplicate",
    });

    expect(await drainCriticalAuditOutbox(1)).toEqual({
      drained: 0,
      retried: 0,
      dlq: 1,
    });
    expect(await store.getById(acceptanceId)).toMatchObject({
      status: "dlq",
      lastError: "different unique index failed",
    });
  });
});
