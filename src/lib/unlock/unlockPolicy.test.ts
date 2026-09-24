// @vitest-environment node

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
