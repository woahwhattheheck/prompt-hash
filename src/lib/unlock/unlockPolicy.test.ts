// @vitest-environment node

import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DENY_MESSAGES,
  DEFAULT_POLICY_CACHE_TTL_MS,
  POLICY_UNAVAILABLE_MESSAGE,
  UnlockPolicyCache,
  evaluateUnlockFulfillmentPolicy,
  signPolicySnapshot,
  verifyPolicySnapshot,
  type FindFulfillment,
  type PolicySnapshotPayload,
} from "./unlockPolicy";

const SECRET = "test-unlock-policy-secret";
const PROMPT_ID = "42";
const BUYER = "GBUYERWALLETADDRESSEXAMPLE000000000000000000000000000";

describe("unlock fulfillment policy fail-closed (#166)", () => {
  let cache: UnlockPolicyCache;
  const now = 1_700_000_000_000;

  beforeEach(() => {
    cache = new UnlockPolicyCache();
  });

  afterEach(() => {
    cache.clear();
    vi.useRealTimers();
  });

  function finder(impl: FindFulfillment): FindFulfillment {
    return impl;
  }

  it("allows when no fulfillment record exists", async () => {
    const decision = await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => null),
      signingSecret: SECRET,
      cache,
      now,
    });
    expect(decision).toEqual({
      outcome: "allow",
      status: null,
      source: "live",
    });
  });

  it("denies open dispute (refund_requested)", async () => {
    const decision = await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => ({ status: "refund_requested" })),
      signingSecret: SECRET,
      cache,
      now,
    });
    expect(decision.outcome).toBe("deny");
    if (decision.outcome === "deny") {
      expect(decision.reason).toBe("refund_requested");
      expect(decision.message).toBe(DENY_MESSAGES.refund_requested);
      expect(decision.source).toBe("live");
    }
  });

  it("denies refunded buyers", async () => {
    const decision = await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => ({ status: "refunded" })),
      signingSecret: SECRET,
      cache,
      now,
    });
    expect(decision.outcome).toBe("deny");
    if (decision.outcome === "deny") {
      expect(decision.reason).toBe("refunded");
      expect(decision.message).toBe(DENY_MESSAGES.refunded);
    }
  });

  it("fails closed on connection error without leaking internals", async () => {
    const decision = await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => {
        throw new Error("MongoServerError: connection refused ECONNREFUSED");
      }),
      signingSecret: SECRET,
      cache,
      now,
    });
    expect(decision.outcome).toBe("unavailable");
    if (decision.outcome === "unavailable") {
      expect(decision.message).toBe(POLICY_UNAVAILABLE_MESSAGE);
      expect(decision.message).not.toMatch(/mongo|ECONNREFUSED|fulfillment/i);
      expect(decision.cause).toMatch(/ECONNREFUSED/);
    }
  });

  it("fails closed on DB timeout", async () => {
    const decision = await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      ),
      signingSecret: SECRET,
      cache,
      now,
      lookupTimeoutMs: 25,
    });
    expect(decision.outcome).toBe("unavailable");
    if (decision.outcome === "unavailable") {
      expect(decision.message).toBe(POLICY_UNAVAILABLE_MESSAGE);
      expect(decision.cause).toMatch(/timed out/i);
    }
  });

  it("rejects stale cache and fails closed when live lookup fails", async () => {
    // Seed a successful allow evaluation.
    await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => ({ status: "delivered" })),
      signingSecret: SECRET,
      cache,
      now,
      ttlMs: DEFAULT_POLICY_CACHE_TTL_MS,
    });

    const staleNow = now + DEFAULT_POLICY_CACHE_TTL_MS + 1;
    const decision = await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => {
        throw new Error("MongoNetworkTimeoutError");
      }),
      signingSecret: SECRET,
      cache,
      now: staleNow,
      ttlMs: DEFAULT_POLICY_CACHE_TTL_MS,
    });
    expect(decision.outcome).toBe("unavailable");
    if (decision.outcome === "unavailable") {
      expect(decision.message).toBe(POLICY_UNAVAILABLE_MESSAGE);
    }
  });

  it("uses fresh signed cache during outage (recovery bridge)", async () => {
    await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => null),
      signingSecret: SECRET,
      cache,
      now,
    });

    const decision = await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => {
        throw new Error("MongoNetworkError: disconnected");
      }),
      signingSecret: SECRET,
      cache,
      now: now + 5_000,
      ttlMs: DEFAULT_POLICY_CACHE_TTL_MS,
    });
    expect(decision).toEqual({
      outcome: "allow",
      status: null,
      source: "cache",
    });
  });

  it.each(["timeout", "connection error"])(
    "rejects a snapshot that expires while waiting for a DB %s",
    async (failure) => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const options = {
        promptId: PROMPT_ID,
        buyerWallet: BUYER,
        signingSecret: SECRET,
        cache,
      };
      await evaluateUnlockFulfillmentPolicy({
        ...options,
        findFulfillment: finder(async () => ({ status: "delivered" })),
      });

      vi.setSystemTime(now + DEFAULT_POLICY_CACHE_TTL_MS - 1);
      const pending = evaluateUnlockFulfillmentPolicy({
        ...options,
        findFulfillment: finder(
          () =>
            new Promise((_resolve, reject) => {
              if (failure === "connection error") {
                setTimeout(() => reject(new Error("connection lost")), 25);
              }
            }),
        ),
        lookupTimeoutMs: failure === "timeout" ? 25 : 100,
      });
      await vi.advanceTimersByTimeAsync(25);

      expect(await pending).toMatchObject({
        outcome: "unavailable",
        message: POLICY_UNAVAILABLE_MESSAGE,
      });
    },
  );

  it("allows a snapshot that remains fresh after the DB wait", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const options = {
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      signingSecret: SECRET,
      cache,
    };
    await evaluateUnlockFulfillmentPolicy({
      ...options,
      findFulfillment: finder(async () => ({ status: "delivered" })),
    });

    vi.setSystemTime(now + DEFAULT_POLICY_CACHE_TTL_MS - 100);
    const pending = evaluateUnlockFulfillmentPolicy({
      ...options,
      findFulfillment: finder(() => new Promise(() => {})),
      lookupTimeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(await pending).toEqual({
      outcome: "allow",
      status: "delivered",
      source: "cache",
    });
  });

  it("recovers to live deny after outage when Mongo returns refunded", async () => {
    // Prior allow cached.
    await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => ({ status: "delivered" })),
      signingSecret: SECRET,
      cache,
      now,
    });

    const decision = await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => ({ status: "refunded" })),
      signingSecret: SECRET,
      cache,
      now: now + 1_000,
    });
    expect(decision.outcome).toBe("deny");
    if (decision.outcome === "deny") {
      expect(decision.reason).toBe("refunded");
      expect(decision.source).toBe("live");
    }
  });

  it.each([
    { older: "delivered", newer: "refunded", startOffset: 1 },
    { older: "delivered", newer: "refund_requested", startOffset: 1 },
    { older: "refunded", newer: "delivered", startOffset: 1 },
    { older: "delivered", newer: "refunded", startOffset: 0 },
    { older: "delivered", newer: "refund_requested", startOffset: 0 },
    { older: "refunded", newer: "delivered", startOffset: 0 },
  ])(
    "retains newer $newer after older $older completes (start offset $startOffset ms)",
    async ({ older, newer, startOffset }) => {
      const options = {
        promptId: PROMPT_ID,
        buyerWallet: BUYER,
        signingSecret: SECRET,
        cache,
      };
      let releaseOlder!: () => void;
      const pendingOlder = evaluateUnlockFulfillmentPolicy({
        ...options,
        now,
        findFulfillment: () =>
          new Promise((resolve) => {
            releaseOlder = () => resolve({ status: older });
          }),
      });

      await evaluateUnlockFulfillmentPolicy({
        ...options,
        buyerWallet: BUYER.toLowerCase(),
        now: now + startOffset,
        findFulfillment: async () => ({ status: newer }),
      });
      const newerToken = cache.get(PROMPT_ID, BUYER);
      expect(verifyPolicySnapshot(newerToken!, SECRET)).toMatchObject({
        status: newer,
        evaluatedAt: now + startOffset,
      });

      releaseOlder();
      expect(await pendingOlder).toMatchObject({
        status: older,
        source: "live",
      });
      expect(cache.get(PROMPT_ID, BUYER)).toBe(newerToken);

      const fallback = await evaluateUnlockFulfillmentPolicy({
        ...options,
        now: now + 2,
        findFulfillment: async () => {
          throw new Error("connection lost");
        },
      });
      expect(fallback).toMatchObject({
        outcome: newer === "delivered" ? "allow" : "deny",
        status: newer,
        source: "cache",
      });
    },
  );

  it.each(["before", "after"])(
    "keeps a successful lookup when a newer lookup fails %s it completes",
    async (failureOrder) => {
      const options = {
        promptId: PROMPT_ID,
        buyerWallet: BUYER,
        signingSecret: SECRET,
        cache,
      };
      let releaseOlder!: () => void;
      let rejectNewer!: () => void;
      const pendingOlder = evaluateUnlockFulfillmentPolicy({
        ...options,
        now,
        findFulfillment: () =>
          new Promise((resolve) => {
            releaseOlder = () => resolve({ status: "refunded" });
          }),
      });
      const pendingNewer = evaluateUnlockFulfillmentPolicy({
        ...options,
        now: now + 1,
        findFulfillment: () =>
          new Promise((_resolve, reject) => {
            rejectNewer = () => reject(new Error("connection lost"));
          }),
      });

      if (failureOrder === "before") {
        rejectNewer();
        expect((await pendingNewer).outcome).toBe("unavailable");
        releaseOlder();
        await pendingOlder;
      } else {
        releaseOlder();
        await pendingOlder;
        rejectNewer();
        expect(await pendingNewer).toMatchObject({
          outcome: "deny",
          status: "refunded",
          source: "cache",
        });
      }
      expect(
        verifyPolicySnapshot(cache.get(PROMPT_ID, BUYER)!, SECRET),
      ).toMatchObject({ status: "refunded", evaluatedAt: now });

      const fallback = await evaluateUnlockFulfillmentPolicy({
        ...options,
        now: now + 2,
        findFulfillment: async () => {
          throw new Error("still disconnected");
        },
      });
      expect(fallback).toMatchObject({
        outcome: "deny",
        status: "refunded",
        source: "cache",
      });
    },
  );

  it("orders overlapping lookups independently for each prompt and buyer", async () => {
    const options = {
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      signingSecret: SECRET,
      cache,
      now,
    };
    let releaseOlder!: () => void;
    const pendingOlder = evaluateUnlockFulfillmentPolicy({
      ...options,
      findFulfillment: () =>
        new Promise((resolve) => {
          releaseOlder = () => resolve({ status: "refunded" });
        }),
    });
    await evaluateUnlockFulfillmentPolicy({
      ...options,
      buyerWallet: "GOTHERBUYER",
      findFulfillment: async () => ({ status: "delivered" }),
    });
    releaseOlder();
    await pendingOlder;
    expect(
      verifyPolicySnapshot(cache.get(PROMPT_ID, BUYER)!, SECRET),
    ).toMatchObject({ status: "refunded" });
    expect(
      verifyPolicySnapshot(cache.get(PROMPT_ID, "GOTHERBUYER")!, SECRET),
    ).toMatchObject({ status: "delivered" });
  });

  it.each(["clear", "delete", "set"] as const)(
    "does not overwrite an explicit cache %s with an already-pending lookup",
    async (mutation) => {
      const options = {
        promptId: PROMPT_ID,
        buyerWallet: BUYER,
        signingSecret: SECRET,
        cache,
      };
      let releaseOlder!: () => void;
      const pendingOlder = evaluateUnlockFulfillmentPolicy({
        ...options,
        now,
        findFulfillment: () =>
          new Promise((resolve) => {
            releaseOlder = () => resolve({ status: "delivered" });
          }),
      });
      const replacement = signPolicySnapshot(
        {
          promptId: PROMPT_ID,
          buyerWallet: BUYER,
          decision: "deny",
          status: "refunded",
          denyReason: "refunded",
          evaluatedAt: now + 1,
        },
        SECRET,
      );
      if (mutation === "clear") cache.clear();
      else if (mutation === "delete") cache.delete(PROMPT_ID, BUYER);
      else cache.set(PROMPT_ID, BUYER, replacement);

      releaseOlder();
      await pendingOlder;
      expect(cache.get(PROMPT_ID, BUYER)).toBe(
        mutation === "set" ? replacement : undefined,
      );
      const fallback = await evaluateUnlockFulfillmentPolicy({
        ...options,
        now: now + 2,
        findFulfillment: async () => {
          throw new Error("connection lost");
        },
      });
      expect(fallback.outcome).toBe(
        mutation === "set" ? "deny" : "unavailable",
      );

      await evaluateUnlockFulfillmentPolicy({
        ...options,
        now: now + 3,
        findFulfillment: async () => ({ status: "delivered" }),
      });
      expect(
        verifyPolicySnapshot(cache.get(PROMPT_ID, BUYER)!, SECRET),
      ).toMatchObject({ status: "delivered", evaluatedAt: now + 3 });
    },
  );

  it.each([
    { label: "omitted", reason: undefined },
    { label: "null", reason: null },
    { label: "empty", reason: "" },
    { label: "unsupported", reason: "delivered" },
    { label: "object", reason: { reason: "refunded" } },
    { label: "array", reason: ["refunded"] },
  ])(
    "rejects malformed signed denial snapshots with $label reason",
    async ({ reason }) => {
      const payload: PolicySnapshotPayload = {
        promptId: PROMPT_ID,
        buyerWallet: BUYER,
        decision: "deny",
        status: "refunded",
        evaluatedAt: now,
      };
      if (reason !== undefined) {
        payload.denyReason = reason as PolicySnapshotPayload["denyReason"];
      }
      const token = signPolicySnapshot(payload, SECRET);
      cache.set(PROMPT_ID, BUYER, token);

      const decision = await evaluateUnlockFulfillmentPolicy({
        promptId: PROMPT_ID,
        buyerWallet: BUYER,
        findFulfillment: async () => {
          throw new Error("connection error");
        },
        signingSecret: SECRET,
        cache,
        now: now + 1_000,
      });

      expect(decision).toEqual({
        outcome: "unavailable",
        message: POLICY_UNAVAILABLE_MESSAGE,
        cause: "connection error",
      });
      expect(verifyPolicySnapshot(token, SECRET)).toBeNull();
      expect(cache.get(PROMPT_ID, BUYER)).toBeUndefined();
    },
  );

  it.each(["refund_requested", "refunded"] as const)(
    "preserves a valid signed %s denial during an outage",
    async (reason) => {
      const payload: PolicySnapshotPayload = {
        promptId: PROMPT_ID,
        buyerWallet: BUYER,
        decision: "deny",
        status: reason,
        denyReason: reason,
        evaluatedAt: now,
      };
      const token = signPolicySnapshot(payload, SECRET);
      cache.set(PROMPT_ID, BUYER, token);

      const decision = await evaluateUnlockFulfillmentPolicy({
        promptId: PROMPT_ID,
        buyerWallet: BUYER,
        findFulfillment: async () => {
          throw new Error("connection error");
        },
        signingSecret: SECRET,
        cache,
        now: now + 1_000,
      });

      expect(decision).toEqual({
        outcome: "deny",
        reason,
        message: DENY_MESSAGES[reason],
        status: reason,
        source: "cache",
      });
      expect(verifyPolicySnapshot(token, SECRET)).toMatchObject({
        ...payload,
        buyerWallet: BUYER.toLowerCase(),
      });
      expect(cache.get(PROMPT_ID, BUYER)).toBe(token);
    },
  );


  it.each(["delivered", "refunded"])(
    "discards a future-dated %s snapshot after clock rollback",
    async (status) => {
      const options = {
        promptId: PROMPT_ID,
        buyerWallet: BUYER,
        signingSecret: SECRET,
        cache,
      };
      await evaluateUnlockFulfillmentPolicy({
        ...options,
        now: now + 60_000,
        findFulfillment: async () => ({ status }),
      });
      const unavailable = async () => {
        throw new Error("connection error");
      };

      expect(
        await evaluateUnlockFulfillmentPolicy({
          ...options,
          now,
          findFulfillment: unavailable,
        }),
      ).toMatchObject({
        outcome: "unavailable",
        message: POLICY_UNAVAILABLE_MESSAGE,
      });
      expect(cache.get(PROMPT_ID, BUYER)).toBeUndefined();

      // Catching up must not revive the discarded snapshot during the outage.
      expect(
        (
          await evaluateUnlockFulfillmentPolicy({
            ...options,
            now: now + 60_001,
            findFulfillment: unavailable,
          })
        ).outcome,
      ).toBe("unavailable");
    },
  );

  it.each(["1e309", "-1e309"])(
    "rejects a correctly signed snapshot with nonfinite timestamp %s",
    async (timestamp) => {
      const body = JSON.stringify({
        promptId: PROMPT_ID,
        buyerWallet: BUYER.toLowerCase(),
        decision: "allow",
        status: "delivered",
        evaluatedAt: 0,
      }).replace('"evaluatedAt":0', `"evaluatedAt":${timestamp}`);
      const signature = createHmac("sha256", SECRET)
        .update(body)
        .digest("base64url");
      const token = `${Buffer.from(body).toString("base64url")}.${signature}`;
      cache.set(PROMPT_ID, BUYER, token);

      expect(verifyPolicySnapshot(token, SECRET)).toBeNull();
      expect(
        (
          await evaluateUnlockFulfillmentPolicy({
            promptId: PROMPT_ID,
            buyerWallet: BUYER,
            signingSecret: SECRET,
            cache,
            now,
            findFulfillment: async () => {
              throw new Error("connection error");
            },
          })
        ).outcome,
      ).toBe("unavailable");
      expect(cache.get(PROMPT_ID, BUYER)).toBeUndefined();
    },
  );

  it.each([
    { age: 0, outcome: "allow" },
    { age: DEFAULT_POLICY_CACHE_TTL_MS, outcome: "allow" },
    { age: DEFAULT_POLICY_CACHE_TTL_MS + 1, outcome: "unavailable" },
  ])(
    "preserves the freshness boundary at age $age ms",
    async ({ age, outcome }) => {
      const options = {
        promptId: PROMPT_ID,
        buyerWallet: BUYER,
        signingSecret: SECRET,
        cache,
      };
      await evaluateUnlockFulfillmentPolicy({
        ...options,
        now,
        findFulfillment: async () => ({ status: "delivered" }),
      });
      expect(
        (
          await evaluateUnlockFulfillmentPolicy({
            ...options,
            now: now + age,
            findFulfillment: async () => {
              throw new Error("connection error");
            },
          })
        ).outcome,
      ).toBe(outcome);
    },
  );

  it("rejects tampered cache signatures", () => {
    const payload: PolicySnapshotPayload = {
      promptId: PROMPT_ID,
      buyerWallet: BUYER.toLowerCase(),
      decision: "allow",
      status: null,
      evaluatedAt: now,
    };
    const token = signPolicySnapshot(payload, SECRET);
    const [body, sig] = token.split(".");
    const tampered = `${body}.${sig.slice(0, -2)}aa`;
    expect(verifyPolicySnapshot(tampered, SECRET)).toBeNull();
    expect(verifyPolicySnapshot(token, "wrong-secret")).toBeNull();
    expect(verifyPolicySnapshot(token, SECRET)).toMatchObject(payload);
  });

  it("does not honor deny→allow via unsigned store mutation", async () => {
    await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => ({ status: "refunded" })),
      signingSecret: SECRET,
      cache,
      now,
    });
    // Attacker writes an allow blob without a valid HMAC.
    cache.set(
      PROMPT_ID,
      BUYER,
      Buffer.from(
        JSON.stringify({
          promptId: PROMPT_ID,
          buyerWallet: BUYER.toLowerCase(),
          decision: "allow",
          status: null,
          evaluatedAt: now,
        }),
      ).toString("base64url") + ".not-a-real-signature",
    );

    const decision = await evaluateUnlockFulfillmentPolicy({
      promptId: PROMPT_ID,
      buyerWallet: BUYER,
      findFulfillment: finder(async () => {
        throw new Error("connection error");
      }),
      signingSecret: SECRET,
      cache,
      now: now + 1_000,
    });
    expect(decision.outcome).toBe("unavailable");
  });
});
