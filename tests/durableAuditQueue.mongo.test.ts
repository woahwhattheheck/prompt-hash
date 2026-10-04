import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../server/src/models/AuditLog";
import { AuditOutbox } from "../server/src/models/AuditOutbox";
import { DurableAuditQueue } from "../src/lib/audit/durableAudit";
import {
  createMongoOutboxStore,
  drainCriticalAuditOutbox,
  resetDurableAuditQueueForTests,
} from "../server/src/services/durableAuditQueue";

// Opt in with a disposable Mongo endpoint. Every run uses its own database.
const uri = process.env.AUDIT_TEST_MONGODB_URI;
const database = `audit_recovery_test_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!uri)("Mongo audit crash recovery", () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: database });
    await Promise.all([AuditLog.init(), AuditOutbox.init()]);
  }, 30_000);
  beforeEach(async () => {
    await Promise.all([AuditLog.deleteMany({}), AuditOutbox.deleteMany({})]);
  });
  afterAll(async () => {
    if (mongoose.connection.name === database) {
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
  });

  it("atomically reclaims an expired claim and fences every stale transition", async () => {
    const first = createMongoOutboxStore();
    const second = createMongoOutboxStore();
    const queue = new DurableAuditQueue(first, { now: () => 1000 });
    const { acceptanceId } = await queue.accept({
      action: "unlock_success",
      result: "success",
      requestId: "claimed-crash",
    });
    const abandoned = (await first.claimNext(1000, 100))!;
    expect(await second.claimNext(1099, 100)).toBeNull();
    const contenders = await Promise.all([
      first.claimNext(1100, 100),
      second.claimNext(1100, 100),
    ]);
    expect(contenders.filter(Boolean)).toHaveLength(1);
    const replacement = contenders.find((claim) => claim !== null)!;
    expect(replacement.leaseToken).not.toBe(abandoned.leaseToken);

    expect(await first.markDrained(acceptanceId, abandoned.leaseToken)).toBe(
      false,
    );
    expect(
      await first.markRetry(
        acceptanceId,
        abandoned.leaseToken,
        1,
        1200,
        "late retry",
      ),
    ).toBe(false);
    expect(
      await first.markDlq(acceptanceId, abandoned.leaseToken, "late failure"),
    ).toBe(false);
    expect(await second.getById(acceptanceId)).toMatchObject({
      status: "draining",
      leaseToken: replacement.leaseToken,
      attemptCount: 0,
    });
    expect(await second.markDrained(acceptanceId, replacement.leaseToken)).toBe(
      true,
    );
  });

  it("keeps one immutable destination row after insertion succeeds and acknowledgement fails", async () => {
    const store = createMongoOutboxStore();
    let clock = 2000;
    const options = { now: () => clock, leaseDurationMs: 100, maxRetries: 0 };
    const original = resetDurableAuditQueueForTests(
      {
        ...store,
        async markDrained() {
          throw new Error("lost acknowledgement");
        },
      },
      options,
    );
    const { acceptanceId } = await original.accept({
      action: "unlock_success",
      result: "success",
      requestId: "inserted-crash",
    });
    await expect(drainCriticalAuditOutbox(1)).rejects.toThrow(
      "lost acknowledgement",
    );
    const inserted = await AuditLog.findOne({ acceptanceId }).lean();
    expect(inserted).toBeTruthy();
    expect((await store.getById(acceptanceId))?.status).toBe("draining");

    clock += 100;
    resetDurableAuditQueueForTests(createMongoOutboxStore(), options);
    expect(await drainCriticalAuditOutbox(1)).toEqual({
      drained: 1,
      retried: 0,
      dlq: 0,
    });
    expect(await AuditLog.countDocuments({ acceptanceId })).toBe(1);
    expect(await AuditLog.findOne({ acceptanceId }).lean()).toEqual(inserted);
    expect((await store.getById(acceptanceId))?.status).toBe("drained");
  });

  it("keeps legacy logs valid and recovers a claim with missing lease fields", async () => {
    await AuditLog.create({
      action: "unlock_success",
      result: "success",
      requestId: "legacy-1",
    });
    await AuditLog.create({
      action: "unlock_success",
      result: "success",
      requestId: "legacy-2",
    });
    const store = createMongoOutboxStore();
    const queue = resetDurableAuditQueueForTests(store);
    const { acceptanceId } = await queue.accept({
      action: "unlock_success",
      result: "success",
      requestId: "legacy-claim",
    });
    await AuditOutbox.updateOne(
      { acceptanceId },
      {
        $set: { status: "draining" },
        $unset: { leaseToken: "", leaseExpiresAt: "" },
      },
    );

    expect(await drainCriticalAuditOutbox(1)).toEqual({
      drained: 1,
      retried: 0,
      dlq: 0,
    });
    expect(
      await AuditLog.countDocuments({ acceptanceId: { $exists: false } }),
    ).toBe(2);
    expect(await AuditLog.countDocuments({ acceptanceId })).toBe(1);
  });
});
