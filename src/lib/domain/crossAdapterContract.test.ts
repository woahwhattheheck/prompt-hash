/**
 * Cross-adapter contract fixtures (#184).
 */

import { createHmac } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
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
  const purchases = new Map<
    string,
    { versionIndex: number; createdAt: Date }
  >();
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
  versions.set("p1:1", {
    versionIndex: 1,
    content: "v1-body",
    changeNote: "n1",
  });
  versions.set("p1:2", {
    versionIndex: 2,
    content: "v2-body",
    changeNote: "n2",
  });
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

function callWebhookContract(
  adapter: "domain" | "HTTP dispatcher",
  deps: WebhookDomainDeps,
  input: Parameters<typeof handleWebhookHttp>[1],
) {
  if (adapter === "HTTP dispatcher") return handleWebhookHttp(deps, input);
  switch (input.method) {
    case "GET":
      return getWebhookSubscription(deps, input);
    case "POST":
      return registerWebhookSubscription(deps, input);
    case "DELETE":
      return deleteWebhookSubscription(deps, input);
    default:
      throw new Error("Unsupported contract fixture method");
  }
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

  it.each([
    ["domain", "uppercase"],
    ["domain", "lowercase"],
    ["HTTP dispatcher", "uppercase"],
    ["HTTP dispatcher", "lowercase"],
  ] as const)(
    "%s accepts a real signed owner with %s address input",
    async (adapter, casing) => {
      const owner = Keypair.random();
      const publicKey = owner.publicKey();
      const normalized = publicKey.toLowerCase();
      const timestamp = Date.now();
      const message = "prompt-hash webhooks:" + normalized + ":" + timestamp;
      const signedMessage = owner
        .sign(Buffer.from(message, "utf8"))
        .toString("base64");
      const fields = {
        walletAddress: casing === "uppercase" ? publicKey : normalized,
        timestamp,
        signedMessage,
      };
      const deps = makeWebhookDeps({ adminToken: "" });

      const registered = await callWebhookContract(adapter, deps, {
        method: "POST",
        body: { ...fields, url: "https://example.com/hook" },
      });
      expect(registered.status).toBe(201);
      expect(registered.body).toMatchObject({ secret: "secret-fixed" });
      expect((await deps.findByWallet(normalized))?.walletAddress).toBe(
        normalized,
      );

      const got = await callWebhookContract(adapter, deps, {
        method: "GET",
        query: fields,
      });
      expect(got.status).toBe(200);
      expect(got.body).toMatchObject({ walletAddress: normalized });
      expect(got.body).not.toHaveProperty("secret");

      const deleted = await callWebhookContract(adapter, deps, {
        method: "DELETE",
        body: fields,
      });
      expect(deleted.status).toBe(200);
      expect(await deps.findByWallet(normalized)).toBeNull();
    },
  );

  it.each(["domain", "HTTP dispatcher"] as const)(
    "%s rejects wrong-key, tampered, missing and malformed owner proofs",
    async (adapter) => {
      const owner = Keypair.random();
      const otherOwner = Keypair.random();
      const walletAddress = owner.publicKey();
      const timestamp = Date.now();
      const message =
        "prompt-hash webhooks:" + walletAddress.toLowerCase() + ":" + timestamp;
      const fields = {
        walletAddress,
        timestamp,
        signedMessage: owner
          .sign(Buffer.from(message, "utf8"))
          .toString("base64"),
      };
      const invalidProofs = [
        {
          ...fields,
          signedMessage: otherOwner
            .sign(Buffer.from(message, "utf8"))
            .toString("base64"),
        },
        { ...fields, timestamp: timestamp + 1 },
        { ...fields, signedMessage: "" },
        { ...fields, walletAddress: "not-a-stellar-key" },
      ];
      const deps = makeWebhookDeps({ adminToken: "" });
      const find = vi.spyOn(deps, "findByWallet");
      const findPublic = vi.spyOn(deps, "findByWalletPublic");
      const create = vi.spyOn(deps, "createSubscription");
      const remove = vi.spyOn(deps, "deleteByWallet");

      for (const proof of invalidProofs) {
        for (const method of ["GET", "POST", "DELETE"] as const) {
          const result = await callWebhookContract(adapter, deps, {
            method,
            query: proof,
            body: { ...proof, url: "https://example.com/hook" },
          });
          expect(result.status).toBe(401);
          expect(result.body).toEqual({
            error: "Unauthorized: signed ownership proof required.",
          });
        }
      }

      expect(find).not.toHaveBeenCalled();
      expect(findPublic).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );

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
    vi.spyOn(adapterAuth, "validateSignedWebhookOwner").mockReturnValue(
      "gowner",
    );
    vi.spyOn(adapterAuth, "isAdminRequest").mockReturnValue(false);
    vi.spyOn(adapterAuth, "mergeAuthFields").mockImplementation(
      (body, query) => ({
        walletAddress: body?.walletAddress ?? query?.walletAddress,
        signedMessage: body?.signedMessage ?? query?.signedMessage,
        timestamp: body?.timestamp ?? query?.timestamp,
      }),
    );

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

  it.each([
    { adapter: "domain", register: registerWebhookSubscription },
    {
      adapter: "HTTP dispatcher",
      register: (
        deps: WebhookDomainDeps,
        input: Parameters<typeof registerWebhookSubscription>[1],
      ) => handleWebhookHttp(deps, { ...input, method: "POST" }),
    },
  ])(
    "$adapter persists the signing secret returned when updating",
    async ({ register }) => {
      const deps = makeWebhookDeps({
        adminToken: "synthetic-admin-token",
        generateSecret: vi
          .fn()
          .mockReturnValueOnce("secret-first")
          .mockReturnValueOnce("secret-rotated"),
      });
      const headers = { authorization: "Bearer synthetic-admin-token" };
      const registered = await register(deps, {
        headers,
        body: { walletAddress: "gowner", url: "https://example.com/old" },
      });
      expect(registered.status).toBe(201);
      expect(registered.body).toMatchObject({ secret: "secret-first" });

      const existing = await deps.findByWallet("gowner");
      if (!existing)
        throw new Error("Registration did not persist the subscription");
      let persistedSecret = "";
      existing.save = vi.fn(async () => {
        persistedSecret = existing.secret ?? "";
      });

      const updated = await register(deps, {
        headers,
        body: { walletAddress: "gowner", url: "https://example.com/new" },
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ secret: "secret-rotated" });
      expect(existing.save).toHaveBeenCalledOnce();

      const payload = JSON.stringify({ event: "PromptPurchased", data: {} });
      const responseSecret = (updated.body as { secret: string }).secret;
      const deliverySignature = createHmac("sha256", persistedSecret)
        .update(payload)
        .digest("hex");
      expect(
        createHmac("sha256", responseSecret).update(payload).digest("hex"),
      ).toBe(deliverySignature);

      const publicSubscription = await getWebhookSubscription(deps, {
        headers,
        query: { walletAddress: "gowner" },
      });
      expect(publicSubscription.status).toBe(200);
      expect(publicSubscription.body).not.toHaveProperty("secret");
    },
  );

  it("blocks invalid destination URLs", async () => {
    vi.spyOn(adapterAuth, "validateSignedWebhookOwner").mockReturnValue(
      "gowner",
    );
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
    vi.spyOn(adapterAuth, "validateSignedWebhookOwner").mockReturnValue(
      "gowner",
    );
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
