/** Session-scoped webhook ownership and persistent signing-secret rotation (#144). */
import express from "express";
import request from "supertest";

jest.mock("../auth/walletPrincipalHttp", () => ({
  requireWalletPrincipal: (req: any, res: any, next: any) => {
    const address = req.headers["x-test-wallet"];
    if (!address) return res.status(401).json({ error: "Wallet session required." });
    res.locals.walletPrincipal = { address };
    next();
  },
}));
jest.mock("../db/connectDb", () => jest.fn().mockResolvedValue(undefined));
jest.mock("../services/webhookDispatcher", () => ({
  ALLOWED_EVENTS: ["PromptPurchased"],
}));
jest.mock("../services/ssrfProtection", () => ({
  validateWebhookUrl: jest.fn().mockResolvedValue({ valid: true }),
}));
jest.mock("../models/WebhookSubscription", () => ({
  __esModule: true,
  default: Object.assign(
    jest.fn().mockImplementation((data) => ({
      ...data, _id: "created-subscription", save: jest.fn(),
    })),
    { findOne: jest.fn(), deleteOne: jest.fn() },
  ),
}));

import WebhookSubscription from "../models/WebhookSubscription";
import { validateWebhookUrl } from "../services/ssrfProtection";
import { webhookRouter } from "./webhookRoutes";

const OWNER = "GWalletOwner";
const OTHER = "GOtherWallet";
const ADMIN = "local-admin-rotation-token-longer-than-32-bytes";
const priorAdmin = process.env.ADMIN_ROTATION_TOKEN;
function app() {
  const server = express();
  server.use(express.json());
  server.use("/api/webhooks", webhookRouter);
  return server;
}
beforeEach(() => {
  jest.clearAllMocks();
  process.env.ADMIN_ROTATION_TOKEN = ADMIN;
});
afterAll(() => {
  if (priorAdmin === undefined) delete process.env.ADMIN_ROTATION_TOKEN;
  else process.env.ADMIN_ROTATION_TOKEN = priorAdmin;
});

describe("signed webhook owner vs privileged admin", () => {
  it("rejects anonymous webhook reads, creates and deletes before touching DB", async () => {
    const server = app();
    const a = await request(server).post("/api/webhooks").send({ url: "https://hooks.example.test" });
    const b = await request(server).get("/api/webhooks?walletAddress=" + OWNER);
    const c = await request(server).delete("/api/webhooks").send({ walletAddress: OWNER });
    expect([a.status, b.status, c.status]).toEqual([401,401,401]);
    expect(WebhookSubscription.findOne).not.toHaveBeenCalled();
    expect(WebhookSubscription.deleteOne).not.toHaveBeenCalled();
  });

  it("rejects attempts to register, read or delete another wallet's subscription", async () => {
    const server = app();
    const a = await request(server).post("/api/webhooks").set("X-Test-Wallet", OWNER)
      .send({ walletAddress: OTHER, url: "https://hooks.example.test" });
    const b = await request(server).get("/api/webhooks?walletAddress=" + OTHER)
      .set("X-Test-Wallet", OWNER);
    const c = await request(server).delete("/api/webhooks").set("X-Test-Wallet", OWNER)
      .send({ walletAddress: OTHER });
    expect([a.status,b.status,c.status]).toEqual([403,403,403]);
    expect(WebhookSubscription.findOne).not.toHaveBeenCalled();
    expect(WebhookSubscription.deleteOne).not.toHaveBeenCalled();
  });

  it("creates a subscription with signer wallet, safe events, secret and no body identity", async () => {
    (WebhookSubscription.findOne as jest.Mock).mockResolvedValue(null);
    const result = await request(app()).post("/api/webhooks").set("X-Test-Wallet", OWNER)
      .send({ url: "https://hooks.example.test", events: ["PromptPurchased", "bad-event"] });
    expect(result.status).toBe(201);
    expect(result.body.secret).toHaveLength(64);
    expect(WebhookSubscription).toHaveBeenCalledWith(expect.objectContaining({
      walletAddress: OWNER.toLowerCase(),
      events: ["PromptPurchased"],
      secret: result.body.secret,
    }));
  });

  it("persists the exact rotated secret returned for an existing subscription", async () => {
    const existing: any = {
      _id: "old", url: "https://old.example.test", secret: "old-secret",
      active: false, failureCount: 5,
      save: jest.fn().mockResolvedValue(undefined),
    };
    (WebhookSubscription.findOne as jest.Mock).mockResolvedValue(existing);
    const result = await request(app()).post("/api/webhooks").set("X-Test-Wallet", OWNER)
      .send({ walletAddress: OWNER, url: "https://new.example.test" });
    expect(result.status).toBe(200);
    expect(result.body.secret).toHaveLength(64);
    expect(existing.secret).toBe(result.body.secret);
    expect(existing.secret).not.toBe("old-secret");
    expect(existing.active).toBe(true);
    expect(existing.save).toHaveBeenCalledTimes(1);
  });

  it("enforces SSRF URL validation without saving unsafe subscriptions", async () => {
    (validateWebhookUrl as jest.Mock).mockResolvedValue({ valid: false });
    const result = await request(app()).post("/api/webhooks").set("X-Test-Wallet", OWNER)
      .send({ url: "http://127.0.0.1/admin" });
    expect(result.status).toBe(400);
    expect(WebhookSubscription.findOne).not.toHaveBeenCalled();
  });

  it("lets a configured admin inspect other wallets without returning their secret", async () => {
    (WebhookSubscription.findOne as jest.Mock).mockReturnValue({
      select: jest.fn().mockResolvedValue({ walletAddress: OTHER.toLowerCase(), url: "https://example.test" }),
    });
    const result = await request(app()).get("/api/webhooks?walletAddress=" + OTHER)
      .set("Authorization", `Bearer ${ADMIN}`);
    expect(result.status).toBe(200);
    expect(result.body).not.toHaveProperty("secret");
    expect(WebhookSubscription.findOne).toHaveBeenCalledWith({ walletAddress: OTHER.toLowerCase() });
  });

  it("never grants admin access from wrong admin tokens or short configuration", async () => {
    const server = app();
    const forged = await request(server).delete("/api/webhooks")
      .set("Authorization", "Bearer forged-value")
      .send({ walletAddress: OTHER });
    process.env.ADMIN_ROTATION_TOKEN = "short";
    const weak = await request(server).delete("/api/webhooks")
      .set("Authorization", "Bearer short").send({ walletAddress: OTHER });
    expect([forged.status, weak.status]).toEqual([401,401]);
    expect(WebhookSubscription.deleteOne).not.toHaveBeenCalled();
  });
});
