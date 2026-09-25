/**
 * Cross-adapter contract fixtures (#184).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBuyerVersion,
  handlePromptVersionHttp,
  publishPromptVersionForOwner,
  recordPromptPurchase,
  type PromptVersioningDeps,
} from "./promptVersioningDomain";
import {
  deleteWebhookSubscription,
  getWebhookSubscription,
  handleWebhookHttp,
  registerWebhookSubscription,
  type WebhookDomainDeps,
} from "./webhookDomain";
import * as adapterAuth from "./adapterAuth";

function makeVersionDeps(
  overrides: Partial<PromptVersioningDeps> = {},
): PromptVersioningDeps {
  const purchases = new Map<string, { versionIndex: number; createdAt: Date }>();
  const versions = new Map<
    string,
    { versionIndex: number; content: string; changeNote: string }
  >();
  const prompts = new Map<
    string,
    { _id: string; content: string; currentVersionIndex: number; owner: string }
  >();
  const users = new Map<string, { _id: string; walletAddress: string }>();

  users.set("gcreator", { _id: "u1", walletAddress: "gcreator" });
  prompts.set("p1", {
    _id: "p1",
    content: "v1-body",
    currentVersionIndex: 2,
    owner: "u1",
  });
  versions.set("p1:1", { versionIndex: 1, content: "v1-body", changeNote: "n1" });
  versions.set("p1:2", { versionIndex: 2, content: "v2-body", changeNote: "n2" });
  purchases.set("p1:gbuyer", {
    versionIndex: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });

  const base: PromptVersioningDeps = {
    findPurchase: async (promptId, buyerWallet) =>
      purchases.get(`${promptId}:${buyerWallet}`) ?? null,
    findVersion: async (promptId, versionIndex) =>
      versions.get(`${promptId}:${versionIndex}`) ?? null,
    findPromptById: async (promptId) => prompts.get(promptId) ?? null,
    findUserByWallet: async (wallet) => users.get(wallet) ?? null,
    findOwnedPrompt: async (promptId, ownerId) => {
      const p = prompts.get(promptId);
      if (!p || p.owner !== ownerId) return null;
      return p;
    },
    publishVersion: async ({ promptId, content, changeNote }) => {
      const p = prompts.get(promptId)!;
      const versionIndex = (p.currentVersionIndex ?? 0) + 1;
      p.currentVersionIndex = versionIndex;
      versions.set(`${promptId}:${versionIndex}`, {
        versionIndex,
        content,
        changeNote: changeNote ?? "",
      });
      return { versionIndex };
    },
    listVersionHistory: async (promptId) =>
      [...versions.entries()]
        .filter(([k]) => k.startsWith(`${promptId}:`))
        .map(([, v]) => ({
          versionIndex: v.versionIndex,
          changeNote: v.changeNote,
        }))
        .sort((a, b) => b.versionIndex - a.versionIndex),
    recordPurchase: async ({ promptId, buyerWallet, versionIndex }) => {
      const key = `${promptId}:${buyerWallet}`;
      const existing = purchases.get(key);
      if (existing) {
        return {
          purchase: {
            versionIndex: existing.versionIndex,
            createdAt: existing.createdAt,
            updatedAt: existing.createdAt,
          },
          created: false,
        };
      }
      const createdAt = new Date();
      const purchase = { versionIndex, createdAt, updatedAt: createdAt };
      purchases.set(key, purchase);
      return { purchase, created: true };
    },
  };
  return { ...base, ...overrides };
}

function makeWebhookDeps(
  overrides: Partial<WebhookDomainDeps> = {},
): WebhookDomainDeps {
  const subs = new Map<string, any>();
  const base: WebhookDomainDeps = {
    allowedEvents: ["PromptPurchased", "PromptCreated"],
    validateDestinationUrl: async () => ({ valid: true }),
    findByWallet: async (wallet) => subs.get(wallet) ?? null,
    findByWalletPublic: async (wallet) => {
      const sub = subs.get(wallet);
      if (!sub) return null;
      const { secret: _s, ...rest } = sub;
      return rest;
    },
    createSubscription: async (data) => {
      const sub = {
        _id: "sub1",
        ...data,
        active: true,
        failureCount: 0,
        save: async () => undefined,
      };
      subs.set(data.walletAddress, sub);
      return sub;
    },
    deleteByWallet: async (wallet) => {
      subs.delete(wallet);
    },
    generateSecret: () => "secret-fixed",
  };
  return { ...base, ...overrides };
}

describe("prompt versioning contract", () => {
  it("requires purchase entitlement (no silent v1 fallback)", async () => {
    const result = await getBuyerVersion(makeVersionDeps(), {
      promptId: "p1",
      buyerWallet: "gstranger",
    });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "No purchase record found." });
  });

  it("returns entitled version content", async () => {
    const result = await getBuyerVersion(makeVersionDeps(), {
      promptId: "p1",
      buyerWallet: "gbuyer",
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      versionIndex: 2,
      content: "v2-body",
      changeNote: "n2",
    });
  });

  it("rejects publish for unknown user", async () => {
    const result = await publishPromptVersionForOwner(makeVersionDeps(), {
      promptId: "p1",
      walletAddress: "gother",
      content: "x",
    });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "User not found." });
  });

  it("publishes for owner", async () => {
    const result = await publishPromptVersionForOwner(makeVersionDeps(), {
      promptId: "p1",
      walletAddress: "gcreator",
      content: "v3",
      changeNote: "bump",
    });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      versionIndex: 3,
      message: "Version posted.",
    });
  });

  it("records purchase idempotently", async () => {
    const deps = makeVersionDeps();
    const first = await recordPromptPurchase(deps, {
      promptId: "p1",
      buyerWallet: "gnew",
      txHash: "tx1",
    });
    const second = await recordPromptPurchase(deps, {
      promptId: "p1",
      buyerWallet: "gnew",
      txHash: "tx1",
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(first.body).toMatchObject({
      message: "Purchase recorded.",
      versionIndex: 2,
    });
    expect(second.body).toMatchObject({
      message: "Already purchased.",
      versionIndex: 2,
    });
  });

  it("GET/POST http dispatcher shares the same contract", async () => {
    const deps = makeVersionDeps();
    const getResult = await handlePromptVersionHttp(deps, {
      method: "GET",
      query: { promptId: "p1", buyerWallet: "gbuyer" },
    });
    const postResult = await handlePromptVersionHttp(deps, {
      method: "POST",
      body: {
        promptId: "p1",
        walletAddress: "gcreator",
        content: "v3",
      },
    });
    expect(getResult.status).toBe(200);
    expect(postResult.status).toBe(201);
  });

  it("auth/error parity: missing params → identical 400", async () => {
    const deps = makeVersionDeps();
    const a = await getBuyerVersion(deps, { promptId: "", buyerWallet: "" });
    const b = await handlePromptVersionHttp(deps, {
      method: "GET",
      query: {},
    });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(a.body).toEqual(b.body);
    expect(a.body).toEqual({ error: "promptId and buyerWallet are required." });
  });
});

describe("webhook contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects register without signed owner", async () => {
    vi.spyOn(adapterAuth, "validateSignedWebhookOwner").mockReturnValue(null);
    vi.spyOn(adapterAuth, "isAdminRequest").mockReturnValue(false);
    const result = await registerWebhookSubscription(makeWebhookDeps(), {
      body: { url: "https://example.com/hook" },
    });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({
      error: "Unauthorized: signed ownership proof required.",
    });
  });

  it("registers and gets with signed owner (parity)", async () => {
    vi.spyOn(adapterAuth, "validateSignedWebhookOwner").mockReturnValue("gowner");
    vi.spyOn(adapterAuth, "isAdminRequest").mockReturnValue(false);
    vi.spyOn(adapterAuth, "mergeAuthFields").mockImplementation((body, query) => ({
      walletAddress: body?.walletAddress ?? query?.walletAddress,
      signedMessage: body?.signedMessage ?? query?.signedMessage,
      timestamp: body?.timestamp ?? query?.timestamp,
    }));

    const deps = makeWebhookDeps();
    const registered = await registerWebhookSubscription(deps, {
      body: {
        url: "https://example.com/hook",
        walletAddress: "gowner",
        signedMessage: "sig",
        timestamp: 1,
        events: ["PromptPurchased", "Nope"],
      },
    });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({
      message: "Webhook registered.",
      secret: "secret-fixed",
    });

    const got = await getWebhookSubscription(deps, {
      query: { walletAddress: "gowner", signedMessage: "sig", timestamp: 1 },
    });
    expect(got.status).toBe(200);

    const viaHttp = await handleWebhookHttp(deps, {
      method: "GET",
      query: { walletAddress: "gowner", signedMessage: "sig", timestamp: 1 },
    });
    expect(viaHttp.status).toBe(got.status);
    expect(viaHttp.body).toEqual(got.body);
  });

  it("blocks invalid destination URLs", async () => {
    vi.spyOn(adapterAuth, "validateSignedWebhookOwner").mockReturnValue("gowner");
    vi.spyOn(adapterAuth, "isAdminRequest").mockReturnValue(false);
    const result = await registerWebhookSubscription(
      makeWebhookDeps({
        validateDestinationUrl: async () => ({ valid: false }),
      }),
      {
        body: {
          url: "http://127.0.0.1/hook",
          walletAddress: "gowner",
          signedMessage: "sig",
          timestamp: 1,
        },
      },
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: "Invalid or blocked webhook destination URL.",
    });
  });

  it("deletes with signed owner", async () => {
    vi.spyOn(adapterAuth, "validateSignedWebhookOwner").mockReturnValue("gowner");
    vi.spyOn(adapterAuth, "isAdminRequest").mockReturnValue(false);
    const deps = makeWebhookDeps();
    await registerWebhookSubscription(deps, {
      body: {
        url: "https://example.com/hook",
        walletAddress: "gowner",
        signedMessage: "sig",
        timestamp: 1,
      },
    });
    const deleted = await deleteWebhookSubscription(deps, {
      body: { walletAddress: "gowner", signedMessage: "sig", timestamp: 1 },
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ message: "Webhook removed." });
  });
});
